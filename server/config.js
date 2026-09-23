'use strict'

// Default settings. These are the seed values; the live values are stored in
// Strapi's plugin store (DB) and editable from the admin Settings page at
// runtime, so a project can tune them without a redeploy.
const defaults = {
  // Master switch. When false the plugin is fully inert (no reject, no resize,
  // no conversion) — uploads behave like vanilla Strapi. Emergency brake.
  enabled: true,
  // Reject image uploads larger than this (megabytes).
  maxFileSizeMB: 5,
  // Longest side (px) allowed for stored raster images (no upscaling).
  maxDimension: 1600,
  // Encode quality (1-100) for WebP / re-encoded originals.
  quality: 80,
  // When true, raster images are converted to WebP. When false, the original
  // format is kept (JPEG->JPEG, PNG->PNG) and only resized/re-encoded.
  convertToWebp: true,
  // Advanced: reject images whose pixel count (w*h) exceeds this many millions
  // of pixels (decompression-bomb guard). 0 disables the check.
  maxMegapixels: 0,
  // Strip scripts/event-handlers/external refs from uploaded SVGs (anti-XSS).
  // Keep this on when uploads can come from untrusted/public sources.
  sanitizeSvg: true,
  // Minify uploaded SVGs with SVGO.
  optimizeSvg: true,
  addSvgViewBox: false,
  responsiveSvg: false,
}

module.exports = {
  default: { ...defaults, hooks: {}, hookTimeoutMs: 30000 },
  validator: require('./hooks').validateHooks,
}

module.exports.defaults = defaults
