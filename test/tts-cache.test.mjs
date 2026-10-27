import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTtsClient } from '../server/tts.mjs';

function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}

test('shared speech cache separates providers, Gemini model/voice/style and Doubao speaker/resource', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'radio-provider-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const audio = wav();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    if (String(url).includes('googleapis.com')) {
      return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: audio.toString('base64') }] }] });
    }
    if (String(url).includes('bytedance.com')) {
      return new Response(JSON.stringify({ code: 0, data: Buffer.from('ID3doubao').toString('base64') })
        + '\n' + JSON.stringify({ code: 20000000 }));
    }
    return new Response('ID3fish', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const settings = [
    { provider: 'fish' },
    { provider: 'doubao' },
    { provider: 'doubao', speaker: 'other-speaker' },
    { provider: 'doubao', resourceId: 'seed-icl-2.0' },
    { provider: 'gemini' },
    { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts' },
    { provider: 'gemini', voice: 'Charon' },
    { provider: 'gemini', style: '轻松、愉快。' },
  ];
  const results = await Promise.all(settings.map(options => createTtsClient({ apiKey: 'artificial-key', cacheDir, ...options }).synthesize('欢迎收听。')));
  assert.equal(new Set(results.map(result => result.url)).size, settings.length);
  assert.equal(calls, settings.length);
  const cached = await createTtsClient({ apiKey: 'another-artificial-key', provider: 'gemini', cacheDir }).synthesize('欢迎收听。');
  assert.deepEqual(cached, results[4]);
  assert.equal(calls, settings.length);
  assert.deepEqual(await readFile(join(cacheDir, cached.url.split('/').at(-1))), audio);
  assert.equal((await readdir(cacheDir)).length, settings.length);
});

test('failed or truncated provider output never leaves cached speech or temporary files', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'radio-provider-no-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('googleapis.com')
    ? Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'bm90LWF1ZGlv' }] }] })
    : new Response(JSON.stringify({ code: 0, data: Buffer.from('ID3truncated').toString('base64') }) + '\n'));
  for (const provider of ['gemini', 'doubao']) {
    await assert.rejects(createTtsClient({ provider, apiKey: 'artificial-key', cacheDir }).synthesize('你好。'));
  }
  assert.deepEqual(await readdir(cacheDir), []);
});
