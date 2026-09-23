const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { createOptimize } = require('../server/optimize')
const { defaults } = require('../server/config')
const { processSvg } = require('../server/svg')

test('raster resize, format, guard and fallback work on real image bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-plugin-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const input = path.join(dir, 'source.png')
  await sharp({ create: { width: 200, height: 100, channels: 4, background: '#ff000080' } }).png().toFile(input)
  const file = { filepath: input, hash: 'test', tmpWorkingDirectory: dir, name: 'source.png', ext: '.png', mime: 'image/png' }
  let settings = { ...defaults, maxDimension: 80 }
  let fallback = 0
  const optimize = createOptimize({ strapi: { log: { error() {} } }, getSettings: async () => settings,
    originalOptimize: async value => { fallback++; return value } })
  const result = await optimize(file)
  assert.equal(result.width, 80); assert.equal(result.height, 40)
  assert.equal(result.ext, '.webp'); assert.equal(result.mime, 'image/webp'); assert.equal(result.name, 'source.webp')
  assert.equal((await sharp(result.filepath).metadata()).format, 'webp')
  settings = { ...settings, convertToWebp: false }
  const original = await optimize(file)
  assert.equal(original.ext, '.png'); assert.equal((await sharp(original.filepath).metadata()).format, 'png')
  settings = { ...settings, maxMegapixels: 0.001 }
  await assert.rejects(optimize(file), /megapixel/)
  assert.equal(fallback, 0)
  settings = { ...defaults, enabled: false }
  assert.equal(await optimize(file), file); assert.equal(fallback, 1)
  settings = defaults
  assert.equal(await optimize({ ...file, filepath: path.join(dir, 'missing') }).then(x => x.filepath), path.join(dir, 'missing'))
  assert.equal(fallback, 2)
})

test('SVG strips executable content and external references while preserving internal refs', () => {
  const result = processSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><style>@import "https://bad.test/a";</style><path id="safe" d="M0 0L10 10"/><use href="#safe"/><image href="https://bad.test/a"/><path fill="url(https://bad.test/a)"/><set attributeName="href" to="javascript:alert(1)"/></svg>', { sanitize: true, optimize: false })
  assert.doesNotMatch(result, /onload|<script|<style|<set|bad\.test|javascript:/)
  assert.match(result, /href="#safe"/)
})

test('upload and replacement enforce guards before writes, support v4 paths and preserve replacement format', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-hook-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let uploaded = 0; let replaced = 0
  const settings = { ...defaults }
  const uploads = { async upload({ files }) { uploaded++; if (files?.type === 'image/svg+xml') assert.doesNotMatch(await fs.readFile(files.path, 'utf8'), /onload/) }, async replace() { replaced++ }, async findOne() { return { mime: 'image/webp' } } }
  const manipulation = { async optimize(file) { return file } }
  const strapi = { admin: { services: { permission: { actionProvider: { async registerMany(actions) { assert.equal(actions.length, 2) } } } } },
    plugin(name) { return { config: (key, fallback) => fallback, service(key) { return name === 'image-pipeline' ? { get: async () => settings } : key === 'upload' ? uploads : manipulation } } }, log: { error() {} } }
  await require('../server/bootstrap')({ strapi })
  await assert.rejects(uploads.upload({ files: { type: 'image/png', size: 6 * 1024 * 1024 } }), /limit/)
  assert.equal(uploaded, 0)
  await assert.rejects(uploads.replace(1, { file: { type: 'image/png' } }), /existing format/)
  assert.equal(replaced, 0)
  const svg = path.join(dir, 'test.svg'); await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"/>')
  await uploads.upload({ files: { type: 'image/svg+xml', path: svg, size: 80 } })
  // The request file is sanitized in place: no second file exists for anyone to
  // read the unsanitized bytes from, and none is left for the plugin to delete.
  assert.doesNotMatch(await fs.readFile(svg, 'utf8'), /onload/)
  assert.equal(uploaded, 1)
  await uploads.replace(1, { file: { type: 'image/webp', size: 20 } })
  assert.equal(replaced, 1)
})

