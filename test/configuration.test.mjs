import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRadioApplication } from '../server/app.mjs';

const manifest = JSON.parse(await readFile(new URL('../local-app.json', import.meta.url), 'utf8'));
const fields = manifest.configuration.fields;
const localFetch = globalThis.fetch;
const plan = { say: '欢迎收听，先用一首轻松的歌陪你开始今天。', play: [{ title: '人工测试歌曲', artist: '人工测试歌手' }], reason: '离线测试。', segue: '' };
const aiResponse = () => Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] });

async function application(t, env) {
  const root = await mkdtemp(join(tmpdir(), 'radio-config-disposable-'));
  const app = createRadioApplication({
    root, env, dataDir: join(root, 'data'), profileDir: join(root, 'profile'), cacheDir: join(root, 'cache'),
    managed: { instanceId: 'artificial_config_instance', token: 'artificial-config-instance-token' },
    musicTransport: {
      health: async () => true,
      async request(path) {
        assert.equal(path, '/cloudsearch');
        return { ok: true, status: 200, body: { code: 200, result: { songs: [], songCount: 0 } } };
      },
    },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, data) => {
    const response = await localFetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer artificial-config-instance-token', ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  request.raw = (path, options = {}) => localFetch(base + path, {
    ...options, headers: { Authorization: 'Bearer artificial-config-instance-token', ...options.headers },
  });
  return request;
}

test('managed configuration requests only DeepSeek and Fish API keys without embedded secrets', () => {
  assert.equal(manifest.runtime, 'node-service');
  assert.deepEqual(fields.map(field => field.name).sort(), ['ANTHROPIC_API_KEY', 'FISH_API_KEY']);
  for (const field of fields) {
    assert.match(field.description, /[\u4e00-\u9fff]/);
    assert.ok(field.howToGet.length >= 2);
    assert.ok(field.howToGet.every(step => typeof step === 'string' && step.trim()));
    const help = new URL(field.helpUrl);
    assert.equal(help.protocol, 'https:');
    assert.equal(help.search, '');
    assert.equal(help.hash, '');
    assert.ok(['platform.deepseek.com', 'fish.audio'].includes(help.hostname));
    assert.equal(field.required, field.name === 'ANTHROPIC_API_KEY');
    assert.equal(field.secret, true);
    assert.equal(Object.hasOwn(field, 'default'), false);
    assert.equal(Object.hasOwn(field, 'endpointField'), false);
  }
  assert.equal(fields.find(field => field.name === 'ANTHROPIC_API_KEY').label, 'DeepSeek API Key');
});

test('only two keys produce DeepSeek and Fish requests with the default models and voice', async t => {
  const env = {
    ANTHROPIC_API_KEY: 'artificial-ai-configuration-key',
    FISH_API_KEY: 'artificial-speech-configuration-key',
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    if (String(url) === 'https://api.deepseek.com/anthropic/v1/messages') {
      assert.equal(options.headers['x-api-key'], env.ANTHROPIC_API_KEY);
      assert.equal(body.model, 'deepseek-flash');
      return aiResponse();
    }
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.headers.Authorization, `Bearer ${env.FISH_API_KEY}`);
    assert.equal(options.headers.model, 's2.1-pro-free');
    assert.equal(Object.hasOwn(body, 'reference_id'), false);
    return new Response('ID3artificial-test-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const request = await application(t, env);
  const status = await request('/api/status');
  assert.equal(status.services.claude.provider, 'api.deepseek.com');
  assert.equal(status.services.claude.model, 'deepseek-flash');
  assert.equal(status.services.claude.ready, true);
  assert.equal(status.services.fish.model, 's2.1-pro-free');
  assert.equal(status.services.fish.ready, true);
  assert.equal(status.services.tts.provider, 'fish');
  assert.equal(calls.length, 0, 'health must not make external requests');
  assert.ok(!JSON.stringify(status).includes(env.ANTHROPIC_API_KEY));
  assert.ok(!JSON.stringify(status).includes(env.FISH_API_KEY));
  const response = await request('/api/chat', { message: '请为离线测试推荐歌曲。' });
  assert.equal(response.message.content, plan.say + '\n\n有 1 首推荐暂时未能从曲库找到，你可以试试直接搜歌。');
  assert.match(response.speech.url, /^\/tts\/[a-f0-9]{64}\.mp3$/);
  assert.equal(calls.length, 2);
});

test('managed updates ignore obsolete saved endpoint, model and voice options', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.headers.model, 's2.1-pro-free');
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'reference_id'), false);
    return new Response('ID3artificial-test-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const request = await application(t, {
    ANTHROPIC_API_KEY: 'artificial-ai-key', FISH_API_KEY: 'artificial-speech-key',
    ANTHROPIC_BASE_URL: 'https://obsolete.example.invalid', CLAUDE_MODEL: 'obsolete-model',
    FISH_MODEL: 'obsolete-model', FISH_REFERENCE_ID: 'obsolete-voice',
  });
  const status = await request('/api/status');
  assert.equal(status.services.claude.provider, 'api.deepseek.com');
  assert.equal(status.services.claude.model, 'deepseek-flash');
  assert.equal(status.services.tts.model, 's2.1-pro-free');
  assert.equal(status.services.tts.ready, true);
  assert.match((await request('/api/tts', { text: '更新后使用默认音色。' })).url, /\.mp3$/);
});

test('required AI with optional Fish omitted still produces text and never calls the speech service', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(options.headers['x-api-key'], 'artificial-required-ai-key');
    assert.equal(JSON.parse(options.body).model, 'deepseek-flash');
    return aiResponse();
  });
  const request = await application(t, { ANTHROPIC_API_KEY: 'artificial-required-ai-key' });
  const status = await request('/api/status');
  assert.equal(status.services.claude.ready, true);
  assert.equal(status.services.fish.ready, false);
  const response = await request('/api/chat', { message: '请生成没有主持声音的节目。' });
  assert.ok(response.message.content.startsWith(plan.say));
  assert.equal(response.speech.url, undefined);
  assert.match(response.speech.error, /文字串词/);
  assert.equal(calls, 1);
});

test('Fish serves cached MP3 with byte ranges and does not repeat paid synthesis', async t => {
  const audio = Buffer.from('ID3artificial-cached-audio');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const request = await application(t, { FISH_API_KEY: 'artificial-fish-key' });
  const [first, concurrent] = await Promise.all([
    request('/api/tts', { text: '欢迎收听。' }), request('/api/tts', { text: '欢迎收听。' }),
  ]);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(await request('/api/tts', { text: '欢迎收听。' }), first);
  assert.equal(calls, 1);
  const response = await request.raw(first.url);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  const part = await request.raw(first.url, { headers: { Range: 'bytes=0-11' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-11/${audio.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), audio.subarray(0, 12));
  const head = await request.raw(first.url, { method: 'HEAD', headers: { Range: 'bytes=0-11' } });
  assert.equal(head.status, 206);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
