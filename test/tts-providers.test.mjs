import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoubaoProvider, createGeminiProvider } from '../server/tts-providers.mjs';

const mp3 = Buffer.from('ID3test-audio');
const secret = 'test-only-provider-secret';

function wave() {
  const result = Buffer.alloc(48);
  result.write('RIFF', 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(24000, 24);
  result.writeUInt32LE(48000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(4, 40);
  result.writeInt16LE(123, 44);
  result.writeInt16LE(-123, 46);
  return result;
}

const wav = wave();
const doubaoPacket = (data = mp3, code = 0) => JSON.stringify({ code, data: data === null ? null : data.toString('base64') });
const doubaoDone = JSON.stringify({ code: 20000000, data: null });
const doubaoResponse = () => new Response(`${doubaoPacket()}\n${doubaoDone}\n`);
const geminiPayload = (data = wav, extra = {}) => ({
  status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: data.toString('base64') }] }], ...extra,
});

function streamed(chunks, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    controller.close();
  } }), { headers });
}

function factories() {
  return [['DOUBAO', createDoubaoProvider], ['GEMINI', createGeminiProvider]];
}

function safeError(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('private upstream body'), false);
    return true;
  };
}

test('provider metadata contains effective configuration and no API keys', () => {
  const doubao = createDoubaoProvider({ apiKey: secret });
  const gemini = createGeminiProvider({ apiKey: secret });
  for (const provider of [doubao, gemini]) {
    assert.equal(provider.configured, true);
    assert.equal(provider.configurationError, null);
    assert.equal(provider.configurationCode, null);
    assert.equal(JSON.stringify(provider).includes(secret), false);
    assert.equal(provider.cacheIdentity.provider, provider.id);
  }
  assert.equal(doubao.id, 'doubao');
  assert.equal(doubao.model, 'seed-tts-2.0');
  assert.equal(doubao.voice, 'zh_female_vv_uranus_bigtts');
  assert.equal(doubao.format, 'mp3');
  assert.equal(gemini.id, 'gemini');
  assert.equal(gemini.model, 'gemini-3.8-flash-tts');
  assert.equal(gemini.voice, 'Kore');
  assert.equal(gemini.format, 'wav');
  assert.deepEqual(createDoubaoProvider({ apiKey: 'another-key' }).cacheIdentity, doubao.cacheIdentity);
  assert.deepEqual(createGeminiProvider({ apiKey: 'another-key' }).cacheIdentity, gemini.cacheIdentity);
  assert.notDeepEqual(createDoubaoProvider({ apiKey: secret, speaker: 'another-speaker' }).cacheIdentity, doubao.cacheIdentity);
  assert.notDeepEqual(createDoubaoProvider({ apiKey: secret, resourceId: 'another-resource' }).cacheIdentity, doubao.cacheIdentity);
  for (const config of [{ model: 'gemini-3.8-flash-lite-tts' }, { voice: 'Puck' }, { style: '轻声说话' }]) {
    assert.notDeepEqual(createGeminiProvider({ apiKey: secret, ...config }).cacheIdentity, gemini.cacheIdentity);
  }
});

