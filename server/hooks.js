'use strict'

const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const sharp = require('sharp')
const errors = require('./strapi-errors')
const { bytesToKbytes } = require('./optimize')
const { sanitizeSvg } = require('./svg')

const EVENTS = ['beforeProcess', 'afterProcess']
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tiff: 'image/tiff', gif: 'image/gif', svg: 'image/svg+xml' }
const imageMime = metadata => metadata?.format === 'heif' && metadata.compression === 'av1' ? 'image/avif' : MIME[metadata?.format]

// A client can send no Content-Type at all. Strapi 5 sniffs the bytes into
// `detectedMimeType` and treats application/octet-stream as undeclared; do the
// same instead of rejecting a valid image for an unhelpful header.
const UNDECLARED = new Set(['', 'application/octet-stream', 'binary/octet-stream'])
const declaredMime = file => {
  const declared = (file?.mimetype || file?.type || file?.mime || '').toLowerCase()
  if (!UNDECLARED.has(declared)) return declared
  const detected = (file?.detectedMimeType || '').toLowerCase()
  return UNDECLARED.has(detected) ? '' : detected
}

const validateHooks = ({ hooks = {}, hookTimeoutMs = 30000 }) => {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('image-pipeline.hooks must be an object')
  for (const [event, handler] of Object.entries(hooks)) {
    if (!EVENTS.includes(event) || typeof handler !== 'function') throw new Error(`Invalid image-pipeline hook: ${event}`)
  }
  if (!Number.isInteger(hookTimeoutMs) || hookTimeoutMs < 1 || hookTimeoutMs > 300000) {
    throw new Error('image-pipeline.hookTimeoutMs must be between 1 and 300000 milliseconds')
  }
}

const checkSize = (size, settings) => {
  if (size > settings.maxFileSizeMB * 1024 * 1024) throw new errors.PayloadTooLargeError('Image exceeds the configured file size limit.')
}

const checkPixels = ({ width, height, pageHeight, pages = 1 }, settings) => {
  if (settings.maxMegapixels > 0 && width * (pageHeight || height) * pages > settings.maxMegapixels * 1_000_000) {
    throw new errors.PayloadTooLargeError('Image exceeds the configured megapixel limit.')
  }
}

// Unique paths avoid libvips reusing cached input after a callback changes bytes.
// Inside Strapi this lands in the per-request `tmpWorkingDirectory`, which
// Strapi creates and removes around the whole upload/replace call, so the file
// outlives every reader it hands it to (optimizer, thumbnails, provider) and is
// not ours to delete. Only when that directory is absent, which happens when
// the runner is used outside an upload, do we track the file for cleanup.
const writeImage = async (file, buffer, temporaryFiles) => {
  const owned = !file.tmpWorkingDirectory
  const filepath = path.join(file.tmpWorkingDirectory || path.dirname(file.filepath), `image-hook-${randomUUID()}`)
  if (owned && temporaryFiles) temporaryFiles.push(filepath)
  await fs.writeFile(filepath, buffer, { flag: 'wx' })
  return { ...file, filepath, getStream: () => createReadStream(filepath) }
}

// Atomic in-place replacement: write beside the target, then rename over it.
// Used before Strapi has a working directory of its own, so the pipeline adds
// no file that anyone would have to clean up or could delete too early.
const replaceInPlace = async (filepath, buffer) => {
  const staging = `${filepath}.image-pipeline-${randomUUID()}`
  try {
    await fs.writeFile(staging, buffer, { flag: 'wx' })
    await fs.rename(staging, filepath)
  } catch (error) {
    await fs.rm(staging, { force: true })
    throw error
  }
}

const inspect = async (buffer, settings) => {
  checkSize(buffer.length, settings)
  let metadata
  try { metadata = await sharp(buffer).metadata() }
  catch { throw new errors.ValidationError('Image hook requires a valid supported image.') }
  const { width, height, pageHeight, pages = 1 } = metadata
  checkPixels(metadata, settings)
  const mime = imageMime(metadata)
  if (!mime) throw new errors.ValidationError('Unsupported image format returned by hook.')
  return { mime, width, height: pageHeight || height, pages }
}

const createRunHook = ({ strapi, hooks = {}, hookTimeoutMs = 30000 }) => {
  validateHooks({ hooks, hookTimeoutMs })
  return async (event, file, { settings, operation, original, temporaryFiles }) => {
    const handler = hooks[event]
    if (!handler) return file
    // Two shapes: a file on disk (Strapi's pipeline) or bytes in hand (before
    // Strapi has a working directory). The bytes shape writes nothing.
    const inMemory = Buffer.isBuffer(file.buffer)
    if (!inMemory) checkSize((await fs.stat(file.filepath)).size, settings)
    const buffer = inMemory ? file.buffer : await fs.readFile(file.filepath)
    const metadata = await inspect(buffer, settings)
    // Undeclared uploads are typed from their bytes, exactly like Strapi does.
    const declared = declaredMime(file)
    if (declared && metadata.mime !== declared) throw new errors.ValidationError('Image bytes do not match the declared MIME type.')
    const mime = declared || metadata.mime
    const controller = new AbortController()
    let timer
    let result
    try {
      result = await Promise.race([
        Promise.resolve().then(() => handler(Object.freeze({
          event, operation, original, settings: Object.freeze({ ...settings }), strapi, sharp,
          signal: controller.signal,
          image: Object.freeze({ ...metadata, name: file.name, size: buffer.length, buffer }),
        }))),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Image hook timed out'))
          }, hookTimeoutMs)
        }),
      ])
    } catch (error) {
      strapi.log.error(`[image-pipeline] ${event} failed`, error)
      throw new errors.ApplicationError(`Image hook ${event} failed; the image was not saved.`)
    } finally { clearTimeout(timer) }
    // Returning nothing leaves the file unchanged, even if the callback mutated its buffer.
    if (result === undefined) return file
    if (!Buffer.isBuffer(result) || !result.length) throw new errors.ValidationError(`Image hook ${event} must return a nonempty Buffer or undefined.`)
    // The callback may retain its buffer; subsequent writes must use our own copy.
    checkSize(result.length, settings)
    let output = Buffer.from(result)
    if (mime === 'image/svg+xml' && settings.sanitizeSvg) output = Buffer.from(sanitizeSvg(output.toString('utf8')))
    const next = await inspect(output, settings)
    if (next.mime !== mime) throw new errors.ValidationError('Image hooks must preserve the image format. Use convertToWebp for conversion.')
    if (event === 'afterProcess' && next.mime !== 'image/svg+xml' && Math.max(next.width, next.height) > settings.maxDimension) {
      throw new errors.ValidationError('Image hook output exceeds the maximum dimension.')
    }
    try { await sharp(output).stats() }
    catch { throw new errors.ValidationError('Image hook returned a corrupt image.') }
    const measured = { width: next.width, height: next.height, size: bytesToKbytes(output.length), sizeInBytes: output.length }
    if (inMemory) return { ...file, ...measured, buffer: output }
    const updated = await writeImage(file, output, temporaryFiles)
    return { ...updated, ...measured }
  }
}

module.exports = { createRunHook, validateHooks, checkSize, checkPixels, imageMime, declaredMime, writeImage, replaceInPlace }
