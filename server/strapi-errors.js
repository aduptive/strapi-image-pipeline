'use strict'
// Strapi maps thrown errors to HTTP statuses by `instanceof` against its own
// @strapi/utils. When the host is behind the latest release, npm installs a
// second copy next to this plugin, and every 400/413 becomes a 500. Use the
// copy the host's errors middleware loads: @strapi/core on v5, @strapi/strapi on v4.
const { createRequire } = require('node:module')
const path = require('node:path')

const resolve = () => {
  try {
    const root = globalThis.strapi?.dirs?.app?.root || process.cwd()
    const fromStrapi = createRequire(createRequire(path.join(root, 'package.json')).resolve('@strapi/strapi'))
    let owner = fromStrapi
    try { owner = createRequire(fromStrapi.resolve('@strapi/core')) } catch {}
    return owner('@strapi/utils').errors
  } catch {
    return require('@strapi/utils').errors
  }
}

let errors
module.exports = new Proxy({}, { get: (_, key) => (errors ||= resolve())[key] })
