const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { defaults, validator } = require('../server/config')
const { createRunHook } = require('../server/hooks')

async function fixture(t, config = {}, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-hooks-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const settings = { ...defaults, ...overrides }
  const saved = []
  // control.optimizeDelay makes the underlying optimization block on demand, so
  // the races between a failing file and a slow one are deterministic instead
  // of timing-dependent. control.errors keeps the errors of lifecycles whose
  // result Promise.all discarded after the first rejection.
  const control = { optimizeDelay: null, enterDelay: null, failStore: null, errors: [], inFlight: [], providerDelay: null, deferTeardown: null, teardown: null, snapshotDir: null, snapshots: [] }
  const manipulation = { optimize: async file => { if (control.optimizeDelay) await control.optimizeDelay; return file } }
  const normalize = file => ({ filepath: file.filepath || file.path, mime: file.mimetype || file.type, name: file.originalFilename || file.name,
    ext: '.png', hash: path.basename(file.filepath || file.path), tmpWorkingDirectory: file.tmpWorkingDirectory })
  // Strapi creates one working directory per upload/replace call and removes it
  // in its own finally, after every reader of those files is done. Modelling it
  // is what makes the plugin's temporary-file ownership testable.
  // Stock Strapi: one working directory per call, removed in its own finally as
  // soon as the batch settles, without waiting for the files still running.
  // control.deferTeardown holds that removal back, which isolates the question
  // "does the PLUGIN delete a file someone is still reading?" from the host's
  // own teardown, which hits its `optimized-*` files exactly the same way.
  const withWorkingDirectory = async (files, run) => {
    const working = await fs.mkdtemp(path.join(dir, 'strapi-upload-'))
    for (const file of [files].flat().filter(Boolean)) file.tmpWorkingDirectory = working
    control.inFlight = []
    const remove = () => fs.rm(working, { recursive: true, force: true })
    try { return await run() } finally {
      if (control.deferTeardown) control.teardown = control.deferTeardown.then(remove)
      else await remove()
    }
  }
  // Mirror Strapi: only isOptimizableImage formats reach the optimizer, decided
  // from the bytes. Sharp reports AVIF as "heif", which is why Strapi's own
  // list never matches it and the plugin has to handle AVIF itself.
  const OPTIMIZABLE = ['jpeg', 'png', 'webp', 'tiff']
  async function store(file) {
    const normalized = normalize(file)
    const { format } = await sharp(normalized.filepath).metadata().catch(() => ({}))
    let result
    try {
      // enterDelay makes one named file reach the optimizer only after a
      // sibling has already failed, which is the late-entry case.
      if (control.enterDelay && control.enterDelay.name === normalized.name) await control.enterDelay.promise
      result = OPTIMIZABLE.includes(format) ? await manipulation.optimize(normalized) : normalized
    } catch (error) { control.errors.push(error); throw error }
    // The provider stage: it consumes the processed file and can fail there.
    if (control.failStore) throw new Error(control.failStore)
    if (control.providerDelay) await control.providerDelay
    // What exists on disk at the moment the provider reads the file.
    if (control.snapshotDir) control.snapshots.push(await fs.readdir(control.snapshotDir))
    saved.push({ ...result, buffer: await fs.readFile(result.filepath) })
    return saved.at(-1)
  }
  const uploads = {
    async upload({ files }) {
      return withWorkingDirectory(files, () => Promise.all([files].flat().map(file => {
        const started = store(file)
        control.inFlight.push(started)
        return started
      })))
    },
    async replace(id, { file }) { return withWorkingDirectory(file, () => store(file)) },
    async uploadToEntity(params, files) { return withWorkingDirectory(files, () => store(files)) },
    async findOne() { return { mime: 'image/png' } },
  }
  const strapi = { log: { error() {} }, admin: { services: { permission: { actionProvider: { async registerMany() {} } } } },
    plugin(name) { return { config: (key, fallback) => config[key] ?? fallback,
      service: key => name === 'image-pipeline' ? { get: async () => settings } : key === 'upload' ? uploads : manipulation } } }
  await require('../server/bootstrap')({ strapi })
  async function image(name = 'brand.png', version = 5) {
    const filepath = path.join(dir, name)
    const buffer = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#888888' } }).png().toBuffer()
    await fs.writeFile(filepath, buffer)
    return version === 4 ? { path: filepath, name, type: 'image/png', size: buffer.length } : { filepath, originalFilename: name, mimetype: 'image/png', size: buffer.length }
  }
  return { dir, image, uploads, settings, saved, strapi, control }
}

