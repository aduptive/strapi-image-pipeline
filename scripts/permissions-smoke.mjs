// Release gate: the settings routes must be closed to anonymous callers and to
// authenticated admins without this plugin's permissions, and read-only admins
// must not be able to change settings. Uses one of Strapi's default roles
// (custom roles are an Enterprise feature) and restores it afterwards.
import assert from 'node:assert/strict'
import { labHost } from './lab.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const major = Number(process.argv[2])
assert.ok([4, 5].includes(major), 'Pass 4 or 5')
const { base, credentials } = labHost(major)
const asJson = async response => ({ status: response.status, body: await response.json().catch(() => null) })
const login = async body => {
  const response = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const { status, body: payload } = await asJson(response)
  assert.equal(status, 200, `Login failed: ${status}`)
  return payload.data.token
}
const token = await login(credentials)
const admin = { Authorization: `Bearer ${token}` }
const adminJson = { ...admin, 'Content-Type': 'application/json' }
const settingsUrl = `${base}/image-pipeline/settings`
const read = headers => fetch(settingsUrl, { headers })
const write = headers => fetch(settingsUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: 71 }) })

const roles = (await fetch(`${base}/admin/roles`, { headers: admin }).then(r => r.json())).data
const editor = roles.find(role => role.code === 'strapi-editor')
assert.ok(editor, 'Expected the default Editor role')
const permissionsUrl = `${base}/admin/roles/${editor.id}/permissions`
const originalPermissions = (await fetch(permissionsUrl, { headers: admin }).then(r => r.json())).data
const setPermissions = permissions => fetch(permissionsUrl, { method: 'PUT', headers: adminJson, body: JSON.stringify({ permissions }) })
const plugin = action => ({ action: `plugin::image-pipeline.${action}`, subject: null, properties: {}, conditions: [] })
const strip = permissions => permissions
  .filter(permission => !permission.action.startsWith('plugin::image-pipeline.'))
  .map(({ action, subject = null, properties = {}, conditions = [] }) => ({ action, subject, properties, conditions }))

const created = []
const checks = []
try {
  assert.ok([401, 403].includes((await read({})).status), 'Anonymous read must be denied')
  assert.ok([401, 403].includes((await write({})).status), 'Anonymous write must be denied')
  assert.equal((await fetch(settingsUrl, { headers: { Authorization: 'Bearer not-a-token' } })).status, 401)
  checks.push('anonymous and invalid-token requests denied')

  const password = `Lab-${randomUUID().slice(0, 12)}!aA1`
  const email = `image-perms-${randomUUID().slice(0, 8)}@lab.invalid`
  const invited = await asJson(await fetch(`${base}/admin/users`, { method: 'POST', headers: adminJson,
    body: JSON.stringify({ firstname: 'Perms', lastname: 'Check', email, roles: [editor.id] }) }))
  assert.equal(invited.status, 201, `User creation: ${invited.status} ${JSON.stringify(invited.body).slice(0, 200)}`)
  created.push(invited.body.data.id)
  const registrationToken = invited.body.data.registrationToken
  assert.ok(registrationToken, 'Expected a registration token for the invited user')
  const registered = await asJson(await fetch(`${base}/admin/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationToken, userInfo: { firstname: 'Perms', lastname: 'Check', password } }) }))
  assert.equal(registered.status, 200, `Registration: ${registered.status}`)
  const restricted = { Authorization: `Bearer ${await login({ email, password })}` }

  await setPermissions(strip(originalPermissions))
  assert.equal((await read(restricted)).status, 403, 'Admin without plugin permissions must not read settings')
  assert.equal((await write(restricted)).status, 403, 'Admin without plugin permissions must not change settings')
  checks.push('authenticated admin without plugin permissions denied on read and write')

  await setPermissions([...strip(originalPermissions), plugin('read')])
  const readOnly = await asJson(await read(restricted))
  assert.equal(readOnly.status, 200, 'Read permission must allow reading settings')
  assert.equal(typeof readOnly.body.quality, 'number')
  assert.equal('hooks' in readOnly.body, false, 'Settings payload must never expose hook configuration')
  assert.equal((await write(restricted)).status, 403, 'Read permission alone must not allow writing settings')
  checks.push('read permission allows read only', 'settings payload hides hook configuration')

  await setPermissions([...strip(originalPermissions), plugin('read'), plugin('update')])
  const before = await read(admin).then(r => r.json())
  assert.equal((await write(restricted)).status, 200, 'Update permission must allow writing settings')
  const after = await read(admin).then(r => r.json())
  assert.equal(after.quality, 71)
  assert.equal((await fetch(settingsUrl, { method: 'PUT', headers: adminJson, body: JSON.stringify(before) })).status, 200)
  checks.push('update permission allows writing and the change is persisted')

  assert.equal((await fetch(settingsUrl, { method: 'DELETE', headers: admin })).status, 405)
  checks.push('unsupported method rejected')

  mkdirSync('artifacts', { recursive: true })
  const receipt = { strapi: major, date: new Date().toISOString(), role: editor.code, checks, passed: true }
  writeFileSync(`artifacts/strapi${major}-permissions.json`, JSON.stringify(receipt, null, 2))
  console.log(`Strapi ${major}: settings permissions passed (${checks.length} checks)`)
} finally {
  await setPermissions(strip(originalPermissions).concat(
    originalPermissions.filter(p => p.action.startsWith('plugin::image-pipeline.'))
      .map(({ action, subject = null, properties = {}, conditions = [] }) => ({ action, subject, properties, conditions }))))
  for (const id of created) await fetch(`${base}/admin/users/${id}`, { method: 'DELETE', headers: admin })
}
