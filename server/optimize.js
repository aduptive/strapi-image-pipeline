'use strict'

const fs = require('node:fs')
const path = require('node:path')

const sharp = require('sharp')
const { errors } = require('@strapi/utils')

const BYTES_PER_KB = 1000
const KB_ROUNDING = 100
const PIXELS_PER_MEGAPIXEL = 1_000_000

// Mirror Strapi's bytesToKbytes so the stored `size` field stays consistent.
const bytesToKbytes = (bytes) =>
  Math.round((bytes / BYTES_PER_KB) * KB_ROUNDING) / KB_ROUNDING

const replaceExtension = (name, ext) => {
  if (typeof name !== 'string' || name.length === 0) return name
  return `${name.replace(/\.[^./\\]+$/, '')}${ext}`
}

/**
 * Build a replacement for the upload plugin's `optimize`.
 *
 * Reads the live settings on every call (so toggling them in the admin takes
 * effect immediately). When enabled, raster images are downscaled to
 * `maxDimension` on the longer side (never upscaling) and either converted to
 * WebP or re-encoded in their original format (`convertToWebp`). An optional
 * `maxMegapixels` guard rejects decompression bombs.
 *
 * Strapi only calls `optimize` for optimizable rasters (jpeg/png/webp/tiff/avif),
 * so SVG and GIF never reach this code. On any failure it falls back to the
 * original optimize so uploads never break.
 */
const createOptimize = ({ strapi, originalOptimize, getSettings }) =>
  async function optimize(file) {
    if (!file || !file.filepath) return originalOptimize(file)

    const settings = await getSettings()
    // Master switch off -> behave exactly like vanilla Strapi.
    if (!settings.enabled) return originalOptimize(file)

    let metadata
    try {
      metadata = await sharp(file.filepath).metadata()
    } catch (error) {
      // Unreadable as an image -> let Strapi's default path handle it.
      return originalOptimize(file)
    }

    const width = metadata.width || 0
    const height = metadata.height || 0

    // Decompression-bomb guard (rejects the upload; thrown outside the
    // try/catch below so it is NOT swallowed by the fallback).
    if (
      settings.maxMegapixels > 0 &&
      width * height > settings.maxMegapixels * PIXELS_PER_MEGAPIXEL
    ) {
      throw new errors.PayloadTooLargeError(
        `Image is too large (${width}x${height}px); exceeds the ${settings.maxMegapixels} megapixel limit.`
      )
    }

    // Preserve animated images instead of flattening them to their first frame.
    if ((metadata.pages || 1) > 1) return file

    try {
      const outputPath = file.tmpWorkingDirectory
        ? path.join(file.tmpWorkingDirectory, `optimized-${file.hash}`)
        : `optimized-${file.hash}`

      let pipeline = sharp(file.filepath).rotate() // auto-orient via EXIF
      if (width > settings.maxDimension || height > settings.maxDimension) {
        pipeline = pipeline.resize(settings.maxDimension, settings.maxDimension, {
          fit: 'inside',
          withoutEnlargement: true,
        })
      }

      const keepFormat = !settings.convertToWebp
      // PNG is lossless: sharp's `quality` there means "quantise to the fewest
      // colours that reach this quality", which silently destroys gradients and
      // can even grow the file. Re-encode PNG losslessly instead, keeping an
      // already-indexed image indexed so it does not balloon to truecolor.
      // `quality` is the right knob for JPEG/WebP/TIFF/AVIF and stays there.
      // Sharp reports AVIF as `heif`, and `toFormat('heif')` throws because the
      // compression must be av1. Encoding it as AVIF keeps the format instead
      // of failing into the fallback and storing the untouched original.
      const isAvif = metadata.format === 'heif' && metadata.compression === 'av1'
      pipeline = !keepFormat && !isAvif
        ? pipeline.webp({ quality: settings.quality })
        : isAvif
          ? pipeline.avif({ quality: settings.quality })
          : metadata.format === 'png'
            ? pipeline.png({ palette: metadata.isPalette === true })
            : pipeline.toFormat(metadata.format, { quality: settings.quality })

      const info = await pipeline.toFile(outputPath)

      const optimizedFile = {
        ...file,
        filepath: outputPath,
        getStream: () => fs.createReadStream(outputPath),
        width: info.width,
        height: info.height,
        size: bytesToKbytes(info.size),
        sizeInBytes: info.size,
      }

      // Only rewrite the format metadata when actually converting to WebP.
      if (!keepFormat && !isAvif) {
        optimizedFile.ext = '.webp'
        optimizedFile.mime = 'image/webp'
        optimizedFile.name = replaceExtension(file.name, '.webp')
      }

      return optimizedFile
    } catch (error) {
      strapi.log.error(
        '[image-pipeline] failed, falling back to default optimize',
        error
      )
      return originalOptimize(file)
    }
  }

module.exports = { createOptimize, replaceExtension, bytesToKbytes }
