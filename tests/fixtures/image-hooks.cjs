// Synthetic callbacks for the isolated local Strapi hosts only.
module.exports = {
  async beforeProcess({ image, original, sharp }) {
    if (original.name.startsWith('hook-reject-before')) throw new Error('Synthetic before-hook failure')
    if (original.name.startsWith('hook-timeout')) return new Promise(() => {})
    if (original.name.startsWith('hook-format')) return sharp(image.buffer).jpeg().toBuffer()
    if (original.name.startsWith('hook-') && image.mime === 'image/png') return sharp(image.buffer).tint('#0000ff').png().toBuffer()
  },
  async afterProcess({ image, original, sharp }) {
    if (original.name.startsWith('hook-reject-after')) throw new Error('Synthetic after-hook failure')
    if (!original.name.startsWith('hook-brand')) return
    const mark = await sharp({ create: { width: 32, height: 32, channels: 4, background: 'red' } }).png().toBuffer()
    return sharp(image.buffer).composite([{ input: mark, top: 0, left: 0 }]).toBuffer()
  },
}