test('settings reject invalid shapes and preserve configured defaults', async () => {
  const service = require('../server/services/settings')({ strapi: { plugin: () => ({ config: (key, fallback) => key === 'maxDimension' ? 900 : fallback }), store: () => ({ get: async () => ({}), set: async () => {} }) } })
  assert.equal((await service.get()).maxDimension, 900)
  assert.equal((await service.get()).addSvgViewBox, false)
  assert.equal((await service.get()).responsiveSvg, false)
  await assert.rejects(service.set(null), /object/)
  const saved = await service.set({ quality: 1000, enabled: 'yes' })
  assert.equal(saved.quality, 100); assert.equal(saved.enabled, true)
  const toggles = await service.set({ addSvgViewBox: true, responsiveSvg: true, plugins: ['removeTitle'] })
  assert.equal(toggles.addSvgViewBox, true); assert.equal(toggles.responsiveSvg, true)
  assert.equal('plugins' in toggles, false)
  const invalid = await service.set({ addSvgViewBox: 'true', responsiveSvg: 1 })
  assert.equal(invalid.addSvgViewBox, false); assert.equal(invalid.responsiveSvg, false)
})

test('SVG dimensions are opt-in, independent and only inferred from positive absolute lengths', () => {
  const { JSDOM } = require('jsdom')
  const parser = new (new JSDOM('').window.DOMParser)()
  const root = value => parser.parseFromString(value, 'image/svg+xml').documentElement
  const source = attrs => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10"/></svg>`
  const options = { sanitize: false, optimize: false, addViewBox: true, responsive: true }
  for (const [width, height, expected] of [['640', '480', '0 0 640 480'], ['640px', '480px', '0 0 640 480'], [' +6.4e2px ', '.5', '0 0 640 0.5']]) {
    const input = source(`width="${width}" height="${height}"`)
    assert.equal(processSvg(input, {}), input)
    const added = root(processSvg(input, { ...options, responsive: false }))
    assert.equal(added.getAttribute('viewBox'), expected)
    assert.equal(added.getAttribute('width'), width)
    const responsive = root(processSvg(input, options))
    assert.equal(responsive.getAttribute('viewBox'), expected)
    assert.equal(responsive.hasAttribute('width'), false)
    assert.equal(responsive.hasAttribute('height'), false)
    assert.equal(root(processSvg(input, { ...options, addViewBox: false })).hasAttribute('viewBox'), false)
  }
  for (const value of ['', '0', '-1', 'Infinity', 'NaN', '1e999', '1e-999', '0x10', '100%', '2em', '1cm', 'auto', '1 2', '5 px']) {
    for (const attrs of [`width="${value}" height="10"`, `width="10" height="${value}"`]) {
      const result = root(processSvg(source(attrs), options))
      assert.equal(result.hasAttribute('viewBox'), false, attrs)
      assert.equal(result.hasAttribute('width'), true, attrs)
      assert.equal(result.hasAttribute('height'), true, attrs)
    }
  }
  assert.equal(root(processSvg(source('width="10"'), options)).hasAttribute('viewBox'), false)
  for (const value of ['', '0 0 0 10', '0 0 -10 10', '0 0 Infinity 10', '0 0 1e999 10', '0,,0,10,10', '0 0 10 10,', '0 0 10', '0 0 10 10 20']) {
    const result = root(processSvg(source(`width="20" height="10" viewBox="${value}"`), options))
    assert.equal(result.getAttribute('viewBox'), value)
    assert.equal(result.getAttribute('width'), '20')
  }
  const existing = root(processSvg(source('width="20" height="10" viewBox="-5, -10, 20, 10" preserveAspectRatio="xMinYMin slice"'), options))
  assert.equal(existing.getAttribute('viewBox'), '-5, -10, 20, 10')
  assert.equal(existing.getAttribute('preserveAspectRatio'), 'xMinYMin slice')
  assert.equal(existing.hasAttribute('width'), false)
  const nested = root(processSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><svg width="5" height="5"/></svg>', options))
  assert.equal(nested.firstElementChild.getAttribute('width'), '5')
  assert.equal(nested.firstElementChild.hasAttribute('viewBox'), false)
  assert.equal(processSvg('<svg><g></svg>', options), '<svg><g></svg>')
  const tiny = root(processSvg(source('width="0.0001" height="10"'), { ...options, sanitize: true, optimize: true }))
  assert.equal(tiny.getAttribute('viewBox'), '0 0 0.0001 10')
})

test('SVG transformations preserve artwork, accessibility and internal references with minification', async () => {
  const raster = (await sharp({ create: { width: 2, height: 2, channels: 4, background: 'red' } }).png().toBuffer()).toString('base64')
  const input = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" role="img" aria-labelledby="art-title art-desc" preserveAspectRatio="xMinYMin slice">
    <title id="art-title">Artwork</title><desc id="art-desc">Created with a drawing tool</desc><defs>
    <linearGradient id="gradient"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
    <mask id="mask"><rect width="40" height="20" fill="white"/></mask>
    <clipPath id="clip"><rect width="40" height="20"/></clipPath>
    <path id="shape" d="M0 0H40V20H0Z"/>
    </defs><use href="#shape" fill="url(#gradient)" mask="url(#mask)" clip-path="url(#clip)"/>
    <image href="data:image/png;base64,${raster}" width="2" height="2"/></svg>`
  const output = processSvg(input, { sanitize: true, optimize: true, addViewBox: true, responsive: true })
  assert.match(output, /viewBox="0 0 40 20"/)
  assert.match(output, /preserveAspectRatio="xMinYMin slice"/)
  assert.match(output, /<title id="art-title">Artwork/)
  assert.match(output, /<desc id="art-desc">Created with a drawing tool/)
  assert.match(output, /role="img"/)
  for (const id of ['gradient', 'mask', 'clip', 'shape']) {
    assert.ok(output.includes(`id="${id}"`), id)
    assert.ok(output.includes(`#${id}`), id)
  }
  assert.ok(output.includes(`data:image/png;base64,${raster}`))
  const render = svg => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual(await render(output), await render(input))
})

