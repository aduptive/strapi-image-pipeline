// Proves Strapi's native media webhooks deliver post-processing metadata to a
// loopback receiver. No plugin code is involved: this documents what n8n or
// any other system receives after the plugin has already run.
import assert from 'node:assert/strict'
import { labHost } from './lab.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import sharp from 'sharp'
const major = Number(process.argv[2])
assert.ok([4, 5].includes(major), 'Pass 4 or 5')
const { base, credentials } = labHost(major)
const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })
assert.equal(login.status, 200)
const { data: { token } } = await login.json()
const headers = { Authorization: `Bearer ${token}` }
const json = { ...headers, 'Content-Type': 'application/json' }
const settingsUrl = `${base}/image-pipeline/settings`
const original = await fetch(settingsUrl, { headers }).then(r => r.json())
const put = body => fetch(settingsUrl, { method: 'PUT', headers: json, body: JSON.stringify(body) })

const received = []
const receiver = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => { received.push({ headers: request.headers, body: JSON.parse(body) }); response.end('ok') })
})
await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve))
const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`
const next = async event => {
  for (let i = 0; i < 100; i++) {
    const index = received.findIndex(r => r.body.event === event)
    if (index >= 0) return received.splice(index, 1)[0]
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`No ${event} webhook delivered`)
}
let webhookId
let assetId
try {
  const registered = await fetch(`${base}/admin/webhooks`, { method: 'POST', headers: json, body: JSON.stringify({
    name: 'image-pipeline smoke', url: receiverUrl, headers: { 'x-smoke-auth': 'synthetic' },
    events: ['media.create', 'media.update', 'media.delete'],
  }) })
  assert.ok(registered.ok, `Webhook registration: ${registered.status} ${(await registered.clone().text()).slice(0, 300)}`)
  webhookId = (await registered.json()).data.id
  assert.equal((await put({ ...original, enabled: true, maxDimension: 400, convertToWebp: true })).status, 200)
  const png = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#888888' } }).png().toBuffer()
  const upload = (bytes, type, name, id) => {
    const form = new FormData(); form.append('files', new Blob([bytes], { type }), name)
    return fetch(`${base}/upload${id ? `?id=${id}` : ''}`, { method: 'POST', headers, body: form })
  }
  const uploaded = await upload(png, 'image/png', 'hook-brand.png')
  assert.ok(uploaded.ok, (await uploaded.clone().text()).slice(0, 300))
  const [asset] = await uploaded.json(); assetId = asset.id
  const created = await next('media.create')
  assert.equal(created.headers['x-strapi-event'], 'media.create')
  assert.equal(created.headers['x-smoke-auth'], 'synthetic')
  assert.equal(created.headers['content-type'], 'application/json')
  assert.ok(created.body.createdAt)
  const { media } = created.body
  assert.equal(media.id, asset.id)
  assert.equal(media.mime, 'image/webp'); assert.equal(media.ext, '.webp'); assert.equal(media.width, 400); assert.equal(media.height, 200)
  assert.equal(media.name, 'hook-brand.webp'); assert.equal(media.url, asset.url)
  assert.ok(media.formats?.thumbnail?.url, 'Formats are persisted before the event')
  const serialized = JSON.stringify(created.body)
  assert.doesNotMatch(serialized, /filepath|tmpWorkingDirectory|buffer|hooks|Bearer/i, 'Payload must contain only persisted media metadata')
  const replaced = await upload(await sharp(png).resize(100).webp().toBuffer(), 'image/webp', 'replacement.webp', asset.id)
  assert.ok(replaced.ok, (await replaced.clone().text()).slice(0, 300))
  const updated = await next('media.update')
  assert.equal(updated.body.media.id, asset.id)
  assert.equal(updated.body.media.width, 100)
  assert.equal(updated.body.media.url, asset.url, 'Replacement keeps the URL; consumers must not cache by URL alone')
  assert.equal((await fetch(`${base}/upload/files/${asset.id}`, { method: 'DELETE', headers })).ok, true)
  assetId = undefined
  const deleted = await next('media.delete')
  assert.equal(deleted.body.media.id, asset.id)
  assert.equal(received.length, 0, `Unexpected extra deliveries: ${received.map(r => r.body.event)}`)
  mkdirSync('artifacts', { recursive: true })
  const receipt = { strapi: major, date: new Date().toISOString(), receiver: receiverUrl, checks: [
    'admin webhook registration', 'media.create after persistence with processed mime/ext/dimensions/formats',
    'custom header and X-Strapi-Event delivered', 'payload excludes temp paths, buffers and hook config',
    'media.update on replacement keeps URL', 'media.delete', 'no duplicate events'], passed: true }
  writeFileSync(`artifacts/strapi${major}-webhooks.json`, JSON.stringify(receipt, null, 2))
  console.log(`Strapi ${major}: native media webhooks passed (${receipt.checks.length} checks)`)
} finally {
  await put(original)
  if (assetId) await fetch(`${base}/upload/files/${assetId}`, { method: 'DELETE', headers })
  if (webhookId) await fetch(`${base}/admin/webhooks/${webhookId}`, { method: 'DELETE', headers })
  receiver.close()
}
