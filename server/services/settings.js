'use strict'

const { defaults } = require('../config')

const getStore = (strapi) =>
  strapi.store({ type: 'plugin', name: 'image-pipeline' })

const toBool = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback

const toInt = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// Coerce/clamp incoming settings so the store never holds invalid values.
const sanitize = (input = {}) => ({
  enabled: toBool(input.enabled, defaults.enabled),
  maxFileSizeMB: toInt(input.maxFileSizeMB, defaults.maxFileSizeMB, { min: 1, max: 1024 }),
  maxDimension: toInt(input.maxDimension, defaults.maxDimension, { min: 1, max: 20000 }),
  quality: toInt(input.quality, defaults.quality, { min: 1, max: 100 }),
  convertToWebp: toBool(input.convertToWebp, defaults.convertToWebp),
  maxMegapixels: toInt(input.maxMegapixels, defaults.maxMegapixels, { min: 0, max: 1000 }),
  sanitizeSvg: toBool(input.sanitizeSvg, defaults.sanitizeSvg),
  optimizeSvg: toBool(input.optimizeSvg, defaults.optimizeSvg),
  addSvgViewBox: toBool(input.addSvgViewBox, defaults.addSvgViewBox),
  responsiveSvg: toBool(input.responsiveSvg, defaults.responsiveSvg),
})

module.exports = ({ strapi }) => ({
  async get() {
    const saved = (await getStore(strapi).get({ key: 'settings' })) || {}
    return sanitize({ ...defaults, ...Object.fromEntries(Object.keys(defaults).map(key => [key, strapi.plugin('image-pipeline').config(key, defaults[key])])), ...saved })
  },

  async set(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const errors = require('../strapi-errors')
      throw new errors.ValidationError('Settings must be an object')
    }
    const next = sanitize({ ...(await this.get()), ...value })
    await getStore(strapi).set({ key: 'settings', value: next })
    return next
  },

  defaults() {
    return { ...defaults }
  },
})
