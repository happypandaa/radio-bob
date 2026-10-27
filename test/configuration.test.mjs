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

test('managed configuration explains explicit speech providers and credentials without embedded secrets', () => {
  assert.equal(manifest.runtime, 'node-service');
  assert.deepEqual(fields.map(field => field.name).sort(), [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'TTS_PROVIDER',
    'FISH_API_KEY', 'FISH_REFERENCE_ID', 'FISH_MODEL', 'DOUBAO_API_KEY', 'DOUBAO_RESOURCE_ID', 'DOUBAO_SPEAKER',
    'GEMINI_API_KEY', 'GEMINI_TTS_MODEL', 'GEMINI_TTS_VOICE', 'GEMINI_TTS_STYLE',
  ].sort());
  for (const field of fields) {
    assert.match(field.label, /[\u4e00-\u9fff]/);
    assert.match(field.description, /[\u4e00-\u9fff]/);
    assert.ok(field.howToGet.length >= 2);
    assert.ok(field.howToGet.every(step => typeof step === 'string' && step.trim()));
    const help = new URL(field.helpUrl);
    assert.equal(help.protocol, 'https:');
    assert.equal(help.search, '', 'platform help links must not include query parameters');
    assert.equal(help.hash, '');
    assert.ok(['api-docs.deepseek.com', 'platform.deepseek.com', 'fish.audio', 'docs.fish.audio',
      'docs.volcengine.com', 'www.volcengine.com', 'console.volcengine.com', 'ai.google.dev', 'aistudio.google.com'].includes(help.hostname));
    assert.equal(field.required, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL'].includes(field.name));
    assert.equal(field.secret, ['ANTHROPIC_API_KEY', 'FISH_API_KEY', 'DOUBAO_API_KEY', 'GEMINI_API_KEY'].includes(field.name));
    if (field.secret) assert.equal(Object.hasOwn(field, 'default'), false);
  }
  assert.equal(defaults().ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(defaults().CLAUDE_MODEL, 'deepseek-flash');
  assert.equal(defaults().FISH_MODEL, 's2.1-pro-free');
  assert.equal(defaults().TTS_PROVIDER, 'fish');
  assert.equal(defaults().DOUBAO_RESOURCE_ID, 'seed-tts-2.0');
  assert.equal(defaults().GEMINI_TTS_MODEL, 'gemini-3.8-flash-tts');
  assert.deepEqual(fields.find(field => field.name === 'TTS_PROVIDER').options.map(option => option.value).sort(), ['doubao', 'fish', 'gemini', 'none']);
  assert.ok(!fields.some(field => /APP_ID|ACCESS_TOKEN|SECRET_KEY/.test(field.name)));
  assert.equal(fields.find(field => field.name === 'ANTHROPIC_API_KEY').endpointField, 'ANTHROPIC_BASE_URL');
});

test('existing Fish settings still reach app AI and speech requests using mocked external responses', async t => {
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
  assert.equal(status.services.tts.provider, 'fish');
  assert.equal(calls.length, 0, 'health must not make external requests');
  assert.ok(!JSON.stringify(status).includes(env.ANTHROPIC_API_KEY));
  assert.ok(!JSON.stringify(status).includes(env.FISH_API_KEY));
  const response = await request('/api/chat', { message: '请为离线测试推荐歌曲。' });
  assert.equal(response.message.content, plan.say + '\n\n有 1 首推荐暂时未能从曲库找到，你可以试试直接搜歌。');
  assert.match(response.speech.url, /^\/tts\/[a-f0-9]{64}\.mp3$/);
  assert.equal(calls.length, 2);
});

function wavAudio() {
  const audio = Buffer.alloc(48);
  audio.write('RIFF', 0); audio.writeUInt32LE(40, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(4, 40);
  return audio;
}

test('selected Gemini uses its own credentials, model, voice, style and serves cached WAV with byte ranges', async t => {
  const env = { ...defaults(), TTS_PROVIDER: 'gemini', GEMINI_API_KEY: 'artificial-gemini-key',
    GEMINI_TTS_MODEL: 'gemini-3.8-flash-lite-tts', GEMINI_TTS_VOICE: 'Charon', GEMINI_TTS_STYLE: '自然、沉稳。',
    FISH_API_KEY: 'artificial-unused-fish', DOUBAO_API_KEY: 'artificial-unused-doubao' };
  const audio = wavAudio();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    const body = JSON.parse(options.body);
    assert.equal(body.model, env.GEMINI_TTS_MODEL);
    assert.equal(body.generation_config.speech_config[0].voice, env.GEMINI_TTS_VOICE);
    assert.equal(body.input[0].content[0].annotations[0].style, env.GEMINI_TTS_STYLE);
    assert.equal(body.input[0].content[0].text, '欢迎收听。');
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: audio.toString('base64') }] }] });
  });
  const request = await application(t, env);
  const status = await request('/api/status');
  assert.equal(status.services.tts.provider, 'gemini');
  assert.equal(status.services.tts.ready, true);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(status).includes('artificial-'));
  const [result, concurrent] = await Promise.all([
    request('/api/tts', { text: '欢迎收听。' }), request('/api/tts', { text: '欢迎收听。' }),
  ]);
  assert.deepEqual(result, concurrent);
  assert.match(result.url, /^\/tts\/[a-f0-9]{64}\.wav$/);
  assert.deepEqual(await request('/api/tts', { text: '欢迎收听。' }), result);
  assert.equal(calls, 1);
  const response = await request.raw(result.url);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  const part = await request.raw(result.url, { headers: { Range: 'bytes=0-11' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-11/${audio.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), audio.subarray(0, 12));
  const head = await request.raw(result.url, { method: 'HEAD', headers: { Range: 'bytes=0-11' } });
  assert.equal(head.status, 206);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('selected Doubao uses only new voice API Key, resource and speaker, then serves decoded MP3', async t => {
  const env = { ...defaults(), TTS_PROVIDER: 'doubao', DOUBAO_API_KEY: 'artificial-doubao-key',
    DOUBAO_RESOURCE_ID: 'seed-tts-2.0', DOUBAO_SPEAKER: 'zh_female_vv_uranus_bigtts',
    FISH_API_KEY: 'artificial-unused-fish', GEMINI_API_KEY: 'artificial-unused-gemini' };
  const audio = Buffer.from('ID3artificial-streamed-audio');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal(options.headers['X-Api-Key'], env.DOUBAO_API_KEY);
    assert.equal(options.headers['X-Api-Resource-Id'], env.DOUBAO_RESOURCE_ID);
    assert.equal(options.headers['X-Api-App-Id'], undefined);
    assert.equal(options.headers['X-Api-Access-Key'], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.req_params.speaker, env.DOUBAO_SPEAKER);
    assert.equal(body.req_params.audio_params.format, 'mp3');
    return new Response(JSON.stringify({ code: 0, data: audio.toString('base64') }) + '\n' + JSON.stringify({ code: 20000000 }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const request = await application(t, env);
  assert.equal((await request('/api/status')).services.tts.provider, 'doubao');
  const result = await request('/api/tts', { text: '欢迎收听。' });
  assert.match(result.url, /\.mp3$/);
  const response = await request.raw(result.url);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
});

test('missing selected-provider key, disabled voice and invalid selection never fall back to another saved key', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => { calls++; throw new Error(`Unexpected request: ${url}`); });
  for (const provider of ['doubao', 'gemini', 'none', 'typo']) {
    const request = await application(t, { ...defaults(), TTS_PROVIDER: provider, FISH_API_KEY: 'artificial-unused-key' });
    const status = await request('/api/status');
    assert.equal(status.services.tts.ready, false);
    const response = await request.raw('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好。' }) });
    assert.equal(response.status, 503);
    const error = await response.json();
    assert.match(error.error, provider === 'doubao' ? /DOUBAO_API_KEY/ : provider === 'gemini' ? /GEMINI_API_KEY/ : provider === 'none' ? /关闭/ : /TTS_PROVIDER/);
  }
  assert.equal(calls, 0);
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

test('intentionally disabled speech produces a successful text program without a speech failure', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    return aiResponse();
  });
  const request = await application(t, { ...defaults(), TTS_PROVIDER: 'none', ANTHROPIC_API_KEY: 'artificial-ai-key', FISH_API_KEY: 'artificial-unused-key' });
  const response = await request('/api/chat', { message: '请生成文字节目。' });
  assert.ok(response.message.content.startsWith(plan.say));
  assert.deepEqual(response.speech, { disabled: true });
  assert.equal(calls, 1);
});
