# Compatibility

The initial alpha is tested on **Strapi 4.26.1 / Node 20.11.0** and
**Strapi 5.52.1 / Node 22.22.1**. Peer dependencies are intentionally exact
until more versions have runtime evidence. The application under test uses SQLite. Sharp 0.35.4 requires Node >=20.9;
Node 18 is no longer declared supported.

| Distribution | Plugin version | Admin runtime |
| --- | --- | --- |
| `packages/strapi4` | `1.0.0-alpha.1` | Design System 1, React 18, styled-components 5 |
| `packages/strapi5` | `2.0.0-alpha.1` | Design System 2, React 18, styled-components 6 |

Other Strapi 4.x and 5.x versions need their own installation and upload checks
before being claimed as supported.

Unit tests cover shared logic. The integration checks use the local upload
provider and SQLite; remote storage providers and other databases have not
been certified.