test('hooks receive ordered context and transform actual pixels before and after conversion', async t => {
  const seen = []
  const f = await fixture(t, { hooks: {
    async beforeProcess({ image, original, event, operation, settings, sharp: processor }) {
      seen.push([event, operation, original.mime, image.mime])
      assert.equal(image.name, 'brand.png')
      assert.equal(Object.isFrozen(settings), true)
      assert.equal(image.width, 40)
      return processor(image.buffer).tint('#0000ff').png().toBuffer()
    },
    async afterProcess({ image, original, event, operation, sharp: processor }) {
      seen.push([event, operation, original.mime, image.mime])
      assert.equal(image.width, 20)
      const watermark = await processor({ create: { width: 3, height: 3, channels: 4, background: 'red' } }).png().toBuffer()
      return processor(image.buffer).composite([{ input: watermark, left: 0, top: 0 }]).webp({ lossless: true }).toBuffer()
    },
  } }, { maxDimension: 20 })
  const [result] = await f.uploads.upload({ files: await f.image() })
  assert.deepEqual(seen, [['beforeProcess', 'upload', 'image/png', 'image/png'], ['afterProcess', 'upload', 'image/png', 'image/webp']])
  assert.equal(result.name, 'brand.webp'); assert.equal(result.ext, '.webp')
  assert.equal(result.sizeInBytes, result.buffer.length)
  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true })
  assert.ok(data[0] > 200 && data[2] < 30, 'Watermark is red')
  const offset = (5 * info.width + 5) * info.channels
  assert.ok(data[offset + 2] > data[offset], 'Unmarked area is blue')
})

test('concurrent upload and replacement keep operation and conversion settings isolated', async t => {
  const events = []
  const f = await fixture(t, { hooks: {
    async beforeProcess({ image, operation }) {
      await new Promise(resolve => setImmediate(resolve))
      events.push([image.name, operation, 'before'])
      return image.buffer
    },
    afterProcess({ image, operation }) { events.push([image.name, operation, image.mime]) },
  } })
  const upload = await f.image('upload.png')
  const replace = await f.image('replace.png', 4)
  const [[created], replaced] = await Promise.all([f.uploads.upload({ files: upload }), f.uploads.replace(1, { file: replace })])
  assert.equal(created.mime, 'image/webp'); assert.equal(replaced.mime, 'image/png')
  assert.ok(events.some(e => e.join() === 'upload.webp,upload,image/webp'))
  assert.ok(events.some(e => e.join() === 'replace.png,replace,image/png'))
  f.settings.enabled = false
  const count = events.length
  await f.uploads.upload({ files: await f.image('disabled.png') })
  assert.equal(events.length, count)
})

test('hook errors, timeouts and invalid outputs abort before storage with no silent fallback', async t => {
  for (const event of ['beforeProcess', 'afterProcess']) {
    for (const handler of [() => { throw new Error('private failure') }, () => null, () => Buffer.from('not an image'), () => new Promise(() => {})]) {
      const f = await fixture(t, { hooks: { [event]: handler }, hookTimeoutMs: 10 })
      await assert.rejects(f.uploads.replace(1, { file: await f.image() }), /hook|image/i)
      assert.equal(f.saved.length, 0)
    }
  }
  let signal
  const f = await fixture(t, { hooks: { beforeProcess: context => { signal = context.signal; return new Promise(() => {}) } }, hookTimeoutMs: 10 })
  await assert.rejects(f.uploads.upload({ files: await f.image() }), /beforeProcess/)
  assert.equal(signal.aborted, true)
})

