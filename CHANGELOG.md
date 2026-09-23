# Changelog

## 1.0.0-alpha.2 / 2.0.0-alpha.2

- Accept any Strapi 5 (`>=5.0.0 <6`) and Strapi 4.24+ (`>=4.24.0 <5`); exact pins made npm fail with ERESOLVE on any other version (e.g. 5.55.0). Full suite run on 4.24.0, 4.26.1, 5.0.0 and 5.55.0.
- Drop the unused `@strapi/admin` and `@strapi/content-manager` peers: with open ranges npm installed their latest release beside an older host and broke its admin build.
- Throw errors with the host's own `@strapi/utils`, so validation failures stay 400/413 instead of 500 when npm installs a second copy next to the plugin.

## 1.0.0-alpha.1 / 2.0.0-alpha.1

Initial public alpha of Image Pipeline for Strapi 4 and Strapi 5, respectively.

- Resize and optimize uploads; optionally convert supported raster images to WebP.
- Sanitize and minify SVG, with optional viewBox and responsive dimensions.
- Run typed `beforeProcess` and `afterProcess` hooks to transform or reject images before storage.
- Support AVIF, GIF and SVG paths that Strapi does not send through its raster optimizer.
- Validate MIME and image bytes, enforce size and pixel limits, and keep PNG lossless when WebP conversion is disabled.
- Protect runtime settings with Strapi admin permissions; use Strapi's native media webhooks for external integrations.
- Test the packages on Strapi 4.26.1 / Node 20.11.0 and Strapi 5.52.1 / Node 22.22.1 with the local upload provider and SQLite.

Remote providers and other Strapi versions have not been certified. Failed multi-file uploads can leave partial results because Strapi processes batch items concurrently.
