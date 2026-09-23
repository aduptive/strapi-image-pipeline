'use strict'
module.exports = {
  admin: { type: 'admin', routes: ['find', 'update'].map((handler, index) => ({
    method: index ? 'PUT' : 'GET', path: '/settings', handler: `settings.${handler}`,
    config: { policies: ['admin::isAuthenticatedAdmin', { name: 'admin::hasPermissions',
      config: { actions: [`plugin::image-pipeline.${index ? 'update' : 'read'}`] } }] },
  })) },
}