test('hook format, byte size, pixels and final dimensions are validated', async t => {
  for (const [hook, settings, message] of [
    [async ({ image }) => sharp(image.buffer).jpeg().toBuffer(), {}, /preserve.*format/],
    [() => Buffer.alloc(1024 * 1024 + 1), { maxFileSizeMB: 1 }, /size limit/],
    [async () => sharp({ create: { width: 200, height: 100, channels: 3, background: 'red' } }).png().toBuffer(), { maxMegapixels: 0.001 }, /megapixel/],
    [async ({ image }) => sharp(image.buffer).resize(200).png().toBuffer(), { maxDimension: 40 }, /maximum dimension/],
  ]) {
    const f = await fixture(t, { hooks: { afterProcess: hook } }, { convertToWebp: false, ...settings })
    await assert.rejects(f.uploads.replace(1, { file: await f.image() }), message)
    assert.equal(f.saved.length, 0)
  }
  const f = await fixture(t, { hooks: { beforeProcess() { assert.fail('Oversized input must not reach hook') } } }, { maxFileSizeMB: 1 })
  const file = await f.image()
  await fs.writeFile(file.filepath, Buffer.alloc(1024 * 1024 + 1))
  file.size = 1
  await assert.rejects(f.uploads.upload({ files: file }), /size limit/)
})

test('SVG and GIF hooks run through uploadToEntity and SVG output remains sanitized', async t => {
  const events = []
  const f = await fixture(t, { hooks: {
    beforeProcess({ event, image }) { events.push([event, image.mime]); assert.doesNotMatch(image.buffer.toString(), /onload/) },
    afterProcess({ event, image }) {
      events.push([event, image.mime])
      if (image.mime === 'image/svg+xml') return Buffer.from(image.buffer.toString().replace('<svg ', '<svg onload="evil()" '))
      return image.buffer
    },
  } })
  const svg = path.join(f.dir, 'sample.svg')
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="evil()"><rect width="10" height="10"/></svg>')
  const result = await f.uploads.uploadToEntity({}, { path: svg, type: 'image/svg+xml', name: 'sample.svg' })
  assert.doesNotMatch(result.buffer.toString(), /onload/)
  const gif = path.join(f.dir, 'sample.gif')
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).gif().toFile(gif)
  await f.uploads.upload({ files: { filepath: gif, mimetype: 'image/gif', originalFilename: 'sample.gif' } })
  assert.deepEqual(events, [['beforeProcess', 'image/svg+xml'], ['afterProcess', 'image/svg+xml'], ['beforeProcess', 'image/gif'], ['afterProcess', 'image/gif']])
})

test('config rejects executable strings and unknown hooks; undefined output keeps bytes intact', async t => {
  for (const config of [{ hooks: [] }, { hooks: { beforeProcess: 'code' } }, { hooks: { typo() {} } }, { hookTimeoutMs: 0 }, { hookTimeoutMs: Infinity }]) assert.throws(() => validator(config))
  validator({ hooks: { beforeProcess() {}, afterProcess() {} } })
  const f = await fixture(t)
  const file = await f.image()
  const before = await fs.readFile(file.filepath)
  const run = createRunHook({ strapi: f.strapi, hooks: { beforeProcess({ image }) { image.buffer.fill(0) } } })
  await run('beforeProcess', { filepath: file.filepath, mime: 'image/png', name: 'brand.png' }, { settings: f.settings })
  assert.deepEqual(await fs.readFile(file.filepath), before)
})

