'use strict';

const fs = require('fs');
const path = require('path');
const defaults = require('./defaults');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (isPlainObject(value) && isPlainObject(target[key])) merge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readLocalConfig() {
  const file = process.env.PORTAL_CONFIG || path.join(__dirname, 'local.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function listEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(path.join(__dirname, '..'), value);
}

const config = merge(clone(defaults), readLocalConfig());

config.server.host = process.env.HOST || process.env.PORTAL_HOST || config.server.host;
config.server.port = numberEnv('PORT', numberEnv('PORTAL_PORT', config.server.port));
config.session.timeoutMs = numberEnv('SESSION_TIMEOUT_MS', numberEnv('PORTAL_SESSION_TIMEOUT_MS', config.session.timeoutMs));
config.registration.adminInviteCount = numberEnv('ADMIN_INVITE_COUNT', numberEnv('PORTAL_ADMIN_INVITE_COUNT', config.registration.adminInviteCount));
config.registration.userInviteCount = numberEnv('USER_INVITE_COUNT', numberEnv('PORTAL_USER_INVITE_COUNT', config.registration.userInviteCount));
config.files.root = resolvePath(process.env.FILE_ROOT || process.env.PORTAL_FILE_ROOT || config.files.root);
config.files.maxUploadBytes = numberEnv('MAX_UPLOAD_BYTES', numberEnv('PORTAL_MAX_UPLOAD_BYTES', config.files.maxUploadBytes));
config.files.maxUploadFiles = numberEnv('MAX_UPLOAD_FILES', numberEnv('PORTAL_MAX_UPLOAD_FILES', config.files.maxUploadFiles));
config.resources.allowUsers = booleanEnv('RESOURCES_ALLOW_USERS', booleanEnv('PORTAL_RESOURCES_ALLOW_USERS', config.resources.allowUsers));
config.remote.allowPublicDirectHosts = listEnv('REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS', listEnv('PORTAL_REMOTE_ALLOW_PUBLIC_DIRECT_HOSTS', config.remote.allowPublicDirectHosts || []));
config.data.root = resolvePath(process.env.DATA_ROOT || process.env.PORTAL_DATA_ROOT || config.data.root);

module.exports = config;