test('missing or invalid configuration never makes requests and provides Chinese errors', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('unexpected request'); });
  for (const [prefix, factory] of factories()) {
    const missing = factory();
    assert.equal(missing.configured, false);
    assert.match(missing.configurationError, new RegExp(`${prefix}_API_KEY`));
    await assert.rejects(missing.generate('你好。'), { code: `${prefix}_NOT_CONFIGURED`, status: 503 });
    const invalid = factory({ apiKey: 'embedded\nkey' });
    assert.equal(invalid.configured, false);
    await assert.rejects(invalid.generate('你好。'), { code: `${prefix}_INVALID_CONFIGURATION`, status: 400 });
  }
  for (const config of [{ resourceId: '' }, { resourceId: 'bad id' }, { speaker: '' }, { speaker: 'bad\nvoice' }]) {
    const provider = createDoubaoProvider({ apiKey: secret, ...config });
    assert.equal(provider.configured, false);
    await assert.rejects(provider.generate('你好。'), { code: 'DOUBAO_INVALID_CONFIGURATION' });
  }
  for (const model of ['gemini-2.5-flash-preview-tts', 'wrong-model', '', null]) {
    const provider = createGeminiProvider({ apiKey: secret, model });
    assert.equal(provider.configured, false);
    await assert.rejects(provider.generate('你好。'), { code: 'GEMINI_INVALID_MODEL' });
  }
  for (const config of [{ voice: '' }, { voice: 'bad voice' }, { style: 'x'.repeat(2001) }, { style: null }]) {
    const provider = createGeminiProvider({ apiKey: secret, ...config });
    assert.equal(provider.configured, false);
    await assert.rejects(provider.generate('你好。'), { code: 'GEMINI_INVALID_CONFIGURATION' });
  }
  assert.equal(calls, 0);
});

test('both providers reject missing or oversized speech without network requests', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; });
  for (const [prefix, factory] of factories()) {
    for (const input of ['', '   ', null, '字'.repeat(801)]) {
      await assert.rejects(factory({ apiKey: secret }).generate(input), { code: `${prefix}_INVALID_TEXT`, status: 400 });
    }
  }
  assert.equal(calls, 0);
});

test('Doubao sends only the new API key authentication and the documented MP3 request', async (t) => {
  const ids = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-Api-Key'], secret);
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.match(options.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/u);
    ids.push(options.headers['X-Api-Request-Id']);
    assert.equal(options.headers['X-Api-App-Id'], undefined);
    assert.equal(options.headers['X-Api-Access-Key'], undefined);
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), {
      req_params: { text: '欢迎收听。', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } },
    });
    return doubaoResponse();
  });
  const provider = createDoubaoProvider({ apiKey: ` ${secret} ` });
  assert.deepEqual(await provider.generate(' 欢迎收听。 '), mp3);
  assert.deepEqual(await provider.generate('欢迎收听。'), mp3);
  assert.notEqual(ids[0], ids[1]);
});

test('Doubao accepts NDJSON split across bytes, UTF-8 boundaries, lines and termination frames', async (t) => {
  const first = mp3.subarray(0, 5);
  const second = mp3.subarray(5);
  const text = `\uFEFF${JSON.stringify({ code: 0, data: null, sentence: '你好' })}\r\n${doubaoPacket(first)}\n${doubaoPacket(second, 20000000)}`;
  const bytes = Buffer.from(text);
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  t.mock.method(globalThis, 'fetch', async () => streamed(chunks));
  assert.deepEqual(await createDoubaoProvider({ apiKey: secret }).generate('你好。'), mp3);
});

test('Doubao accepts SSE events and multiline data while cancelling after successful termination', async (t) => {
  let cancelled = false;
  const body = `: heartbeat\r\nevent: message\r\ndata: {"code":0,\r\ndata: "data":"${mp3.toString('base64')}"}\r\n\r\ndata: ${doubaoDone}\n\n`;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(body.slice(0, 21)));
    controller.enqueue(Buffer.from(body.slice(21)));
  }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(await createDoubaoProvider({ apiKey: secret }).generate('你好。'), mp3);
  assert.equal(cancelled, true);
});

test('Doubao requires a successful terminal frame and actual MP3 data', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  for (const [value, code] of [
    [`${doubaoPacket()}\n`, 'DOUBAO_INCOMPLETE_AUDIO'],
    [doubaoDone, 'DOUBAO_INVALID_AUDIO'],
    [`${doubaoPacket(Buffer.from('not MP3'))}\n${doubaoDone}\n`, 'DOUBAO_INVALID_AUDIO'],
    ['{"code":0,"data":"not@@base64"}\n', 'DOUBAO_INVALID_AUDIO'],
    ['not JSON\n', 'DOUBAO_INVALID_RESPONSE'],
    ['{"data":"test"}\n', 'DOUBAO_INVALID_RESPONSE'],
    ['[DONE]\n', 'DOUBAO_INCOMPLETE_AUDIO'],
  ]) {
    body = value;
    await assert.rejects(createDoubaoProvider({ apiKey: secret }).generate('你好。'), { code, status: 502 });
  }
});

