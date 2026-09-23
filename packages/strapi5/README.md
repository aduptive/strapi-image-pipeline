# Strapi Image Pipeline

Resize and optimize images during Strapi uploads, with optional WebP conversion
and SVG sanitization/minification. Transform or reject images with server-side
hooks before they are stored.

MIT licensed. See [compatibility](https://github.com/aduptive/strapi-image-pipeline/blob/main/docs/COMPATIBILITY.md)
and [report issues](https://github.com/aduptive/strapi-image-pipeline/issues) on GitHub.

Supported: Strapi 4.24+ and Strapi 5.x. Tested on Strapi 4.24.0 and 4.26.1
(Node 20.11.0), 5.0.0 (Node 20.11.0), 5.52.1 and 5.55.0 (Node 22.22.1), with
the local upload provider and SQLite. Remote providers are not certified.

## Install

Install the version matching your Strapi major, then enable the plugin in your application:

```sh
# Strapi 4.24+ / Node 20
npm install @aduptive/strapi-image-pipeline@1.0.0-alpha.2
# Strapi 5 / Node 20 or 22
npm install @aduptive/strapi-image-pipeline@2.0.0-alpha.2
```

Enable in `config/plugins.js`, then rebuild/restart the admin:

```js
module.exports = {
  'image-pipeline': {
    enabled: true,
    config: { maxDimension: 1600, quality: 80, convertToWebp: true },
  },
}
```

Use **Settings → Image Pipeline** to edit runtime settings. Grant the
plugin's read/change-settings permissions to administrator roles as needed.
Saved settings override config defaults. Changing settings affects future
uploads; it does not rewrite existing Media Library assets.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; false delegates unchanged to Strapi |
| `maxFileSizeMB` | `5` | Reject oversized image uploads before processing |
| `maxDimension` | `1600` | Maximum longest side, without upscaling |
| `quality` | `80` | Encoding quality 1–100 for JPEG/WebP/TIFF/AVIF; PNG stays lossless |
| `convertToWebp` | `true` | Convert new optimizable raster uploads to WebP |
| `maxMegapixels` | `0` | Raster pixel limit; zero disables this extra limit |
| `sanitizeSvg` | `true` | Remove executable/unsafe SVG content |
| `optimizeSvg` | `true` | Minify SVG with SVGO |
| `addSvgViewBox` | `false` | Add a missing viewBox from positive numeric or px width/height |
| `responsiveSvg` | `false` | Remove root width/height only when a valid viewBox exists |

## Custom image hooks

Define hooks in your application's `config/plugins.js` (or the equivalent
TypeScript configuration). They are trusted server code, loaded on startup;
they are never accepted, stored or returned by the admin settings API.

```js
module.exports = {
  'image-pipeline': {
    enabled: true,
    config: {
      hookTimeoutMs: 30000,
      hooks: {
        async beforeProcess({ image, sharp }) {
          // Tint every PNG blue before the plugin resizes/converts it.
          if (image.mime !== 'image/png' || image.pages > 1) return;
          return sharp(image.buffer).tint('#0066ff').png().toBuffer();
        },
        async afterProcess({ image, original, sharp }) {
          // Apply a watermark to selected filenames, at the final image size.
          if (!original.name.includes('product-') || image.mime === 'image/svg+xml' || image.pages > 1) return;
          const width = Math.min(160, image.width);
          const height = Math.min(32, image.height);
          const watermark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000" opacity=".5"/><text x="4" y="20" fill="#fff" font-size="14">My brand</text></svg>`);
          return sharp(image.buffer).composite([{ input: watermark, gravity: 'southeast' }]).toBuffer();
        },
      },
    },
  },
};
```

| Hook context | Meaning |
| --- | --- |
| `event` | `beforeProcess` or `afterProcess` |
| `operation` | `upload` or `replace` |
| `image` | Current `buffer`, `name`, detected `mime`, `width`, `height`, `pages`, and `size` in **bytes** |
| `original` | Name and MIME before this plugin's processing, for filters that must survive WebP conversion |
| `settings` | Read-only snapshot of effective settings for this operation |
| `sharp` | The plugin's installed Sharp function; no additional image library is needed |
| `strapi` | The current Strapi instance |
| `signal` | AbortSignal set when the hook exceeds its timeout |

Return a nonempty `Buffer` to replace the current image, or return nothing to
leave it unchanged. Mutating `image.buffer` without returning it has no effect.
Metadata is recomputed from bytes. Hooks preserve the current image format;
format conversion remains the plugin's `convertToWebp` setting. A before-hook
can change dimensions before resizing. An after-hook must respect
`maxDimension` for rasters. Both phases enforce file-size and megapixel limits.

Each image runs `beforeProcess` → processing → `afterProcess` → storage and
thumbnail/responsive-format generation. "After" means after optimization,
**before persistence**, so thumbnails inherit the transformation. Both phases
also run for AVIF, GIF and SVG, which Strapi does not send through its raster
optimizer.
SVG is sanitized before hooks and after any returned SVG when `sanitizeSvg`
is enabled. Other supported raster formats are JPEG, PNG, WebP, TIFF and AVIF.
The master switch disables hooks too. Existing library assets are unaffected.

Hook errors, invalid outputs and timeouts reject that image before storage;
custom-hook failures never fall back silently to an unmodified upload. A failed
hook on replacement leaves the old asset intact. Strapi's later provider/DB
failures retain Strapi's own semantics; this does not make replacements or
multi-file uploads transactional. Earlier images in a batch may already exist.
Hooks run once per source image, not once per generated thumbnail. Strapi v4's
`uploadToEntity` is covered; direct provider calls and data imports bypass the
upload service and these hooks. Direct calls to the image-manipulation optimizer
outside these upload operations also bypass hooks.

Callbacks run in the server process with application privileges. Await all
custom work; avoid unbounded CPU tasks and use `signal` for cancellable I/O.
`hookTimeoutMs` (1–300000, default 30000) stops awaiting a slow callback, but
cannot terminate synchronous JavaScript or undo external side effects. No
automatic retries occur. Several uploads can execute callbacks concurrently;
keep request state inside the callback. Buffers consume memory proportional
to image size and concurrency; set upload limits appropriate to the host.

TypeScript projects can import `ImageHooks`, `ImageHookContext` and
`ImageSettings` from `@aduptive/strapi-image-pipeline/hooks` using
`import type`. `ImageHooks<YourStrapiType>` optionally types the Strapi instance.
Use `satisfies ImageHooks` on the hooks object to catch misspelled event names.
Hook configuration requires a server restart; ordinary settings remain editable
in the admin. Use one function per phase and compose your own helpers there.

## Webhooks and integrations

Use Strapi's own webhooks to notify n8n, Make, a CDN purge, an indexer or any
other system. The plugin adds no second sender, queue or event bus: the upload
plugin already emits `media.create`, `media.update` and `media.delete` when the
file record is persisted, which is **after** hooks, optimization, provider
upload and thumbnail generation. The payload therefore describes the final
stored asset, not the incoming bytes. Configure them under
**Settings → Webhooks** (or `POST /admin/webhooks`) and select the media events.

```json
{
  "event": "media.create",
  "createdAt": "2026-09-22T04:49:00.000Z",
  "media": {
    "id": 12, "name": "product-shot.webp", "ext": ".webp", "mime": "image/webp",
    "width": 400, "height": 200, "size": 6.1, "hash": "product_shot_1a2b3c",
    "url": "/uploads/product_shot_1a2b3c.webp",
    "formats": { "thumbnail": { "url": "/uploads/thumbnail_product_shot_1a2b3c.webp", "width": 245, "height": 123 } },
    "provider": "local", "createdAt": "...", "updatedAt": "..."
  }
}
```

Requests are `POST` with `Content-Type: application/json`, an `X-Strapi-Event`
header, the headers configured on the webhook (put your receiver's token
there) and `webhooks.defaultHeaders` from `config/server.js`. The receiver
fetches bytes through `media.url`; the payload never contains image data,
temporary paths or hook configuration. The file name keeps its base name and
only changes extension on WebP conversion, so filename-based filters written
for hooks also work on the receiving side.

Delivery semantics come from Strapi (verified in 4.26.1 and 5.52.1 source and
against a loopback receiver): one attempt per webhook with a 10 s timeout, an
in-memory queue (five concurrent deliveries) that is lost on restart, no
retries, and failures only logged. A failed delivery never fails the upload.
Design receivers to be idempotent on `media.id` plus `updatedAt`, and poll
`/upload/files` for reconciliation when delivery matters. `media.update` fires
for replacements **and** for metadata edits (alt text, caption, folder moves);
replacements keep the same `url` and `hash`, so compare `size`, `width`,
`height` or `updatedAt` and bypass caches when refetching. Data imports and
direct provider writes emit no media events, the same paths that bypass hooks.
Both Strapi versions reject loopback/private webhook URLs when
`NODE_ENV=production`.

Local hooks and webhooks complement each other: hooks transform or reject the
image synchronously before it is saved; webhooks tell other systems what was
saved. Nothing in a webhook can change the stored bytes. Run
`node scripts/webhook-smoke.mjs 4|5` against the lab hosts to reproduce the
create/replace/delete deliveries with a synthetic loopback receiver.

## Behavior and limits

- JPEG/PNG/WebP/TIFF follow Strapi's optimizable-image pipeline.
- AVIF, SVG and GIF are handled by the plugin itself, because Strapi does not
  send them to its optimizer: Sharp reports AVIF as `heif`, which Strapi's own
  format list does not match, so an AVIF upload would otherwise reach storage
  with no size guard, no resizing and no hooks. AVIF keeps its format (it is
  not converted to WebP) and is only re-encoded when it exceeds `maxDimension`,
  to avoid a pointless generational loss.
- Animated inputs reaching the optimizer are preserved, avoiding first-frame
  flattening. GIF processing remains subject to Strapi's own upload behavior.
- Rotation follows EXIF orientation. Output size, dimensions, MIME and extension
  are updated on conversion. Optimization failures delegate to Strapi's default
  optimizer; explicit size/pixel guard errors propagate.
- `quality` applies to JPEG, WebP, TIFF and AVIF. PNG is lossless, so keeping
  the original format re-encodes PNG without quantising it, and an already
  indexed PNG stays indexed. Use `convertToWebp` when you want smaller files
  from PNG sources.
- Supported image bytes must match their declared MIME type, including on
  programmatic uploads. An upload with no usable Content-Type (missing, or
  `application/octet-stream`) is typed from its bytes instead of being rejected,
  matching how Strapi 5 resolves `detectedMimeType`; a declared image type that
  contradicts the bytes is still refused. SVG filenames must declare
  `image/svg+xml`. Configured
  pixel limits are checked before Strapi decodes raster data. Hook output uses
  unique temporary paths, written inside the working directory Strapi creates
  and removes for each upload or replacement, so no file of the plugin's outlives
  the readers Strapi hands it to. SVG, GIF and AVIF are processed before that
  directory exists, so their processed bytes replace the request file in place:
  the plugin creates no file of its own there and deletes none.
- SVG sanitization recognizes both v4 and v5 temporary file paths. It removes
  scripts, events, style blocks/attributes, animation and external URL refs;
  internal references and embedded raster data URIs can remain. Some artwork
  relying on removed features can change appearance.
- Replacements must use the existing image MIME type while enabled. Conversion
  is suppressed on replacement because Strapi retains the original extension.
  Upload a new asset when changing format. Guards run before provider deletion.
- SVG dimension controls work independently of sanitization and minification,
  on uploads and replacements. Enable both to generate a missing viewBox and
  remove fixed dimensions. Existing viewBox values are never replaced by these
  controls; nested SVG dimensions are untouched. Inference assumes origin 0,0
  from the declared viewport, not the bounds of paths. Missing, nonpositive,
  nonfinite, percentage or other unit dimensions cannot be inferred and are
  left alone. An invalid viewBox prevents dimension removal.
- Minification keeps ID names, title/desc text and accessibility attributes;
  the sanitizer can still remove unsafe IDs or unsupported content. Sanitization
  remains a separate security setting, not a side effect of optimization.
- No retrospective bulk optimization, CDN or remote URL fetching.
- Local upload provider is the initial integration target. S3/Azure and other
  providers need their own release checks; wrappers touch upload internals.

Disable the runtime master switch to delegate to Strapi, or disable/remove the
plugin and rebuild/restart. Existing optimized assets remain ordinary media files.

## Development

`admin/` contains shared settings plus separate v4/v5 UI adapters. `server/`
contains the common upload hooks, validation, optimizer and permission-protected
settings routes. `packages/` contains the two distributions, `tests/` the
regression checks. Run `npm ci && npm run check` on Node 22 to build and test
both packages.
