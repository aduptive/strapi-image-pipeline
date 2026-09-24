// Install each built tarball into a throwaway project and load the server
// entrypoint the way Strapi's config loader does. Catches a broken `files`
// list, a missing wrapper or an unresolvable runtime dependency.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

for (const major of [4, 5]) {
  const { version } = JSON.parse(readFileSync(`packages/strapi${major}/package.json`))
  const tarball = resolve(`artifacts/aduptive-strapi-image-pipeline-${version}.tgz`)
  assert.ok(existsSync(tarball), `Missing tarball: run npm run pack:local first (${tarball})`)
  const dir = mkdtempSync(join(tmpdir(), `image-install-${major}-`))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'install-check', version: '0.0.0', private: true }))
    // A bare project has no Strapi, so npm would try to resolve the whole peer
    // tree. Install the tarball without peers and add only the one runtime peer
    // the server bundle requires, at the version this distribution targets.
    const utils = `@strapi/utils@${major === 4 ? '4.26.1' : '5.52.1'}`
    execFileSync('npm', ['install', tarball, utils, '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: 'pipe' })
    const probe = join(dir, 'probe.cjs')
    writeFileSync(probe, `
      const path = require.resolve('@aduptive/strapi-image-pipeline/strapi-server', { paths: [${JSON.stringify(dir)}] })
      const factory = require(path)
      const plugin = typeof factory === 'function' ? factory() : factory
      const missing = ['bootstrap', 'config', 'routes', 'controllers', 'services'].filter(key => !(key in plugin))
      if (missing.length) throw new Error('Missing plugin keys: ' + missing)
      if (typeof plugin.config.validator !== 'function') throw new Error('Missing hook config validator')
      if (plugin.config.default.quality !== 80) throw new Error('Unexpected default settings')
      console.log('server entrypoint loaded')
    `)
    execFileSync(process.execPath, [probe], { cwd: dir, stdio: 'pipe' })
    const installed = JSON.parse(execFileSync('npm', ['ls', '@aduptive/strapi-image-pipeline', '--json'], { cwd: dir, encoding: 'utf8' }))
    assert.equal(installed.dependencies['@aduptive/strapi-image-pipeline'].version, version)
    console.log(`Strapi ${major}: tarball ${version} installs and loads in a clean project`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