test('MIME spoofing cannot bypass SVG sanitization or hooks, and pixel guards run before Strapi', async t => {
  const f = await fixture(t)
  const svg = path.join(f.dir, 'disguised.svg')
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="evil()"/>')
  for (const type of ['image/png', 'text/plain']) {
    await assert.rejects(f.uploads.upload({ files: { path: svg, type, name: 'disguised.png' } }), /MIME/)
  }
  // Undeclared bytes are typed from content, like Strapi does, and still get
  // sanitized: accepting them is safer than rejecting a valid upload.
  await f.uploads.upload({ files: { path: svg, type: 'application/octet-stream', name: 'undeclared.png' } })
  assert.doesNotMatch(f.saved.at(-1).buffer.toString(), /onload/)
  f.saved.length = 0
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>')
  await assert.rejects(f.uploads.upload({ files: { path: svg, type: 'image/png', name: 'disguised.png' } }), /Invalid image|MIME/)
  await assert.rejects(f.uploads.upload({ files: { path: svg, type: 'text/plain', name: 'disguised.svg' } }), /SVG files/)
  f.settings.maxMegapixels = 0.0001
  await assert.rejects(f.uploads.upload({ files: await f.image() }), /megapixel/)
  assert.equal(f.saved.length, 0)
})

test('changed dimensions use fresh paths and temporary hook files are cleaned on success and failure', async t => {
  const f = await fixture(t, { hooks: {
    beforeProcess: ({ image }) => sharp(image.buffer).resize(80, 40).png().toBuffer(),
    afterProcess: ({ image }) => {
      assert.equal(image.width, 20); assert.equal(image.height, 10)
      return sharp(image.buffer).resize(10, 5).png().toBuffer()
    },
  } }, { maxDimension: 20, convertToWebp: false })
  const file = await f.image()
  const original = await fs.readFile(file.filepath)
  const [result] = await f.uploads.upload({ files: file })
  assert.equal(result.width, 10); assert.equal(result.height, 5)
  assert.equal((await sharp(result.buffer).metadata()).width, 10)
  assert.deepEqual(await fs.readFile(file.filepath), original)
  assert.equal((await fs.readdir(f.dir)).filter(name => name.startsWith('image-hook-')).length, 0)
  const failed = await fixture(t, { hooks: {
    beforeProcess: ({ image }) => image.buffer,
    afterProcess() { throw new Error('stop after writing temporary output') },
  } })
  await assert.rejects(failed.uploads.upload({ files: await failed.image() }), /afterProcess/)
  assert.equal((await fs.readdir(failed.dir)).filter(name => name.startsWith('image-hook-')).length, 0)
})

test('AVIF enters the pipeline instead of bypassing it, and keeps its format', async t => {
  const seen = []
  const f = await fixture(t, { hooks: {
    beforeProcess({ image, event }) { seen.push([event, image.mime, image.width]) },
    afterProcess({ image, event }) { seen.push([event, image.mime, image.width]) },
  } }, { maxDimension: 40, convertToWebp: true })
  const filepath = path.join(f.dir, 'photo.avif')
  await sharp({ create: { width: 160, height: 80, channels: 3, background: '#3366cc' } }).avif({ quality: 50 }).toFile(filepath)
  const [stored] = await f.uploads.upload({ files: { filepath, originalFilename: 'photo.avif', mimetype: 'image/avif', size: (await fs.stat(filepath)).size } })
  // Strapi's own isImage/isOptimizableImage return false for AVIF (Sharp reports
  // format "heif"), so without the plugin's own path nothing would run at all.
  assert.deepEqual(seen, [['beforeProcess', 'image/avif', 160], ['afterProcess', 'image/avif', 40]])
  const metadata = await sharp(stored.buffer).metadata()
  assert.equal(metadata.compression, 'av1'); assert.equal(metadata.width, 40)
  assert.equal(stored.mime, 'image/avif', 'AVIF is not converted to WebP')
  // The processed bytes replaced the request file in place, so the pixel guard
  // gets its own untouched copy.
  assert.equal((await sharp(filepath).metadata()).width, 40, 'The request file carries the processed bytes')
  const guarded = await fixture(t, { hooks: {} }, { maxMegapixels: 0.001 })
  const untouched = path.join(guarded.dir, 'big.avif')
  await sharp({ create: { width: 160, height: 80, channels: 3, background: '#3366cc' } }).avif({ quality: 50 }).toFile(untouched)
  await assert.rejects(guarded.uploads.upload({ files: { filepath: untouched, originalFilename: 'big.avif', mimetype: 'image/avif', size: 10 } }), /megapixel/)
})

