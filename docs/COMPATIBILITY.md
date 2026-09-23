# Compatibility

Peer dependencies accept `@strapi/strapi >=4.24.0 <5` (v4 package) and
`>=5.0.0 <6` (v5 package). Alpha.2 ran the full HTTP, hooks, webhook,
permission and admin browser suite on **Strapi 4.24.0 and 4.26.1 / Node 20.11.0**,
**Strapi 5.0.0 / Node 20.11.0** and **Strapi 5.55.0 / Node 22.22.1**; alpha.1
was also checked on 5.52.1. The application under test uses SQLite.

The v4 floor is 4.24.0 because earlier upload plugins do not expose
`file.filepath` to the optimizer, so the plugin loads but never processes
anything. Strapi 4 below 4.14 cannot run on Node 20 at all. Sharp 0.35.4 requires Node >=20.9;
Node 18 is no longer declared supported.

| Distribution | Plugin version | Admin runtime |
| --- | --- | --- |
| `packages/strapi4` | `1.0.0-alpha.2` | Design System 1, React 18, styled-components 5 |
| `packages/strapi5` | `2.0.0-alpha.2` | Design System 2, React 18, styled-components 6 |

Versions inside those ranges but not listed above are expected to work; report
anything that does not.

Unit tests cover shared logic. The integration checks use the local upload
provider and SQLite; remote storage providers and other databases have not
been certified.
