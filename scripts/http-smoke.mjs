import assert from 'node:assert/strict'
import { labHost } from './lab.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import sharp from 'sharp'
import { JSDOM } from 'jsdom'
const parser = new (new JSDOM('').window.DOMParser)()
const major = Number(process.argv[2])
assert.ok([4, 5].includes(major), 'Pass 4 or 5')
const { base, credentials } = labHost(major)
const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })
assert.equal(login.status, 200)
const { data: { token } } = await login.json()
const headers = { Authorization: `Bearer ${token}` }
const settingsUrl = `${base}/image-pipeline/settings`
assert.ok([401, 403].includes((await fetch(settingsUrl)).status), 'Anonymous settings must be denied')
assert.ok([401, 403].includes((await fetch(settingsUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status))
const response = await fetch(settingsUrl, { headers })
assert.equal(response.status, 200)
const original = await response.json()
const put = body => fetch(settingsUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const upload = (bytes, type, name, id) => {
  const form = new FormData(); form.append('files', new Blob([bytes], { type }), name)
  return fetch(`${base}/upload${id ? `?id=${id}` : ''}`, { method: 'POST', headers, body: form })
}
const created = []
try {
  assert.equal((await put({ ...original, enabled: true, maxDimension: 80, maxFileSizeMB: 1, convertToWebp: true, sanitizeSvg: true, optimizeSvg: true, addSvgViewBox: true, responsiveSvg: true })).status, 200)
  const settings = await fetch(settingsUrl, { headers }).then(r => r.json())
  assert.equal(settings.addSvgViewBox, true); assert.equal(settings.responsiveSvg, true)
  const png = await sharp({ create: { width: 240, height: 120, channels: 4, background: '#ff550080' } }).png().toBuffer()
  const rasterResponse = await upload(png, 'image/png', 'smoke.png')
  assert.ok(rasterResponse.ok, (await rasterResponse.clone().text()).slice(0,500))
  const [raster] = await rasterResponse.json(); created.push(raster.id)
  assert.equal(raster.ext, '.webp'); assert.equal(raster.mime, 'image/webp'); assert.equal(raster.width, 80); assert.equal(raster.height, 40)
  const stored = Buffer.from(await fetch(`${base}${raster.url}`).then(r => r.arrayBuffer()))
  assert.equal((await sharp(stored).metadata()).format, 'webp')
  const mismatch = await upload(png, 'image/png', 'replacement.png', raster.id)
  assert.equal(mismatch.status, 400, 'Cross-format replacement must fail before deleting the stored asset')
  assert.equal((await fetch(`${base}${raster.url}`)).status, 200)
  const webp = await sharp(png).webp().toBuffer()
  const replaceResponse = await upload(webp, 'image/webp', 'replacement.webp', raster.id)
  assert.ok(replaceResponse.ok, `Same-format replacement: ${replaceResponse.status}`)
  const svgResponse = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" fill="red"/></svg>', 'image/svg+xml', 'smoke.svg')
  assert.ok(svgResponse.ok, (await svgResponse.clone().text()).slice(0,500))
  const [svg] = await svgResponse.json(); created.push(svg.id)
  const checkSvg = async (asset, viewBox, responsive) => {
    assert.equal(asset.mime, 'image/svg+xml'); assert.equal(asset.ext, '.svg')
    const bytes = await fetch(`${base}${asset.url}`).then(r => r.text())
    assert.doesNotMatch(bytes, /onload|<script/)
    const root = parser.parseFromString(bytes, 'image/svg+xml').documentElement
    assert.equal(root.getAttribute('viewBox'), viewBox)
    assert.equal(root.hasAttribute('width'), !responsive)
    assert.equal(root.hasAttribute('height'), !responsive)
    assert.equal(asset.size, Math.round(Buffer.byteLength(bytes) / 10) / 100)
  }
  await checkSvg(svg, '0 0 10 10', true)
  const svgReplacement = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="40px" height="20px"><rect width="40" height="20"/></svg>', 'image/svg+xml', 'replacement.svg', svg.id)
  assert.ok(svgReplacement.ok, (await svgReplacement.clone().text()).slice(0, 500))
  const replacement = await svgReplacement.json()
  await checkSvg(Array.isArray(replacement) ? replacement[0] : replacement, '0 0 40 20', true)
  assert.equal((await put({ sanitizeSvg: false, optimizeSvg: false, responsiveSvg: false })).status, 200)
  const dimensionsOnly = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="15"><rect width="30" height="15"/></svg>', 'image/svg+xml', 'dimensions.svg')
  assert.ok(dimensionsOnly.ok)
  const [dimensions] = await dimensionsOnly.json(); created.push(dimensions.id)
  await checkSvg(dimensions, '0 0 30 15', false)
  // Keeping the original format must not quantise a PNG (lossless re-encode).
  assert.equal((await put({ enabled: true, convertToWebp: false, maxDimension: 2000, sanitizeSvg: true, optimizeSvg: true })).status, 200)
  const gradient = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="600" height="200" fill="url(#g)"/></svg>')).png().toBuffer()
  const colours = async source => {
    const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true })
    const seen = new Set()
    for (let index = 0; index < data.length; index += info.channels) seen.add(data.readUIntBE(index, info.channels))
    return seen.size
  }
  const pngResponse = await upload(gradient, 'image/png', 'lossless.png')
  assert.ok(pngResponse.ok, (await pngResponse.clone().text()).slice(0, 300))
  const [lossless] = await pngResponse.json(); created.push(lossless.id)
  assert.equal(lossless.mime, 'image/png'); assert.equal(lossless.ext, '.png')
  const losslessBytes = Buffer.from(await fetch(`${base}${lossless.url}`).then(r => r.arrayBuffer()))
  assert.equal(await colours(losslessBytes), await colours(gradient), 'Stored PNG lost colours')
  assert.equal((await put({ convertToWebp: true, maxDimension: 80 })).status, 200)
  // AVIF: Strapi's own isImage/isOptimizableImage say no (Sharp reports "heif"),
  // so without the plugin's own path it would be stored untouched.
  assert.equal((await put({ enabled: true, maxDimension: 60, convertToWebp: true })).status, 200)
  const avifSource = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#2277aa' } }).avif({ quality: 50 }).toBuffer()
  const avifResponse = await upload(avifSource, 'image/avif', 'photo.avif')
  assert.ok(avifResponse.ok, (await avifResponse.clone().text()).slice(0, 300))
  const [avif] = await avifResponse.json(); created.push(avif.id)
  assert.equal(avif.mime, 'image/avif'); assert.equal(avif.ext, '.avif')
  const avifBytes = Buffer.from(await fetch(`${base}${avif.url}`).then(r => r.arrayBuffer()))
  const avifMeta = await sharp(avifBytes).metadata()
  assert.equal(avifMeta.compression, 'av1')
  assert.equal(Math.max(avifMeta.width, avifMeta.height), 60, 'AVIF must respect maxDimension')
  // A truncated AVIF still has a readable header; only decoding fails, and
  // Strapi never checks AVIF because it does not recognize heif as an image.
  const noisyAvif = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).avif({ quality: 70 }).toBuffer()
  const truncated = await upload(noisyAvif.subarray(0, Math.floor(noisyAvif.length / 2)), 'image/avif', 'broken.avif')
  assert.equal(truncated.status, 400, 'A truncated AVIF must be rejected')
  // An upload with no usable Content-Type is typed from its bytes, like Strapi does.
  const undeclared = await upload(await sharp({ create: { width: 120, height: 60, channels: 3, background: '#aa2277' } }).png().toBuffer(), 'application/octet-stream', 'undeclared.png')
  assert.ok(undeclared.ok, (await undeclared.clone().text()).slice(0, 300))
  const [sniffed] = await undeclared.json(); created.push(sniffed.id)
  assert.ok(Math.max(sniffed.width, sniffed.height) <= 60, 'Guards must apply to an undeclared upload')
  // The same undeclared bytes must also be accepted as a same-format replacement.
  // The stored format depends on convertToWebp, so derive it from the asset:
  // same format must be accepted even with no Content-Type, and a different
  // one must still be rejected on the byte-resolved type.
  const sameFormat = sniffed.mime === 'image/webp' ? 'webp' : 'png'
  const otherFormat = sameFormat === 'webp' ? 'png' : 'webp'
  const encode = format => sharp({ create: { width: 90, height: 45, channels: 3, background: '#227755' } })[format]().toBuffer()
  const sniffedReplacement = await upload(await encode(sameFormat), 'application/octet-stream', `undeclared-replacement.${sameFormat}`, sniffed.id)
  assert.ok(sniffedReplacement.ok, `Undeclared same-format replacement: ${sniffedReplacement.status} ${(await sniffedReplacement.clone().text()).slice(0, 200)}`)
  const crossFormat = await upload(await encode(otherFormat), 'application/octet-stream', `cross.${otherFormat}`, sniffed.id)
  assert.equal(crossFormat.status, 400, 'Cross-format replacement must still be rejected when the type comes from bytes')
  assert.equal((await put({ maxDimension: 80 })).status, 200)
  const tooLarge = await upload(Buffer.alloc(1024 * 1024 + 1), 'image/png', 'large.png')
  assert.equal(tooLarge.status, 413)
  assert.equal((await put(null)).status, 400)
  const hookChecks = []
  if (process.argv.includes('--hooks')) {
    assert.equal((await put({ enabled: true, maxDimension: 400, convertToWebp: true })).status, 200)
    const input = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#888888' } }).png().toBuffer()
    const add = async name => {
      const response = await upload(input, 'image/png', name)
      assert.ok(response.ok, (await response.clone().text()).slice(0, 500))
      const [asset] = await response.json(); created.push(asset.id)
      return asset
    }
    const bytes = asset => fetch(`${base}${asset.url}`).then(async response => {
      assert.ok(response.ok); return Buffer.from(await response.arrayBuffer())
    })
    const branded = await add('hook-brand.png')
    assert.equal(branded.mime, 'image/webp'); assert.equal(branded.width, 400)
    assert.ok(branded.formats.thumbnail, 'Strapi must generate a thumbnail from the transformed source')
    for (const asset of [branded, branded.formats.thumbnail]) {
      const { data, info } = await sharp(await bytes(asset)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const mark = (4 * info.width + 4) * info.channels
      assert.ok(data[mark] > 180 && data[mark + 2] < 60, 'Red watermark missing')
      const middle = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels
      assert.ok(data[middle + 2] > data[middle] + 30, 'Blue filter missing')
    }
    hookChecks.push('blue filter and watermark on source and thumbnail')
    await put({ convertToWebp: false })
    const stable = await add('hook-stable.png')
    const originalBytes = await bytes(stable)
    await put({ convertToWebp: true })
    for (const name of ['hook-reject-before.png', 'hook-reject-after.png', 'hook-timeout.png', 'hook-format.png']) {
      const failed = await upload(input, 'image/png', name, stable.id)
      assert.equal(failed.status, 400, `Expected rejection for ${name}`)
      assert.deepEqual(await bytes(stable), originalBytes, 'Failed hook changed the existing asset')
    }
    hookChecks.push('before/after errors preserve replacement', 'timeout preserves replacement', 'format change rejected')
    const [concurrent, replacedResponse] = await Promise.all([add('hook-concurrent.png'), upload(input, 'image/png', 'hook-replacement.png', stable.id)])
    assert.equal(concurrent.mime, 'image/webp')
    assert.ok(replacedResponse.ok)
    const replacementData = await replacedResponse.json()
    const replaced = Array.isArray(replacementData) ? replacementData[0] : replacementData
    assert.equal(replaced.mime, 'image/png'); assert.equal((await sharp(await bytes(replaced)).metadata()).format, 'png')
    hookChecks.push('concurrent upload and replacement isolation')
    await put({ hooks: { beforeProcess: 'untrusted code' }, hookTimeoutMs: 1 })
    const publicSettings = await fetch(settingsUrl, { headers }).then(r => r.json())
    assert.equal('hooks' in publicSettings, false); assert.equal('hookTimeoutMs' in publicSettings, false)
    assert.equal((await upload(input, 'image/png', 'hook-reject-before.png')).status, 400)
    hookChecks.push('admin cannot inject or override hook configuration')
    const disguised = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="evil()"/>', 'image/png', 'fake.png')
    assert.equal(disguised.status, 400)
    hookChecks.push('MIME spoofing rejected')
    await put({ enabled: false })
    const disabled = await add('hook-reject-before-disabled.png')
    assert.equal(disabled.mime, 'image/png')
    hookChecks.push('master switch bypasses custom hooks')
  }
  mkdirSync('artifacts', { recursive: true })
  const receipt = { strapi: major, date: new Date().toISOString(), checks: ['authenticated settings', 'anonymous denied', 'WebP bytes and metadata', 'resize', 'replacement guard and preserved asset', 'same-format replacement', 'SVG sanitization and responsive viewBox', 'SVG replacement bytes and metadata', 'SVG dimensions without sanitization or minification', 'SVG settings persistence', 'PNG kept in original format is not quantised', 'AVIF enters the pipeline and keeps its format', 'truncated AVIF rejected', 'undeclared MIME typed from bytes', 'undeclared replacement accepted, cross-format still rejected', 'size rejection', 'settings shape validation', ...hookChecks], passed: true }
  writeFileSync(`artifacts/strapi${major}${process.argv.includes('--hooks') ? '-hooks' : ''}-http.json`, JSON.stringify(receipt, null, 2))
  console.log(`Strapi ${major}: HTTP upload/settings integration passed (${receipt.checks.length} checks)`)
} finally {
  await put(original)
  for (const id of created) await fetch(`${base}/upload/files/${id}`, { method: 'DELETE', headers })
}
