# Compatibility

| Distribution | Plugin version | dist-tag | Strapi peer range | Verified on | Admin runtime |
| --- | --- | --- | --- | --- | --- |
| `packages/strapi4` | `1.0.0-alpha.3` | `alpha-v4` | `>=4.24.0 <5` | 4.24.0 and 4.26.1 / Node 20.11.0 | Design System 1, React 18, styled-components 5 |
| `packages/strapi5` | `2.0.0-alpha.3` | `latest` | `>=5.0.0 <6` | 5.0.0 / Node 20.11.0; 5.52.1 and 5.55.1 / Node 22.22.1 | Design System 2, React 18, styled-components 6 |

"Verified" means a fresh project installed with a plain `npm install` (no
overrides, no `--legacy-peer-deps`, zero peer/engine warnings), admin built,
and the full suite run against it: HTTP upload/settings (17 checks), hooks
(25), native media webhooks (7), settings permissions (6) and the admin
settings page in a browser. SQLite and the local upload provider only. Versions
inside the ranges but not listed are expected to work, not proven.

## Why these floors

- **Strapi 4.24.0**: earlier upload plugins (4.23.2 and below) stream files
  through `getStream()` and never expose `file.filepath`, which the optimizer
  needs; the plugin would load and process nothing.
- **Strapi 5.0.0**: every admin and server API the plugin uses exists there
  (`useFetchClient`, `useRBAC` with an array, relative settings links).
- **Node**: Sharp 0.35.4 needs Node >= 20.9. Strapi 5.0.0 itself declares
  Node <= 20, so test and run it on Node 20; later 5.x run on 22.

## Peer dependencies

The packages declare peers only on what a Strapi project lists itself:
`@strapi/strapi`, `react`, `react-dom`, `styled-components`. Packages that come
*with* `@strapi/strapi` (`@strapi/utils`, `@strapi/helper-plugin`,
`@strapi/design-system`, `react-intl`, `@strapi/admin`, ...) are not peers: npm
would install their newest release at the project root beside the host's own
copy, and the plugin's admin bundle would get a second React context (intl,
theme, RBAC) or code importing `@strapi/utils` a mismatched copy. Server-side,
`server/strapi-errors.js` resolves `@strapi/utils` through the host's
`@strapi/strapi`, so thrown errors keep their 400/413 statuses.

## Old hosts and today's npm

Strapi 5.0.0 needs `"@strapi/email": "5.0.0"` in the project's dependencies:
a fresh install nests it under `@strapi/strapi` and `strapi start` fails with
"@strapi/email/package.json couldn't be resolved". It happens without the
plugin installed; a real 5.0.0 project has it pinned by its lockfile.

Unit tests cover shared logic. Remote storage providers and other databases
have not been certified.
