'use strict'

const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')
const { optimize: svgoOptimize } = require('svgo')

// A single jsdom window is enough — DOMPurify reuses it for every sanitize call.
const { window } = new JSDOM('')
const DOMPurify = createDOMPurify(window)

// Href values we keep on <use>/<image>/etc.: internal fragment references and
// embedded *raster* data URIs (what Figma-exported SVGs use:
// pattern -> <use href="#img"> -> <image href="data:image/png;base64,...">).
// Everything else (javascript:, external http(s), data:image/svg+xml, data:text)
// is dropped — that blocks scripts, SSRF and nested-SVG XSS while keeping real
// artwork intact.
const SAFE_HREF = /^#|^data:image\/(?:png|jpe?g|gif|webp);base64,/i

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'href' || data.attrName === 'xlink:href') {
    data.keepAttr = SAFE_HREF.test((data.attrValue || '').trim())
  }
  if (/url\s*\(/i.test(data.attrValue || '') && !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(data.attrValue.trim())) {
    data.keepAttr = false
  }
})

/**
 * Strip anything executable from an SVG (scripts, event handlers, unsafe URLs),
 * while preserving `<use>`/`<image>` with internal or embedded-raster refs.
 * SVG is XML and can carry stored XSS, and Strapi does not sanitize it by
 * default — important when uploads may come from untrusted/public sources.
 */
const sanitizeSvg = (svg) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['style', 'animate', 'set', 'animateTransform', 'animateMotion', 'foreignObject'],
    FORBID_ATTR: ['style'],
    ADD_TAGS: ['use'],
    ADD_ATTR: ['href', 'xlink:href', 'role'],
  })

// SVG numbers, not JavaScript coercions such as hexadecimal or Infinity.
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
const DIMENSION = new RegExp(`^(${NUMBER})(?:px)?$`)
const SEPARATOR = '(?:[\\t\\n\\r ]*,[\\t\\n\\r ]*|[\\t\\n\\r ]+)'
const VIEW_BOX = new RegExp(`^${NUMBER}(?:${SEPARATOR}${NUMBER}){3}$`)

const transformDimensions = (svg, { addViewBox, responsive }) => svgoOptimize(svg, {
  plugins: [{ name: 'svgDimensions', fn: () => ({ element: { enter(node, parent) {
    if (node.name !== 'svg' || parent.type !== 'root') return
    const attrs = node.attributes
    if (addViewBox && attrs.viewBox === undefined) {
      const dimensions = [attrs.width, attrs.height].map(value => Number(DIMENSION.exec((value || '').trim())?.[1]))
      if (dimensions.every(value => Number.isFinite(value) && value > 0)) {
        attrs.viewBox = `0 0 ${dimensions.join(' ')}`
      }
    }
    const viewBox = (attrs.viewBox || '').trim()
    const values = viewBox.split(/[\s,]+/).map(Number)
    if (responsive && VIEW_BOX.test(viewBox) && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
      delete attrs.width
      delete attrs.height
    }
  } } }) }],
}).data

/** Keep reference names and accessibility text while minifying. */
const minifySvg = (svg) => svgoOptimize(svg, { multipass: true, plugins: [{
  name: 'preset-default', params: { overrides: {
    cleanupIds: false, removeDesc: false,
    // Rounding a tiny positive viewport to zero makes responsive SVGs invisible.
    cleanupNumericValues: false,
    removeUnknownsAndDefaults: { defaultAttrs: false, keepRoleAttr: true },
  } },
}] }).data

/**
 * Process an SVG string: sanitize first (security), then minify (size).
 * Sanitization errors propagate (so the upload is rejected rather than storing
 * something unsafe); minification errors fall back to the sanitized SVG.
 */
const processSvg = (svg, { sanitize, optimize, addViewBox, responsive }) => {
  let output = svg
  if (sanitize) {
    output = sanitizeSvg(output)
  }
  if (addViewBox || responsive) {
    try {
      output = transformDimensions(output, { addViewBox, responsive })
    } catch (error) {
      // Invalid XML keeps the sanitized output, like failed minification.
    }
  }
  if (optimize) {
    try {
      output = minifySvg(output)
    } catch (error) {
      // Keep the sanitized (or original) SVG if minification fails.
    }
  }
  return output
}

module.exports = { processSvg, sanitizeSvg, minifySvg }