test('Doubao handles service errors after audio chunks without leaking service messages', async (t) => {
  let serviceCode;
  t.mock.method(globalThis, 'fetch', async () => new Response(`${doubaoPacket()}\n${JSON.stringify({ code: serviceCode, message: `private upstream body ${secret}`, data: null })}\n`));
  for (const [remote, local] of [[45000000, 'DOUBAO_REJECTED'], [45000001, 'DOUBAO_BAD_REQUEST'],
    [45002000, 'DOUBAO_BAD_REQUEST'], [45002001, 'DOUBAO_INVALID_TEXT'], [40402003, 'DOUBAO_TEXT_LIMIT'],
    [55000000, 'DOUBAO_GENERATION_FAILED'], [99999999, 'DOUBAO_GENERATION_FAILED']]) {
    serviceCode = remote;
    await assert.rejects(createDoubaoProvider({ apiKey: secret }).generate('你好。'), (error) => {
      safeError(local, 502)(error);
      assert.equal(error.upstreamCode, remote);
      return true;
    });
  }
});

test('Gemini sends the current Interactions API schema and keeps style outside the transcript', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['x-goog-api-key'], secret);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), {
      model: 'gemini-3.8-flash-lite-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: '欢迎收听。', annotations: [{ type: 'speech_metadata', style: '轻声说话' }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: 'Puck' }] },
    });
    return Response.json(geminiPayload());
  });
  const result = await createGeminiProvider({ apiKey: secret, model: 'gemini-3.8-flash-lite-tts', voice: 'Puck', style: '轻声说话' }).generate(' 欢迎收听。 ');
  assert.deepEqual(result, wav);
  assert.equal(result.length, wav.length);
});

test('Gemini accepts fragmented JSON and selects the last model audio block', async (t) => {
  const payload = geminiPayload(wav, { steps: [
    { type: 'user_input', content: [{ type: 'audio', data: 'not-audio' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'ignored' }, { type: 'audio', data: 'discarded' }] },
    { type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] },
  ] });
  const bytes = Buffer.from(JSON.stringify(payload));
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(JSON.parse(options.body).input[0].content[0].annotations, undefined);
    return streamed(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  });
  assert.deepEqual(await createGeminiProvider({ apiKey: secret, style: '' }).generate('你好。'), wav);
});

test('Gemini rejects malformed, missing, truncated, non-WAV and failed audio responses', async (t) => {
  let payload;
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  const truncated = Buffer.from(wav);
  truncated.writeUInt32LE(10000, 40);
  for (const value of [
    {}, geminiPayload(Buffer.from('raw PCM')), geminiPayload(truncated), geminiPayload(wav.subarray(0, 44)),
    geminiPayload(wav, { status: 'failed', error: { message: secret } }),
    geminiPayload(wav, { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16', data: wav.toString('base64') }] }] }),
    geminiPayload(wav, { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 123, data: wav.toString('base64') }] }] }),
  ]) {
    payload = value;
    await assert.rejects(createGeminiProvider({ apiKey: secret }).generate('你好。'), safeError('GEMINI_INVALID_AUDIO', 502));
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not json'));
  await assert.rejects(createGeminiProvider({ apiKey: secret }).generate('你好。'), { code: 'GEMINI_INVALID_RESPONSE' });
});

