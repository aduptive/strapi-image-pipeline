import type { Buffer } from 'node:buffer'
import type sharp from 'sharp'

export interface ImageSettings {
  enabled: boolean
  maxFileSizeMB: number
  maxDimension: number
  quality: number
  convertToWebp: boolean
  maxMegapixels: number
  sanitizeSvg: boolean
  optimizeSvg: boolean
  addSvgViewBox: boolean
  responsiveSvg: boolean
}

export interface ImageHookContext<Strapi = unknown> {
  readonly event: 'beforeProcess' | 'afterProcess'
  readonly operation: 'upload' | 'replace'
  readonly original: Readonly<{ name: string; mime: string }>
  readonly image: Readonly<{
    buffer: Buffer
    name: string
    mime: string
    /** Byte count, not Strapi's kilobyte size field. */
    size: number
    width: number
    height: number
    pages: number
  }>
  readonly settings: Readonly<ImageSettings>
  readonly strapi: Strapi
  readonly sharp: typeof sharp
  /** Aborted on timeout; cancellation of custom work is cooperative. */
  readonly signal: AbortSignal
}

export type ImageHook<Strapi = unknown> = (context: ImageHookContext<Strapi>) => Buffer | void | Promise<Buffer | void>
export interface ImageHooks<Strapi = unknown> {
  beforeProcess?: ImageHook<Strapi>
  afterProcess?: ImageHook<Strapi>
}
