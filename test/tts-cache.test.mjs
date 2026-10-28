import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTtsClient, createTtsClientFromEnv } from '../server/tts.mjs';

async function cache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'radio-fish-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const audioResponse = () => new Response('ID3fish', { headers: { 'content-type': 'audio/mpeg' } });

test('environment configuration reads only Fish fields and keeps credentials out of status', async t => {
  const cacheDir = await cache(t);
  const fields = { FISH_API_KEY: 'artificial-fish-key', FISH_MODEL: 's2-pro', FISH_REFERENCE_ID: 'artificial-voice' };
  const env = new Proxy(fields, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Unexpected configuration read: ${String(key)}`);
    return target[key];
  } });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.headers.Authorization, `Bearer ${fields.FISH_API_KEY}`);
    assert.equal(options.headers.model, fields.FISH_MODEL);
    assert.deepEqual(JSON.parse(options.body), { text: '你好。', format: 'mp3', reference_id: fields.FISH_REFERENCE_ID });
    return audioResponse();
  });
  const client = createTtsClientFromEnv(env, cacheDir);
  assert.equal(client.status.provider, 'fish');
  assert.equal(JSON.stringify(client.status).includes(fields.FISH_API_KEY), false);
  await client.synthesize('你好。');
});

test('Fish continues reading pre-existing cache entries without a synthesis request', async t => {
  const cacheDir = await cache(t);
  const identity = { model: 's2.1-pro-free', voice: 'artificial-voice', text: '欢迎收听。', format: 'mp3' };
  const filename = `${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}.mp3`;
  const audio = Buffer.from('ID3existing');
  await writeFile(join(cacheDir, filename), audio);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Cached speech must not request synthesis'); });
  const result = await createTtsClient({ apiKey: 'artificial-key', referenceId: identity.voice, cacheDir }).synthesize(identity.text);
  assert.equal(result.url, `/tts/${filename}`);
  assert.deepEqual(await readFile(join(cacheDir, filename)), audio);
});

test('failed Fish requests leave no cache and a later explicit request can retry', async t => {
  const cacheDir = await cache(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('private upstream body', { status: 503 }) : audioResponse());
  const client = createTtsClient({ apiKey: 'artificial-key', cacheDir });
  await assert.rejects(client.synthesize('你好。'), { code: 'FISH_UNAVAILABLE' });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(cacheDir), []);
  await client.synthesize('你好。');
  assert.equal(calls, 2);
  assert.equal((await readdir(cacheDir)).length, 1);
});

test('Fish sanitizes network failures even when they forge a local error code', async t => {
  const cacheDir = await cache(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('private artificial credential'), { code: 'FISH_UNAUTHORIZED' });
  });
  await assert.rejects(createTtsClient({ apiKey: 'artificial-key', cacheDir }).synthesize('你好。'), error => {
    assert.equal(error.code, 'FISH_UNAVAILABLE');
    assert.equal(error.message.includes('credential'), false);
    assert.equal(error.stack.includes('private artificial'), false);
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
});

test('Fish bounds declared and streamed response sizes and cancels rejected bodies', async t => {
  const cacheDir = await cache(t);
  let cancelled = 0;
  let mode = 'declared';
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { if (mode === 'streamed') controller.enqueue(new Uint8Array(20_000_001)); },
    cancel() { cancelled++; },
  }), { headers: { 'content-type': 'audio/mpeg', ...(mode === 'declared' ? { 'content-length': '20000001' } : {}) } }));
  const client = createTtsClient({ apiKey: 'artificial-key', cacheDir });
  for (mode of ['declared', 'streamed']) await assert.rejects(client.synthesize('你好。'), { code: 'FISH_INVALID_AUDIO' });
  assert.equal(cancelled, 2);
  assert.deepEqual(await readdir(cacheDir), []);
});

test('Fish enforces its deadline when fetch ignores cancellation', async t => {
  const cacheDir = await cache(t);
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => original(callback, milliseconds === 60_000 ? 5 : milliseconds, ...args));
  t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  await assert.rejects(createTtsClient({ apiKey: 'artificial-key', cacheDir }).synthesize('你好。'), { code: 'FISH_TIMEOUT', status: 504 });
  assert.deepEqual(await readdir(cacheDir), []);
});

test('Fish deadline includes stalled body consumption and cancels the stream', async t => {
  const cacheDir = await cache(t);
  const original = globalThis.setTimeout;
  let cancelled = false;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => original(callback, milliseconds === 60_000 ? 5 : milliseconds, ...args));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-type': 'audio/mpeg' },
  }));
  await assert.rejects(createTtsClient({ apiKey: 'artificial-key', cacheDir }).synthesize('你好。'), { code: 'FISH_TIMEOUT', status: 504 });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(cacheDir), []);
});
