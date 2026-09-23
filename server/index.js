'use strict'

const bootstrap = require('./bootstrap')
const config = require('./config')
const routes = require('./routes')
const settingsController = require('./controllers/settings')
const settingsService = require('./services/settings')

module.exports = () => ({
  register() {},
  bootstrap,
  destroy() {},
  config,
  routes,
  controllers: {
    settings: settingsController,
  },
  services: {
    settings: settingsService,
  },
})