test('the optimizer encodes AVIF instead of falling back to the untouched original', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-avif-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { createOptimize } = require('../server/optimize')
  const filepath = path.join(dir, 'source.avif')
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#cc3366' } }).avif({ quality: 60 }).toFile(filepath)
  let fallback = 0
  const optimize = createOptimize({ strapi: { log: { error() {} } }, getSettings: async () => ({ ...defaults, maxDimension: 50, convertToWebp: false }),
    originalOptimize: async file => { fallback++; return file } })
  const result = await optimize({ filepath, hash: 'avif', tmpWorkingDirectory: dir, name: 'source.avif', ext: '.avif', mime: 'image/avif' })
  assert.equal(fallback, 0, 'AVIF must not fall into the error fallback')
  assert.equal(result.width, 50); assert.equal(result.mime, 'image/avif'); assert.equal(result.ext, '.avif')
  assert.equal((await sharp(result.filepath).metadata()).compression, 'av1')
})

test('a batch rejection waits for slow concurrent hooks and leaves no orphan files', async t => {
  let release
  const started = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { hooks: {
    async beforeProcess({ image, original }) {
      if (original.name === 'fast.png') { await started; throw new Error('fast failure') }
      release()
      await new Promise(resolve => setTimeout(resolve, 120))
      return sharp(image.buffer).resize(20, 10).png().toBuffer()
    },
  } }, { convertToWebp: false })
  // Strapi batches the files of one upload with Promise.all: the rejection
  // lands while the slow transform is still about to write its output.
  const slow = await f.image('slow.png')
  const fast = await f.image('fast.png')
  await assert.rejects(f.uploads.upload({ files: [slow, fast] }), /hook|fast/i)
  await new Promise(resolve => setTimeout(resolve, 250))
  const orphans = (await fs.readdir(f.dir)).filter(name => name.startsWith('image-hook-'))
  assert.deepEqual(orphans, [], `Orphan temporary files left behind: ${orphans}`)
})

test('undeclared MIME falls back to bytes, but a contradicting image type is still rejected', async t => {
  const f = await fixture(t, { hooks: { beforeProcess({ image }) { assert.equal(image.mime, 'image/png') } } }, { convertToWebp: false })
  const file = await f.image('unknown.png')
  // Strapi 5 sniffs the bytes into detectedMimeType and treats
  // application/octet-stream as undeclared; the plugin must not reject it.
  const [stored] = await f.uploads.upload({ files: { ...file, mimetype: 'application/octet-stream', detectedMimeType: 'image/png' } })
  assert.equal((await sharp(stored.buffer).metadata()).format, 'png')
  const bare = await f.image('bare.png')
  const [second] = await f.uploads.upload({ files: { ...bare, mimetype: 'application/octet-stream' } })
  assert.equal((await sharp(second.buffer).metadata()).format, 'png')
  const svg = path.join(f.dir, 'disguised.svg')
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="evil()"/>')
  await assert.rejects(f.uploads.upload({ files: { path: svg, type: 'image/png', name: 'disguised.png' } }), /MIME/)
  await assert.rejects(f.uploads.upload({ files: { path: svg, type: 'application/octet-stream', detectedMimeType: 'image/png', name: 'disguised.png' } }), /MIME/)
})

