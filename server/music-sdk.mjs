import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const modules = {
  '/cloudsearch': 'cloudsearch',
  '/song/url/v1': 'song_url_v1',
  '/login/qr/key': 'login_qr_key',
  '/login/qr/create': 'login_qr_create',
  '/login/qr/check': 'login_qr_check',
  '/login/status': 'login_status',
};

/** Load only SDK functions, not main.js/server.js or its HTTP service/dotenv loader. */
export async function createSdkMusicTransport({ tempDir, publicKeyLoader, sendRequest } = {}) {
  if (!tempDir || resolve(tmpdir()) !== resolve(tempDir) || resolve(process.cwd()) !== resolve(tempDir)) {
    throw new Error('SDK requires its isolated temporary working directory');
  }
  const packageRoot = dirname(require.resolve('@neteasecloudmusicapienhanced/api/package.json'));
  // The SDK request helper expects this anonymous-token file to exist at import time.
  try { await writeFile(join(tempDir, 'anonymous_token'), '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const { cookieToJson, generateDeviceId } = require(join(packageRoot, 'util/index.js'));
  const deviceId = generateDeviceId();
  const functions = Object.fromEntries(Object.entries(modules).map(([route, name]) => [route, require(join(packageRoot, `module/${name}.js`))]));
  let send;
  let keyReady = false;
  let keyPending;

  // The function-only SDK path skips app.js/generateConfig.js. song_url_v1
  // still needs its xeapi key; load it lazily so offline startup remains local.
  const loadPublicKey = publicKeyLoader || (async ({ signal }) => {
    const { default: axios } = require('axios');
    const { APP_CONF } = require(join(packageRoot, 'util/config.json'));
    const { getXeapiPublicKey } = require(join(packageRoot, 'util/xeapiKey.js'));
    const keyUrl = `${APP_CONF.apiDomain}/api/bsr/sk/get`;
    const interceptor = axios.interceptors.request.use(config => config.url === keyUrl ? {
      ...config, signal, timeout: 5000, maxRedirects: 0,
      maxContentLength: 65536, maxBodyLength: 65536,
    } : config);
    try { return await getXeapiPublicKey({}, deviceId); }
    finally { axios.interceptors.request.eject(interceptor); }
  });

  async function ensurePublicKey(signal) {
    if (keyReady) return;
    if (!keyPending) {
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
      keyPending = (async () => {
        const key = await loadPublicKey({ signal: combined });
        if (combined.aborted) throw new Error('aborted');
        if (!key || typeof key.sk !== 'string' || !key.sk || Buffer.byteLength(JSON.stringify(key)) > 65536) throw new Error('Invalid SDK key');
        const temporary = join(tempDir, `.xeapi_public_key-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(key), { flag: 'wx', mode: 0o600 });
          if (combined.aborted) throw new Error('aborted');
          await rename(temporary, join(tempDir, 'xeapi_public_key'));
          keyReady = true;
        } finally { await rm(temporary, { force: true }); }
      })().finally(() => { keyPending = undefined; });
    }
    await keyPending;
  }
  return {
    async health() { return true; }, // Local module availability; never contact NetEase here.
    async request(route, params, { signal } = {}) {
      if (signal?.aborted) throw new Error('aborted');
      if (!functions[route]) throw new Error('Unsupported music operation');
      let result;
      try {
        if (route === '/song/url/v1') await ensurePublicKey(signal);
        if (signal?.aborted) throw new Error('aborted');
        result = await functions[route]({ ...params, cookie: { ...cookieToJson(params.cookie || ''), deviceId } }, (...args) => {
          if (sendRequest) return sendRequest(...args);
          send ||= require(join(packageRoot, 'util/request.js'));
          return send(...args);
        });
      } catch (error) {
        // SDK rejects with response envelopes. Never forward raw errors/credentials.
        if (!error || !Number.isInteger(error.status) || !error.body) throw new Error('Music SDK request failed');
        result = error;
      }
      if (signal?.aborted) throw new Error('aborted');
      const status = Number(result?.status || 200);
      return { ok: status >= 200 && status < 300, status, body: result?.body };
    },
  };
}
