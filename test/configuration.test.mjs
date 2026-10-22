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
const defaults = () => Object.fromEntries(fields.filter(field => Object.hasOwn(field, 'default')).map(field => [field.name, String(field.default)]));

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
  return async (path, data) => {
    const response = await localFetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer artificial-config-instance-token', ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
}

test('managed configuration presents six explained settings with required AI and no embedded secrets', () => {
  assert.equal(manifest.runtime, 'node-service');
  assert.deepEqual(fields.map(field => field.name), [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'FISH_API_KEY', 'FISH_REFERENCE_ID', 'FISH_MODEL',
  ]);
  for (const field of fields) {
    assert.match(field.label, /[\u4e00-\u9fff]/);
    assert.match(field.description, /[\u4e00-\u9fff]/);
    assert.ok(field.howToGet.length >= 2);
    assert.ok(field.howToGet.every(step => typeof step === 'string' && step.trim()));
    const help = new URL(field.helpUrl);
    assert.equal(help.protocol, 'https:');
    assert.ok(['api-docs.deepseek.com', 'platform.deepseek.com', 'fish.audio', 'docs.fish.audio'].includes(help.hostname));
    assert.equal(field.required, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL'].includes(field.name));
    assert.equal(field.secret, ['ANTHROPIC_API_KEY', 'FISH_API_KEY'].includes(field.name));
    if (field.secret) assert.equal(Object.hasOwn(field, 'default'), false);
  }
  assert.equal(defaults().ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(defaults().CLAUDE_MODEL, 'deepseek-flash');
  assert.equal(defaults().FISH_MODEL, 's2.1-pro-free');
  assert.equal(fields.find(field => field.name === 'ANTHROPIC_API_KEY').endpointField, 'ANTHROPIC_BASE_URL');
});

test('all six declared variables reach real app AI and speech requests using only mocked external responses', async t => {
  const env = {
    ...defaults(), ANTHROPIC_BASE_URL: 'https://ai.radio-test.invalid/anthropic',
    ANTHROPIC_API_KEY: 'artificial-ai-configuration-key', CLAUDE_MODEL: 'artificial-model',
    FISH_API_KEY: 'artificial-speech-configuration-key', FISH_REFERENCE_ID: 'artificial-voice-id', FISH_MODEL: 's2-pro',
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    if (String(url) === 'https://ai.radio-test.invalid/anthropic/v1/messages') {
      assert.equal(options.headers['x-api-key'], env.ANTHROPIC_API_KEY);
      assert.equal(body.model, env.CLAUDE_MODEL);
      return aiResponse();
    }
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    assert.equal(options.headers.Authorization, `Bearer ${env.FISH_API_KEY}`);
    assert.equal(options.headers.model, env.FISH_MODEL);
    assert.equal(body.reference_id, env.FISH_REFERENCE_ID);
    return new Response('ID3artificial-test-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const request = await application(t, env);
  const status = await request('/api/status');
  assert.equal(status.services.claude.provider, 'ai.radio-test.invalid');
  assert.equal(status.services.claude.model, env.CLAUDE_MODEL);
  assert.equal(status.services.claude.ready, true);
  assert.equal(status.services.fish.model, env.FISH_MODEL);
  assert.equal(status.services.fish.ready, true);
  assert.equal(calls.length, 0, 'health must not make external requests');
  assert.ok(!JSON.stringify(status).includes(env.ANTHROPIC_API_KEY));
  assert.ok(!JSON.stringify(status).includes(env.FISH_API_KEY));
  const response = await request('/api/chat', { message: '请为离线测试推荐歌曲。' });
  assert.equal(response.message.content, plan.say + '\n\n有 1 首推荐暂时未能从曲库找到，你可以试试直接搜歌。');
  assert.match(response.speech.url, /^\/tts\/[a-f0-9]{64}\.mp3$/);
  assert.equal(calls.length, 2);
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
  const request = await application(t, { ...defaults(), ANTHROPIC_API_KEY: 'artificial-required-ai-key' });
  const status = await request('/api/status');
  assert.equal(status.services.claude.ready, true);
  assert.equal(status.services.fish.ready, false);
  const response = await request('/api/chat', { message: '请生成没有主持声音的节目。' });
  assert.ok(response.message.content.startsWith(plan.say));
  assert.equal(response.speech.url, undefined);
  assert.match(response.speech.error, /文字串词/);
  assert.equal(calls, 1);
});