test('processed files stream their transformed bytes for remote providers, and a storage failure cleans up', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-provider-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { createRunHook } = require('../server/hooks')
  const settings = { ...defaults, convertToWebp: false }
  const source = path.join(dir, 'source.png')
  await sharp({ create: { width: 30, height: 30, channels: 3, background: '#112233' } }).png().toFile(source)
  const temporaryFiles = []
  const run = createRunHook({ strapi: { log: { error() {} } },
    hooks: { beforeProcess: ({ image }) => sharp(image.buffer).tint('#ff0000').png().toBuffer() } })
  const result = await run('beforeProcess', { filepath: source, mime: 'image/png', name: 'source.png' },
    { settings, operation: 'upload', temporaryFiles })
  // A remote provider never reads the path: it consumes getStream().
  const chunks = []
  for await (const chunk of result.getStream()) chunks.push(chunk)
  const streamed = Buffer.concat(chunks)
  assert.equal(streamed.length, result.sizeInBytes)
  const { data } = await sharp(streamed).raw().toBuffer({ resolveWithObject: true })
  const original = await sharp(source).raw().toBuffer()
  assert.ok(data[0] > data[2], 'The stream must carry the tinted pixels, not the original')
  assert.notDeepEqual(data.subarray(0, 3), original.subarray(0, 3))
  // The storage failure is injected inside the mock provider, so the plugin's
  // own upload wrapper stays installed and its cleanup is what is being tested.
  let hookRuns = 0
  const f = await fixture(t, { hooks: { beforeProcess: ({ image }) => { hookRuns++; return sharp(image.buffer).resize(10).png().toBuffer() } } }, { convertToWebp: false })
  f.control.failStore = 'provider refused the upload'
  await assert.rejects(f.uploads.upload({ files: await f.image('remote.png') }), /provider refused/)
  assert.equal(hookRuns, 1, 'The failure must happen downstream of the installed wrapper, not instead of it')
  assert.equal(f.saved.length, 0)
  assert.deepEqual((await fs.readdir(f.dir)).filter(name => name.startsWith('image-hook-')), [], 'Temporary hook output leaked after a storage failure')
})

test('the plugin deletes no file while the provider is still reading it', async t => {
  let failed, allowTeardown
  const fastFailed = new Promise(resolve => { failed = resolve })
  const f = await fixture(t, { hooks: {
    beforeProcess({ image, original }) {
      if (original.name === 'fast.png') { failed(); throw new Error('fast failure') }
      return sharp(image.buffer).resize(20, 10).png().toBuffer()
    },
    afterProcess: ({ image }) => sharp(image.buffer).resize(8, 4).png().toBuffer(),
  } }, { convertToWebp: false })
  // The host keeps its working directory: whatever disappears in this window
  // was deleted by the plugin, not by Strapi's own teardown.
  f.control.deferTeardown = new Promise(resolve => { allowTeardown = resolve })
  f.control.providerDelay = fastFailed.then(() => new Promise(resolve => setTimeout(resolve, 100)))
  await assert.rejects(f.uploads.upload({ files: [await f.image('slow.png'), await f.image('fast.png')] }), /hook|fast/i)
  await new Promise(resolve => setTimeout(resolve, 250))
  const missing = f.control.errors.filter(error => /ENOENT|Input file is missing|no such file/i.test(error.message))
  assert.deepEqual(missing.map(error => error.message), [], 'A file was deleted while the provider was still reading it')
  assert.equal(f.saved.length, 1, 'The surviving file must still reach storage')
  assert.equal(f.saved[0].width, 8)
  allowTeardown()
  await f.control.teardown
})

test('the plugin creates no file of its own outside the host working directory', async t => {
  const f = await fixture(t, { hooks: { afterProcess: ({ image }) => image.buffer } })
  const requestDir = await fs.mkdtemp(path.join(f.dir, 'request-'))
  const svg = path.join(requestDir, 'brand.svg')
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" onload="evil()"><rect width="20" height="10"/></svg>')
  // The SVG path runs before the host has a working directory, so anything the
  // plugin writes there is its own to delete, and deleting it races whoever is
  // still reading. Snapshot the directory at the moment the provider reads.
  f.control.snapshotDir = requestDir
  await f.uploads.upload({ files: { filepath: svg, originalFilename: 'brand.svg', mimetype: 'image/svg+xml', size: 80 } })
  assert.deepEqual(f.control.snapshots, [['brand.svg']], 'The plugin left a file of its own next to the request file')
  const stored = await fs.readFile(svg, 'utf8')
  assert.doesNotMatch(stored, /onload/, 'The request file itself carries the sanitized bytes')
  assert.deepEqual((await fs.readdir(requestDir)), ['brand.svg'])
})