test('both providers map HTTP authentication, billing and rate errors without reading or leaking bodies', async (t) => {
  let response;
  let cancels = 0;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const [prefix, factory] of factories()) {
    for (const [status, code] of [[400, 'BAD_REQUEST'], [401, 'UNAUTHORIZED'], [402, 'PAYMENT_REQUIRED'],
      [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [413, 'TEXT_LIMIT'], [429, 'RATE_LIMITED'], [503, 'UNAVAILABLE'], [500, 'REQUEST_FAILED']]) {
      response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(`private upstream body ${secret}`));
      }, cancel() { cancels += 1; } }), { status });
      await assert.rejects(factory({ apiKey: secret }).generate('你好。'), safeError(`${prefix}_${code}`, status === 429 ? 429 : 502));
    }
  }
  assert.equal(cancels, 18);
});

test('both providers sanitize network failures, including forged local error codes', async (t) => {
  let calls = 0;
  for (const [prefix, factory] of factories()) {
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      throw Object.assign(new Error(`private upstream body ${secret}`), { code: `${prefix}_FORGED` });
    });
    await assert.rejects(factory({ apiKey: secret }).generate('你好。'), safeError(`${prefix}_UNAVAILABLE`, 503));
  }
  assert.equal(calls, 2);
});

test('both providers enforce declared response limits before buffering data', async (t) => {
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
    headers: { 'content-length': '40000001' },
  }));
  for (const [prefix, factory] of factories()) {
    await assert.rejects(factory({ apiKey: secret }).generate('你好。'), { code: `${prefix}_OUTPUT_LIMIT` });
  }
  assert.equal(cancelled, 2);
});

test('both providers bound actual response bytes when content-length is absent or false', async (t) => {
  let cancelled = 0;
  const block = Buffer.alloc(1_000_000, 0x20);
  t.mock.method(globalThis, 'fetch', async () => {
    let count = 0;
    return new Response(new ReadableStream({ pull(controller) {
      count += 1;
      controller.enqueue(block);
      if (count === 50) controller.close();
    }, cancel() { cancelled += 1; } }), { headers: { 'content-length': '1' } });
  });
  for (const [prefix, factory] of factories()) {
    await assert.rejects(factory({ apiKey: secret }).generate('你好。'), { code: `${prefix}_OUTPUT_LIMIT` });
  }
  assert.equal(cancelled, 2);
});

test('both providers enforce the 20 MB decoded audio limit before allocating oversized audio', async (t) => {
  const base64 = 'A'.repeat(26_666_668);
  for (const [prefix, factory] of factories()) {
    t.mock.method(globalThis, 'fetch', async () => prefix === 'DOUBAO'
      ? new Response(`${JSON.stringify({ code: 0, data: base64 })}\n${doubaoDone}\n`)
      : Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: base64 }] }] }));
    await assert.rejects(factory({ apiKey: secret }).generate('你好。'), { code: `${prefix}_OUTPUT_LIMIT` });
  }
});

test('both providers apply a 60 second deadline even if fetch ignores its abort signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const [prefix, factory] of factories()) {
      let notify;
      const started = new Promise((resolve) => { notify = resolve; });
      t.mock.method(globalThis, 'fetch', async () => { notify(); return new Promise(() => {}); });
      const pending = factory({ apiKey: secret }).generate('你好。');
      await started;
      t.mock.timers.tick(60_000);
      await assert.rejects(pending, safeError(`${prefix}_TIMEOUT`, 504));
    }
  } finally { t.mock.timers.reset(); }
});

test('the same deadline includes response body consumption and cancels stalled streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  try {
    for (const [prefix, factory] of factories()) {
      let notify;
      const started = new Promise((resolve) => { notify = resolve; });
      t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
        pull() { notify(); return new Promise(() => {}); }, cancel() { cancelled += 1; },
      })));
      const pending = factory({ apiKey: secret }).generate('你好。');
      await started;
      t.mock.timers.tick(60_000);
      await assert.rejects(pending, safeError(`${prefix}_TIMEOUT`, 504));
    }
    assert.equal(cancelled, 2);
  } finally { t.mock.timers.reset(); }
});
