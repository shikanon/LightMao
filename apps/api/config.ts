import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiOptions } from './server.ts';
import {
  MAX_CONFIGURED_OUTPUT,
  modelDefaults,
  outputTokenBudget,
} from '../../packages/shared/model-budget.ts';

/** Validate deployment settings without putting private values into errors. */
export function apiRuntime(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production';
  const bool = (name: string, fallback = false) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    if (!['true', 'false'].includes(env[name]!)) throw Error(`${name} must be true or false`);
    return env[name] === 'true';
  };
  const demo = bool('LIGHTMAO_DEMO');
  const budget = (name: string, min: number, max: number) => {
    if (!env[name]) return undefined;
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`Invalid ${name}`);
    return value;
  };
  const defaults = modelDefaults(env.ARK_MODEL_ID);
  const contextWindowTokens =
    budget('ARK_CONTEXT_WINDOW_TOKENS', 16384, 2_000_000) ?? defaults.contextWindowTokens;
  const maxOutputTokens =
    budget('ARK_MAX_OUTPUT_TOKENS', 1024, MAX_CONFIGURED_OUTPUT) ?? defaults.maxOutputTokens;
  if (outputTokenBudget(contextWindowTokens, maxOutputTokens, env.ARK_MODEL_ID) < maxOutputTokens)
    throw Error('Invalid Ark context/output budget for configured model');
  const secureCookies = bool('LIGHTMAO_SECURE_COOKIES');
  const port = Number(env.API_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid API_PORT');
  const dataDir = env.LIGHTMAO_DATA_DIR || resolve('.lightmao');
  if (production && (!env.LIGHTMAO_DATA_DIR || !isAbsolute(dataDir)))
    throw Error('Production requires an absolute LIGHTMAO_DATA_DIR outside the release directory');
  const releaseRoot = fileURLToPath(new URL('../../', import.meta.url));
  if (
    production &&
    (resolve(dataDir) === resolve(releaseRoot) ||
      resolve(dataDir).startsWith(resolve(releaseRoot) + sep))
  )
    throw Error('Production LIGHTMAO_DATA_DIR must be outside the release directory');
  const adminEmail = env.LIGHTMAO_ADMIN_EMAIL;
  const adminPassword = env.LIGHTMAO_ADMIN_PASSWORD;
  if (
    !!adminEmail !== !!adminPassword ||
    (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) ||
    (adminPassword && (adminPassword.length < 12 || adminPassword.length > 200))
  )
    throw Error(
      'Invalid administrator bootstrap settings: email and a 12-200 character password required',
    );
  if (production && (!adminEmail || !adminPassword))
    throw Error('Production requires LIGHTMAO_ADMIN_EMAIL and LIGHTMAO_ADMIN_PASSWORD');
  if (production && (demo || !secureCookies))
    throw Error('Production requires LIGHTMAO_DEMO=false and LIGHTMAO_SECURE_COOKIES=true');
  if (env.LIGHTMAO_TRUST_PROXY && env.LIGHTMAO_TRUST_PROXY !== 'loopback')
    throw Error('LIGHTMAO_TRUST_PROXY only accepts loopback');
  const allowedOrigins = env.LIGHTMAO_WEB_ORIGINS?.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins || []) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw Error('Invalid LIGHTMAO_WEB_ORIGINS');
    }
    if (
      origin !== url.origin ||
      (production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))
    )
      throw Error('LIGHTMAO_WEB_ORIGINS must contain canonical HTTPS origins in production');
  }
  if (env.ARK_BASE_URL) {
    let url: URL;
    try {
      url = new URL(env.ARK_BASE_URL);
    } catch {
      throw Error('Invalid ARK_BASE_URL');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
      throw Error('ARK_BASE_URL requires HTTPS, or an HTTP loopback protocol fixture');
  }
  const storage = env.LIGHTMAO_STORAGE || 'local';
  const permissionMode = env.LIGHTMAO_PERMISSION_MODE || 'full';
  if (!['full', 'custom'].includes(permissionMode))
    throw Error('LIGHTMAO_PERMISSION_MODE must be full or custom');
  if (!['local', 'oss'].includes(storage)) throw Error('LIGHTMAO_STORAGE must be local or oss');
  if (
    storage === 'oss' &&
    ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'].some(
      (name) => !env[name],
    )
  )
    throw Error('OSS storage requires region, bucket and both server-side access credentials');
  const options: ApiOptions = {
    dataDir: resolve(dataDir),
    demo,
    secureCookies,
    adminEmail,
    adminPassword,
    visionModelId: env.ARK_VISION_MODEL_ID,
    audioModelId: env.ARK_AUDIO_MODEL_ID,
    trustProxy: env.LIGHTMAO_TRUST_PROXY === 'loopback' ? 'loopback' : false,
    allowedOrigins: allowedOrigins || (production ? [] : undefined),
    arkKey: env.ARK_API_KEY,
    arkBase: env.ARK_BASE_URL,
    modelId: env.ARK_MODEL_ID,
    contextWindowTokens,
    maxOutputTokens,
    decisionModelId: env.ARK_SYSTEM_ONE_MODEL_ID,
    imageModelId: env.ARK_IMAGE_MODEL_ID,
    videoModelId: env.ARK_VIDEO_MODEL_ID,
    permissionMode: permissionMode as 'full' | 'custom',
    serveWeb: true,
    webRoot: fileURLToPath(new URL('../../dist/web/', import.meta.url)),
    storage: storage as 'local' | 'oss',
    oss:
      storage === 'oss'
        ? {
            region: env.OSS_REGION!,
            bucket: env.OSS_BUCKET!,
            accessKeyId: env.OSS_ACCESS_KEY_ID!,
            accessKeySecret: env.OSS_ACCESS_KEY_SECRET!,
            prefix: env.OSS_PREFIX,
          }
        : undefined,
  };
  return { options, listen: { port, host: '127.0.0.1' } };
}