test('a late failure leaves nothing behind anywhere', async t => {
  let failed
  const fastFailed = new Promise(resolve => { failed = resolve })
  const f = await fixture(t, { hooks: {
    beforeProcess({ image, original }) {
      if (original.name === 'fast.png') { failed(); throw new Error('fast failure') }
      return image.buffer
    },
    afterProcess: ({ image }) => sharp(image.buffer).resize(12, 6).png().toBuffer(),
  } }, { convertToWebp: false })
  f.control.enterDelay = { name: 'slow.png', promise: fastFailed.then(() => new Promise(resolve => setTimeout(resolve, 100))) }
  await assert.rejects(f.uploads.upload({ files: [await f.image('slow.png'), await f.image('fast.png')] }), /hook|fast/i)
  await new Promise(resolve => setTimeout(resolve, 250))
  const leftovers = []
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.startsWith('image-hook-') || entry.name.includes('image-pipeline-')) leftovers.push(full)
    }
  }
  await walk(f.dir)
  assert.deepEqual(leftovers, [], `Files left behind after the operation ended: ${leftovers}`)
})

test('a truncated AVIF is rejected on upload and on replacement', async t => {
  const f = await fixture(t, { hooks: { beforeProcess() { assert.fail('A corrupt image must not reach hooks') } } })
  const filepath = path.join(f.dir, 'broken.avif')
  // Noise keeps the file large enough that half of it still carries a valid
  // header, which is exactly the case that used to slip through.
  const complete = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).avif({ quality: 70 }).toBuffer()
  await fs.writeFile(filepath, complete.subarray(0, Math.floor(complete.length / 2)))
  // The header still parses, so metadata() succeeds; only decoding fails, and
  // Strapi never checks AVIF because it does not recognize heif as an image.
  assert.ok((await sharp(filepath).metadata()).width)
  const file = () => ({ filepath, originalFilename: 'broken.avif', mimetype: 'image/avif', size: 10 })
  await assert.rejects(f.uploads.upload({ files: file() }), /Invalid image bytes/)
  f.uploads.findOne = async () => ({ mime: 'image/avif' })
  await assert.rejects(f.uploads.replace(1, { file: file() }), /Invalid image bytes/)
  assert.equal(f.saved.length, 0)
  const valid = path.join(f.dir, 'valid.avif')
  await fs.writeFile(valid, complete)
  const ok = await fixture(t, {})
  ok.uploads.findOne = async () => ({ mime: 'image/avif' })
  await ok.uploads.replace(1, { file: { filepath: valid, originalFilename: 'valid.avif', mimetype: 'image/avif', size: complete.length } })
  assert.equal(ok.saved.length, 1)
})

test('replacement resolves the incoming type from bytes, like the upload path does', async t => {
  const f = await fixture(t, {}, { convertToWebp: false })
  f.uploads.findOne = async () => ({ mime: 'image/png' })
  const file = await f.image('replacement.png')
  // Same file that upload accepts with no usable Content-Type must also be
  // accepted as a PNG -> PNG replacement.
  await f.uploads.replace(1, { file: { ...file, mimetype: 'application/octet-stream' } })
  assert.equal(f.saved.length, 1)
  assert.equal((await sharp(f.saved[0].buffer).metadata()).format, 'png')
  const webp = path.join(f.dir, 'other.webp')
  await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp().toFile(webp)
  await assert.rejects(f.uploads.replace(1, { file: { filepath: webp, originalFilename: 'other.webp', mimetype: 'application/octet-stream', size: 100 } }), /existing format/)
})

test('a type resolved from bytes is written back so Strapi stores it, in v4 and v5 shapes', async t => {
  for (const version of [4, 5]) {
    const f = await fixture(t, {}, { convertToWebp: false })
    const file = await f.image('unknown.png', version)
    if (version === 4) file.type = 'application/octet-stream'
    else file.mimetype = 'application/octet-stream'
    await f.uploads.upload({ files: file })
    // Strapi 4 has no detection of its own: without this the asset would be
    // stored as application/octet-stream and every guard keyed on the stored
    // type, such as the cross-format replacement check, would be inert.
    assert.equal(file.mimetype || file.type, 'image/png')
    assert.equal(f.saved.at(-1).mime, 'image/png')
  }
})
