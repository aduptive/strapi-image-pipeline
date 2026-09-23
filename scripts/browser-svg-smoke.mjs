import assert from 'node:assert/strict'
import { labHost } from './lab.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// Reuse the shared laboratory's browser dependency.
const { chromium } = createRequire(new URL('../../strapi-plugin-block-picker/package.json', import.meta.url))('playwright')
const major = Number(process.argv[2])
assert.ok([4, 5].includes(major), 'Pass 4 or 5')
const { base: baseURL, credentials } = labHost(major)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1200 } })
const controls = { addSvgViewBox: 'Add missing SVG viewBox (numeric or px dimensions)', responsiveSvg: 'Remove SVG dimensions when viewBox is valid' }
const errors = []
page.on('pageerror', error => errors.push(error.message))
let original
let headers
try {
  const login = await fetch(`${baseURL}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })
  assert.equal(login.status, 200)
  const { data: { token } } = await login.json()
  headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  original = await fetch(`${baseURL}/image-pipeline/settings`, { headers }).then(r => r.json())
  await page.goto('/admin')
  await page.getByRole('textbox', { name: /^Email/ }).fill(credentials.email)
  await page.locator('input[name="password"]').fill(credentials.password)
  await page.getByRole('button', { name: 'Login', exact: true }).click()
  await page.waitForURL(url => !url.pathname.includes('/auth/'))
  await page.goto('/admin/settings/image-pipeline')
  await page.getByTestId('save-image-settings').waitFor()
  for (const label of Object.values(controls)) await page.getByLabel(label, { exact: true }).click()
  await page.getByTestId('save-image-settings').click()
  await page.getByText('Settings saved.', { exact: true }).waitFor()
  const saved = await fetch(`${baseURL}/image-pipeline/settings`, { headers }).then(r => r.json())
  for (const key of ['addSvgViewBox', 'responsiveSvg']) assert.equal(saved[key], !original[key])
  await page.reload()
  await page.getByTestId('save-image-settings').waitFor()
  for (const [key, label] of Object.entries(controls)) assert.equal(await page.getByLabel(label, { exact: true }).isChecked(), saved[key])
  assert.deepEqual(errors, [])
  mkdirSync('artifacts', { recursive: true })
  await page.screenshot({ path: `artifacts/strapi${major}-svg-settings.png`, fullPage: true })
  writeFileSync(`artifacts/strapi${major}-svg-browser.json`, JSON.stringify({ date: new Date().toISOString(), strapi: major, passed: true, checks: ['SVG controls', 'save', 'reload persistence'], runtimeErrors: errors }, null, 2))
  console.log(`Strapi ${major}: SVG settings browser checks passed`)
} finally {
  if (original) {
    const restored = await fetch(`${baseURL}/image-pipeline/settings`, { method: 'PUT', headers, body: JSON.stringify(original) })
    assert.equal(restored.status, 200)
  }
  await browser.close()
}
