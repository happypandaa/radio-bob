import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicClient, MusicError } from '../server/music.mjs';

function fixture(responses, options = {}) {
  const calls = [];
  const client = createMusicClient({
    baseUrl: 'http://127.0.0.1:3000/music/',
    cookieProvider: () => 'MUSIC_U=private-session',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init, parsedBody: init.body ? JSON.parse(init.body) : undefined });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response instanceof Response ? response : Response.json(response);
    },
    ...options,
  });
  return { client, calls };
}

test('search normalizes upstream tracks and keeps the session only in the POST body', async () => {
  const { client, calls } = fixture([{ code: 200, result: { songs: [
    { id: 123, name: 'Song', ar: [{ name: 'A' }, { name: 'B' }], al: { name: 'Album', picUrl: 'https://example.com/cover.jpg' }, dt: 180000 },
    { id: 456, name: 'Legacy', artists: [{ name: 'C' }], album: { name: 'Old', picUrl: 'javascript:alert(1)' }, duration: 200000 },
  ] } }]);
  assert.deepEqual(await client.search('Song', 2), [
    { id: '123', title: 'Song', artist: 'A / B', album: 'Album', cover: 'https://example.com/cover.jpg', durationMs: 180000 },
    { id: '456', title: 'Legacy', artist: 'C', album: 'Old', cover: '', durationMs: 200000 },
  ]);
  assert.equal(calls[0].method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/music/cloudsearch');
  assert.equal(calls[0].url.includes('private-session'), false);
  assert.equal(calls[0].url.includes('cookie'), false);
  assert.equal(calls[0].parsedBody.cookie, 'MUSIC_U=private-session');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].parsedBody.noCookie, true);
});

test('search treats a genuine empty result as empty, and rejects malformed results', async () => {
  const { client, calls } = fixture([{ code: 200, result: { songCount: 0 } }, { code: 200 }]);
  assert.deepEqual(await client.search('  '), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.search('no matches'), []);
  await assert.rejects(client.search('bad result'), { code: 'MUSIC_BAD_RESPONSE' });
});

test('resolve preserves preview restrictions and never requests unblocking', async () => {
  const { client, calls } = fixture([{ code: 200, data: [{
    id: 123, code: 200, url: 'https://example.com/trial.mp3', time: 180000,
    freeTrialInfo: { start: 30, end: 60 },
  }] }, { code: 200, data: [{ id: 123, code: 200, url: 'https://example.com/song.mp3', freeTrialInfo: null, time: 180000 }] }]);
  assert.deepEqual(await client.resolve('123'), { url: 'https://example.com/trial.mp3', preview: true, durationMs: 30000, previewStartMs: 30000 });
  assert.deepEqual(await client.resolve('123'), { url: 'https://example.com/song.mp3', preview: false, durationMs: 180000 });
  assert.equal(calls[0].parsedBody.unblock, 'false');
  assert.equal(calls[0].parsedBody.level, 'standard');
  assert.notEqual(calls[0].url, calls[1].url);
});