test('keeping the original format re-encodes PNG losslessly and keeps indexed PNG indexed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-png-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const gradient = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="300" height="100" fill="url(#g)" fill-opacity="0.8"/></svg>')
  const truecolor = path.join(dir, 'gradient.png')
  await sharp(gradient).png().toFile(truecolor)
  const indexed = path.join(dir, 'indexed.png')
  await sharp(gradient).png({ palette: true, colours: 16 }).toFile(indexed)
  const colours = async source => {
    const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true })
    const seen = new Set()
    for (let i = 0; i < data.length; i += info.channels) seen.add(data.readUIntBE(i, info.channels))
    return seen.size
  }
  const settings = { ...defaults, convertToWebp: false, quality: 80 }
  const optimize = createOptimize({ strapi: { log: { error() {} } }, getSettings: async () => settings,
    originalOptimize: async value => { assert.fail('PNG re-encode must not fall back') } })
  // Quality must not quantise a lossless format: colours and alpha survive.
  const before = await colours(truecolor)
  const result = await optimize({ filepath: truecolor, hash: 'truecolor', tmpWorkingDirectory: dir, name: 'gradient.png', ext: '.png', mime: 'image/png' })
  assert.equal(result.mime, 'image/png'); assert.equal(result.ext, '.png')
  const output = await sharp(result.filepath).metadata()
  assert.equal(output.format, 'png'); assert.equal(output.hasAlpha, true); assert.equal(output.isPalette, false)
  assert.equal(await colours(result.filepath), before, 'PNG colours must survive re-encoding')
  assert.deepEqual(await sharp(result.filepath).raw().toBuffer(), await sharp(truecolor).raw().toBuffer())
  // An already-indexed PNG stays indexed instead of ballooning to truecolor.
  const small = await optimize({ filepath: indexed, hash: 'indexed', tmpWorkingDirectory: dir, name: 'indexed.png', ext: '.png', mime: 'image/png' })
  assert.equal((await sharp(small.filepath).metadata()).isPalette, true)
  assert.ok(small.sizeInBytes <= (await fs.stat(indexed)).size * 1.1, 'Indexed PNG must not balloon')
  // Resizing still works on the lossless path.
  settings.maxDimension = 100
  const resized = await optimize({ filepath: truecolor, hash: 'resized', tmpWorkingDirectory: dir, name: 'gradient.png', ext: '.png', mime: 'image/png' })
  assert.equal(resized.width, 100); assert.equal((await sharp(resized.filepath).metadata()).format, 'png')
  // WebP conversion keeps using quality, which is the correct knob there.
  settings.convertToWebp = true; settings.maxDimension = defaults.maxDimension
  const webp = await optimize({ filepath: truecolor, hash: 'webp', tmpWorkingDirectory: dir, name: 'gradient.png', ext: '.png', mime: 'image/png' })
  assert.equal(webp.mime, 'image/webp')
  assert.ok(webp.sizeInBytes < (await fs.stat(truecolor)).size, 'WebP conversion must still shrink the file')
})
