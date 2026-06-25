'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

module.exports = {
  server: {
    host: '0.0.0.0',
    port: 8088
  },
  session: {
    timeoutMs: 8 * 3600 * 1000
  },
  registration: {
    adminInviteCount: 6,
    userInviteCount: 3
  },
  files: {
    root: path.join(DATA, 'files'),
    maxUploadBytes: 100 * 1024 * 1024,
    maxUploadFiles: 10
  },
  resources: {
    allowUsers: true
  },
  remote: {
    allowPublicDirectHosts: []
  },
  data: {
    root: DATA
  }
};