test('official NetEase HTTP media upgrades to HTTPS without changing signatures or preview restrictions', async () => {
  const signedPath = '/artificial%2Fmedia/song.mp3?auth=artificial%2Bsignature%3D&token=keep%2Fthese%25bytes';
  const { client, calls } = fixture([{ code: 200, data: [{
    id: 123, code: 200, url: `http://m802.music.126.net${signedPath}`, time: 180000,
    freeTrialInfo: { start: 30, end: 60 },
  }] }]);
  assert.deepEqual(await client.resolve('123'), {
    url: `https://m802.music.126.net${signedPath}`, preview: true, durationMs: 30000, previewStartMs: 30000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsedBody.unblock, 'false');
  assert.equal(calls[0].parsedBody.level, 'standard');
});

test('media TLS normalization never rewrites unrelated domains or unusual ports, or bypasses a denied song', async () => {
  const urls = [
    'http://music.126.net.attacker.invalid/song.mp3?token=artificial',
    'http://notmusic.126.net/song.mp3?token=artificial',
    'http://m802.music.126.net:8080/song.mp3?token=artificial',
    'https://m802.music.126.net/song.mp3?token=artificial',
  ];
  const { client } = fixture(urls.map(url => ({ code: 200, data: [{ id: 123, code: 200, url, freeTrialInfo: null }] })).concat([
    { code: 200, data: [{ id: 123, code: 403, url: 'http://m802.music.126.net/denied.mp3' }] },
  ]));
  for (const url of urls) assert.deepEqual(await client.resolve('123'), { url, preview: false });
  await assert.rejects(client.resolve('123'), { code: 'MUSIC_UNAVAILABLE', status: 422 });
});

test('resolve rejects missing, mismatched, or unsafe playback URLs', async () => {
  const { client } = fixture([
    { code: 200, data: [{ id: 123, code: 404, url: null, fee: 1 }] },
    { code: 200, data: [{ id: 999, url: 'https://example.com/wrong.mp3' }] },
    { code: 200, data: [{ id: 123, url: 'file:///private/secret.mp3' }] },
  ]);
  await assert.rejects(client.resolve('123'), { code: 'MUSIC_UNAVAILABLE', status: 422 });
  await assert.rejects(client.resolve('123'), { code: 'MUSIC_BAD_RESPONSE' });
  await assert.rejects(client.resolve('123'), { code: 'MUSIC_UNAVAILABLE' });
  await assert.rejects(client.resolve('123&unblock=true'), { code: 'MUSIC_INVALID_INPUT' });
});

test('QR creation and polling use fresh requests without an existing account cookie', async () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  const { client, calls } = fixture([
    { code: 200, data: { code: 200, unikey: 'opaque-key' } },
    { code: 200, data: { qrimg: image } },
    { code: 801, cookie: 'must-not-leak' },
    { code: 802, nickname: 'Listener', cookie: 'must-not-leak' },
    { code: 803, cookie: 'MUSIC_U=new-private-session', nickname: 'Listener' },
    { code: 800, cookie: 'must-not-leak' },
  ]);
  assert.deepEqual(await client.createQr(), { key: 'opaque-key', image });
  assert.deepEqual(await client.checkQr('opaque-key'), { status: 'waiting' });
  assert.deepEqual(await client.checkQr('opaque-key'), { status: 'scanned', nickname: 'Listener' });
  assert.deepEqual(await client.checkQr('opaque-key'), { status: 'authorized', cookie: 'MUSIC_U=new-private-session', nickname: 'Listener' });
  assert.deepEqual(await client.checkQr('opaque-key'), { status: 'expired' });
  assert.equal(calls.every((call) => !('cookie' in call.parsedBody)), true);
  assert.equal(calls.every((call) => !call.url.includes('opaque-key')), true);
  assert.equal(new Set(calls.map((call) => call.url)).size, calls.length);
});

test('QR authorization without a session fails instead of claiming a successful login', async () => {
  const { client } = fixture([{ code: 803, message: 'MUSIC_U=secret' }]);
  await assert.rejects(client.checkQr('key'), { code: 'MUSIC_BAD_RESPONSE' });
});

test('account reports an actual profile, anonymous state, and an expired session correctly', async () => {
  const { client } = fixture([
    { data: { code: 200, profile: { userId: 1, nickname: 'Listener' }, cookie: 'never-return' } },
    { data: { code: 200, profile: null, account: { id: 999 } } },
    { code: 301, msg: 'MUSIC_U=secret' },
  ]);
  assert.deepEqual(await client.account(), { loggedIn: true, nickname: 'Listener' });
  assert.deepEqual(await client.account(), { loggedIn: false });
  assert.deepEqual(await client.account(), { loggedIn: false });
});

test('network, HTTP, and non-JSON errors never include upstream secrets', async () => {
  const secret = 'MUSIC_U=very-private-token';
  const { client } = fixture([
    new Error(`fetch failed at https://example.com/?cookie=${secret}`),
    new Response(`<html>${secret}</html>`, { status: 502 }),
    new Response(`<html>${secret}</html>`, { status: 200 }),
    { code: 500, message: secret },
  ]);
  for (const code of ['MUSIC_SERVICE_UNAVAILABLE', 'MUSIC_UPSTREAM_ERROR', 'MUSIC_BAD_RESPONSE', 'MUSIC_UPSTREAM_ERROR']) {
    await assert.rejects(client.search('test'), (error) => {
      assert.ok(error instanceof MusicError);
      assert.equal(error.code, code);
      assert.equal(String(error.stack).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('request timeout is actionable and health failures are false', async () => {
  const client = createMusicClient({
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('private upstream details')), { once: true });
    }),
  });
  await assert.rejects(client.search('test'), { code: 'MUSIC_SERVICE_TIMEOUT', status: 504 });
  assert.equal(await client.health(), false);
});

test('health checks only local reachability and does not read the user session', async () => {
  const { client, calls } = fixture([new Response('<html>local service</html>')], {
    cookieProvider: () => { throw new Error('health must not request credentials'); },
  });
  assert.equal(await client.health(), true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
});

test('configuration rejects URLs that could place credentials in request URLs', () => {
  assert.throws(() => createMusicClient({ baseUrl: 'https://user:password@example.com' }), { code: 'MUSIC_INVALID_CONFIG' });
  assert.throws(() => createMusicClient({ baseUrl: 'https://example.com?cookie=secret' }), { code: 'MUSIC_INVALID_CONFIG' });
});
