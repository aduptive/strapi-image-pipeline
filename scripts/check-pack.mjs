import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const major of [4, 5]) {
 const manifest = JSON.parse(readFileSync(`packages/strapi${major}/package.json`));
 assert.equal(manifest.exports['./strapi-server'].require, './strapi-server.js', 'Strapi config loader needs a .js entrypoint');
 const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: `packages/strapi${major}`, encoding: 'utf8' }));
 const files = pack.files.map(file => file.path);
 assert.ok(files.includes('dist/admin.mjs') && files.includes('dist/admin.cjs') && files.includes('dist/server.cjs'));
 assert.ok(files.includes('dist/hooks.d.ts'));
 assert.ok(files.includes('LICENSE'), 'The published package must carry its license');
 assert.equal(manifest.license, 'MIT');
 assert.equal(manifest.exports['./hooks'].types, './dist/hooks.d.ts');
 assert.ok(files.every(file => /^(dist\/|strapi-(admin|server)\.js$|package\.json$|README\.md$|LICENSE$)/.test(file)), 'Unexpected package contents');
 assert.ok(!files.some(file => /(?:\.env|sqlite|lab-access|node_modules)/.test(file)));
 console.log(`Strapi ${major}: tarball allowlist OK (${files.length} files)`);
}
