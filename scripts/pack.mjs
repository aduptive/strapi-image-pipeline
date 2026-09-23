import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
mkdirSync('artifacts', { recursive: true });
for (const major of [4, 5]) execFileSync('npm', ['pack', '--pack-destination', resolve('artifacts')], { cwd: `packages/strapi${major}`, stdio: 'inherit' });
