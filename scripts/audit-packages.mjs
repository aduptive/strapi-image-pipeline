// Audit the runtime dependencies each distribution actually ships. The root
// manifest is tooling only, so `npm audit` there does not cover what a Strapi
// project installs.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

let failed = false
const report = []
for (const major of [4, 5]) {
  const manifest = JSON.parse(readFileSync(`packages/strapi${major}/package.json`))
  const dir = mkdtempSync(join(tmpdir(), `image-audit-${major}-`))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'audit-check', version: '0.0.0', private: true, dependencies: manifest.dependencies,
    }))
    execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe' })
    let output = '{}'
    try {
      output = execFileSync('npm', ['audit', '--json', '--audit-level=high'], { cwd: dir, encoding: 'utf8' })
    } catch (error) {
      output = error.stdout || '{}'
    }
    const { metadata } = JSON.parse(output)
    const counts = metadata?.vulnerabilities ?? {}
    const blocking = (counts.high ?? 0) + (counts.critical ?? 0)
    report.push({ distribution: `strapi${major}`, dependencies: manifest.dependencies, vulnerabilities: counts })
    console.log(`Strapi ${major}: runtime audit ${JSON.stringify(counts)}`)
    if (blocking > 0) failed = true
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/audit-packages.json', JSON.stringify({ date: new Date().toISOString(), report, passed: !failed }, null, 2))
if (failed) { console.error('High or critical vulnerabilities in shipped dependencies'); process.exit(1) }
