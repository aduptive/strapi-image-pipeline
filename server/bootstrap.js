'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')
const errors = require('./strapi-errors')
const sharp = require('sharp')
const { createOptimize } = require('./optimize')
const { processSvg } = require('./svg')
const { createRunHook, checkSize, checkPixels, imageMime, declaredMime, replaceInPlace } = require('./hooks')

// Strapi reports these through `isImage`/`isOptimizableImage` as "not an image"
// or "not optimizable", so its own optimizer never sees them: SVG and GIF by
// design, AVIF because Sharp reports its format as `heif`. Without this list
// they would reach storage untouched, skipping guards, resizing and hooks.
const SELF_PROCESSED = ['image/svg+xml', 'image/gif', 'image/avif']

module.exports = async ({ strapi }) => {
  await strapi.admin.services.permission.actionProvider.registerMany([
    { section: 'plugins', displayName: 'Read settings', uid: 'read', pluginName: 'image-pipeline' },
    { section: 'plugins', displayName: 'Change settings', uid: 'update', pluginName: 'image-pipeline' },
  ])
  const request = new AsyncLocalStorage()
  const plugin = strapi.plugin('image-pipeline')
  const runHook = createRunHook({ strapi, hooks: plugin.config('hooks', {}), hookTimeoutMs: plugin.config('hookTimeoutMs', 30000) })
  const getSettings = () => strapi.plugin('image-pipeline').service('settings').get()
  const uploads = strapi.plugin('upload').service('upload')
  const manipulation = strapi.plugin('upload').service('image-manipulation')
  if (!uploads?.upload || !uploads?.replace || !manipulation?.optimize) {
    throw new Error('[image-pipeline] Unsupported Strapi upload service')
  }
  // Strapi rejects a batch as soon as one file fails, while the other files of
  // that batch keep running: their optimization, thumbnails and provider upload
  // are still reading files afterwards. Nothing here may delete a file on that
  // timeline, so the plugin owns no file that Strapi is going to read:
  //   - before Strapi has a working directory, processed bytes replace the
  //     incoming request file in place, adding no file at all;
  //   - during the pipeline, hook output is written inside Strapi's own
  //     `tmpWorkingDirectory`, which Strapi removes in its own finally, after
  //     the whole call, exactly as it does for its `optimized-*` files.
  // `temporaryFiles` therefore stays empty inside an upload; it only collects
  // files written when the hook runner is used outside Strapi's pipeline.
  async function withOperation(settings, operation, action) {
    const context = { settings, operation, temporaryFiles: [], processed: new Set() }
    try { return await request.run(context, action) }
    finally {
      const written = context.temporaryFiles.splice(0)
      await Promise.all(written.map(filepath => fs.rm(filepath, { force: true })))
    }
  }
  // One MIME answer per file, from the bytes, reused by upload and replacement.
  async function resolveMime(file) {
    const filepath = file?.filepath || file?.path
    const metadata = filepath ? await sharp(filepath).metadata().catch(() => null) : null
    const detected = imageMime(metadata)
    // Bytes decide; the client's Content-Type is only a claim, and Strapi 5
    // treats application/octet-stream as undeclared for the same reason.
    const declared = declaredMime(file)
    return { filepath, metadata, detected, declared, mime: declared || detected || '' }
  }
  async function prepare(file, settings, operation, resolved) {
    if (!settings.enabled || !file) return
    const { filepath, metadata, detected: detectedMime, declared, mime } = resolved || await resolveMime(file)
    // When the type came from the bytes, tell Strapi: otherwise Strapi 4, which
    // has no detection of its own, would store the processed image as
    // application/octet-stream and the guards keyed on the stored type (such as
    // the cross-format replacement check) would never apply to it.
    if (!declared && detectedMime) {
      if (file.filepath !== undefined || file.mimetype !== undefined) file.mimetype = detectedMime
      else file.type = detectedMime
    }
    if (path.extname(file.originalFilename || file.name || '').toLowerCase() === '.svg' && mime !== 'image/svg+xml') {
      throw new errors.ValidationError('SVG files must declare image/svg+xml.')
    }
    if (mime.startsWith('image/') && file.size > settings.maxFileSizeMB * 1024 * 1024) {
      throw new errors.PayloadTooLargeError(`Image exceeds the ${settings.maxFileSizeMB} MB limit.`)
    }
    if (mime.startsWith('image/') && filepath) checkSize((await fs.stat(filepath)).size, settings)
    if (filepath) {
      if (!metadata && mime.startsWith('image/') && mime !== 'image/svg+xml') {
        throw new errors.ValidationError('Invalid image bytes.')
      }
      if (detectedMime && detectedMime !== mime) {
        throw new errors.ValidationError('Image bytes do not match the declared MIME type.')
      }
      if (metadata && detectedMime) checkPixels(metadata, settings)
    }
    if (filepath && SELF_PROCESSED.includes(mime)) {
      const name = file.originalFilename || file.name || ''
      const store = request.getStore()
      const context = { ...store, settings, operation, original: Object.freeze({ name, mime }) }
      // Everything happens on bytes; the result replaces the request file in
      // place, so this path never creates a file of its own.
      let image = { buffer: await fs.readFile(filepath), mime, name }
      // Strapi runs isFaultyImage on the formats it recognizes, but not on
      // AVIF, so a truncated file whose header still parses would be stored.
      // Decoding it here is the same check, applied where Strapi skips it.
      if (mime === 'image/avif') {
        try { await sharp(image.buffer).stats() }
        catch { throw new errors.ValidationError('Invalid image bytes.') }
      }
      if (mime === 'image/svg+xml' && settings.sanitizeSvg) {
        image = { ...image, buffer: Buffer.from(processSvg(image.buffer.toString('utf8'), { sanitize: true })) }
      }
      image = await runHook('beforeProcess', image, context)
      if (mime === 'image/svg+xml') {
        image = { ...image, buffer: Buffer.from(processSvg(image.buffer.toString('utf8'), {
          sanitize: settings.sanitizeSvg, optimize: settings.optimizeSvg,
          addViewBox: settings.addSvgViewBox, responsive: settings.responsiveSvg,
        })) }
      }
      // AVIF never reaches Strapi's optimizer, so the size limit is applied
      // here. Untouched AVIF is left alone rather than re-encoded, which would
      // lose quality for nothing; conversion to WebP is not applied to it.
      if (mime === 'image/avif') {
        const current = await sharp(image.buffer).metadata()
        if (Math.max(current.width || 0, current.height || 0) > settings.maxDimension) {
          image = { ...image, buffer: await sharp(image.buffer).rotate()
            .resize(settings.maxDimension, settings.maxDimension, { fit: 'inside', withoutEnlargement: true })
            .avif({ quality: settings.quality }).toBuffer() }
        }
      }
      image = await runHook('afterProcess', image, context)
      await replaceInPlace(filepath, image.buffer)
      file.size = image.buffer.length
      // If a future Strapi starts optimizing these formats, do not run twice.
      context.processed?.add(filepath)
    }
  }
  const upload = uploads.upload.bind(uploads)
  uploads.upload = async (params, opts) => {
    const settings = await getSettings()
    const files = Array.isArray(params?.files) ? params.files : [params?.files]
    return withOperation(settings, 'upload', async () => {
      for (const file of files) await prepare(file, settings, 'upload')
      return upload(params, opts)
    })
  }
  if (uploads.uploadToEntity) {
    const uploadToEntity = uploads.uploadToEntity.bind(uploads)
    uploads.uploadToEntity = async (params, files) => {
      const settings = await getSettings()
      return withOperation(settings, 'upload', async () => {
        for (const file of Array.isArray(files) ? files : [files]) await prepare(file, settings, 'upload')
        return uploadToEntity(params, files)
      })
    }
  }
  const replace = uploads.replace.bind(uploads)
  uploads.replace = async (id, params, opts) => {
    const settings = await getSettings()
    if (!settings.enabled) return replace(id, params, opts)
    const existing = await uploads.findOne(id)
    // Resolve the incoming type from its bytes first: an upload with no usable
    // Content-Type is accepted on creation, so it must also be comparable here.
    const resolved = params?.file ? await resolveMime(params.file) : { mime: '' }
    // Strapi retains the old extension on replacement. Reject cross-format
    // replacement before deletion rather than storing mismatched bytes and MIME.
    if (existing?.mime?.startsWith('image/') && resolved.mime !== existing.mime) {
      throw new errors.ValidationError('Replacement images must use the existing format. Upload a new asset to change format.')
    }
    const replacementSettings = { ...settings, convertToWebp: false }
    return withOperation(replacementSettings, 'replace', async () => {
      await prepare(params?.file, replacementSettings, 'replace', resolved)
      return replace(id, params, opts)
    })
  }
  const currentSettings = () => request.getStore()?.settings || getSettings()
  const optimize = createOptimize({ strapi,
    originalOptimize: manipulation.optimize.bind(manipulation),
    getSettings: currentSettings,
  })
  manipulation.optimize = async file => {
    const settings = await currentSettings()
    const store = request.getStore()
    if (!settings.enabled || !file?.filepath || !store || store.processed?.has(file.filepath)) return optimize(file)
    const context = { ...store, settings, original: Object.freeze({ name: file.name, mime: file.mime }) }
    const input = await runHook('beforeProcess', file, context)
    const output = await optimize(input)
    return runHook('afterProcess', output, context)
  }
}
