import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMusicTransport } from '../server/music-sdk.mjs';

const require = createRequire(import.meta.url);
const sourceCwd = process.cwd();
const originalTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
const params = { id: '123', level: 'standard', unblock: 'false' };
const response = { status: 200, body: { code: 200, data: [{ id: 123, url: 'https://example.invalid/artificial.mp3' }] }, cookie: [] };
const artificialKey = { sk: 'artificial-key-not-for-network', version: '1' };

async function fixture(t) {
  const tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'radio-sdk-key-offline-')));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = tempDir;
  process.env.DOTENV_CONFIG_QUIET = 'true';
  process.chdir(tempDir);
  t.after(async () => {
    process.chdir(sourceCwd);
    for (const [name, value] of Object.entries(originalTemp)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

test('SDK playback initializes its public key lazily and handles failures without network or credentials', async t => {
  await t.test('startup, health and search stay offline; concurrent playback shares one initialization', async t => {
    const tempDir = await fixture(t);
    let loads = 0;
    let finish;
    const transport = await createSdkMusicTransport({ tempDir,
      publicKeyLoader: async () => { loads++; await new Promise(resolve => { finish = resolve; }); return artificialKey; },
      sendRequest: async () => response,
    });
    assert.equal(loads, 0);
    assert.equal(await transport.health(), true);
    await transport.request('/cloudsearch', { keywords: 'artificial' });
    assert.equal(loads, 0);
    assert.deepEqual(await readdir(tempDir), ['anonymous_token']);
    const first = transport.request('/song/url/v1', params);
    const second = transport.request('/song/url/v1', params);
    assert.equal(loads, 1);
    finish();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    await transport.request('/song/url/v1', params);
    assert.equal(loads, 1);
    assert.deepEqual(JSON.parse(await readFile(join(tempDir, 'xeapi_public_key'), 'utf8')), artificialKey);
    assert.equal((await stat(join(tempDir, 'xeapi_public_key'))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(tempDir)).sort(), ['anonymous_token', 'xeapi_public_key']);
  });

  await t.test('a failed initialization stays private and a later request can retry', async t => {
    const tempDir = await fixture(t);
    let loads = 0;
    const transport = await createSdkMusicTransport({ tempDir,
      publicKeyLoader: async () => { if (++loads === 1) throw new Error('ARTIFICIAL_PRIVATE_UPSTREAM'); return artificialKey; },
      sendRequest: async () => response,
    });
    await assert.rejects(transport.request('/song/url/v1', params), error => {
      assert.equal(error.message, 'Music SDK request failed');
      assert.equal(String(error.stack).includes('ARTIFICIAL_PRIVATE_UPSTREAM'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(await readdir(tempDir), ['anonymous_token']);
    assert.equal((await transport.request('/song/url/v1', params)).ok, true);
    assert.equal(loads, 2);
  });

  await t.test('caller cancellation aborts initialization and never publishes a partial key', async t => {
    const tempDir = await fixture(t);
    const controller = new AbortController();
    let observedAbort = false;
    let loads = 0;
    const transport = await createSdkMusicTransport({ tempDir,
      publicKeyLoader: async ({ signal }) => {
        if (++loads > 1) return artificialKey;
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          observedAbort = true; reject(new Error('ARTIFICIAL_ABORT'));
        }, { once: true }));
      },
      sendRequest: async () => response,
    });
    const pending = transport.request('/song/url/v1', params, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { message: 'Music SDK request failed' });
    assert.equal(observedAbort, true);
    assert.deepEqual(await readdir(tempDir), ['anonymous_token']);
    assert.equal((await transport.request('/song/url/v1', params)).ok, true);
  });

  await t.test('SDK helper receives bounded nonredirecting requests and its interceptor is removed', async t => {
    const tempDir = await fixture(t);
    const { default: axios } = require('axios');
    const previousAdapter = axios.defaults.adapter;
    const count = () => axios.interceptors.request.handlers.filter(Boolean).length;
    const before = count();
    let observed;
    axios.defaults.adapter = async config => { observed = config; throw new Error('ARTIFICIAL_NETWORK_DENIED'); };
    t.after(() => { axios.defaults.adapter = previousAdapter; });
    const transport = await createSdkMusicTransport({ tempDir, sendRequest: async () => response });
    await assert.rejects(transport.request('/song/url/v1', params), { message: 'Music SDK request failed' });
    assert.equal(observed.url, 'https://interface.music.163.com/api/bsr/sk/get');
    assert.equal(observed.timeout, 5000);
    assert.equal(observed.maxRedirects, 0);
    assert.equal(observed.maxContentLength, 65536);
    assert.equal(observed.maxBodyLength, 65536);
    assert.ok(observed.signal instanceof AbortSignal);
    assert.equal(count(), before);
    assert.deepEqual(await readdir(tempDir), ['anonymous_token']);
  });
});
