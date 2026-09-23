'use strict'

module.exports = ({ strapi }) => ({
  async find(ctx) {
    ctx.body = await strapi
      .plugin('image-pipeline')
      .service('settings')
      .get()
  },

  async update(ctx) {
    const body = ctx.request?.body
    ctx.body = await strapi
      .plugin('image-pipeline')
      .service('settings')
      .set(body)
  },
})
