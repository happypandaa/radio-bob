import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicClient, parseLyrics } from '../server/music.mjs';

test('timed lyrics are sorted, credit and metadata lines dropped, and translations attached', () => {
  const result = parseLyrics({
    lrc: { lyric: '{"t":0,"c":[{"tx":"作词: "}]}\n[ar:Someone]\n[00:12.50]Second line\n[00:02.1]First line\n[00:20.00][00:30.000]Chorus\n[00:25.00]\n' },
    tlyric: { lyric: '[00:02.10]第一行\n[00:12.50]Second line\n' },
  });
  assert.equal(result.status, 'synced');
  assert.deepEqual(result.lines, [
    { time: 2100, text: 'First line', translation: '第一行' },
    // A "translation" identical to the original adds nothing and is dropped.
    { time: 12500, text: 'Second line' },
    { time: 20000, text: 'Chorus' },
    { time: 30000, text: 'Chorus' },
  ]);
});

test('lyrics without timestamps, instrumentals and missing lyrics each get their own status', () => {
  assert.deepEqual(parseLyrics({ lrc: { lyric: 'one\ntwo\n' } }), { status: 'unsynced', lines: [{ text: 'one' }, { text: 'two' }] });
  assert.deepEqual(parseLyrics({ pureMusic: true, lrc: { lyric: '' } }), { status: 'instrumental', lines: [] });
  assert.deepEqual(parseLyrics({ lrc: { lyric: '[00:00.00]纯音乐，请欣赏' } }), { status: 'instrumental', lines: [] });
  assert.deepEqual(parseLyrics({ nolyric: true }), { status: 'none', lines: [] });
  assert.deepEqual(parseLyrics({}), { status: 'none', lines: [] });
  const long = parseLyrics({ lrc: { lyric: Array.from({ length: 600 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00]${'x'.repeat(400)}`).join('\n') } });
  assert.equal(long.lines.length, 400);
  assert.equal(long.lines[0].text.length, 300);
});

function routed(routes, cookie = 'MUSIC_U=private-session') {
  const calls = [];
  const client = createMusicClient({
    baseUrl: 'http://127.0.0.1:3000/', cookieProvider: () => cookie,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(init.body);
      calls.push({ path, body });
      return Response.json(routes[path](body));
    },
  });
  return { client, calls };
}

test('signed-in favorites come from NetEase likes in liked order; signed-out returns null', async () => {
  const song = id => ({ id, name: `Song ${id}`, ar: [{ name: 'Artist' }], al: { name: 'Album', picUrl: 'http://p1.music.126.net/c.jpg' }, dt: 1000 });
  const { client, calls } = routed({
    '/login/status': () => ({ code: 200, data: { profile: { userId: 42, nickname: 'Listener' } } }),
    '/likelist': () => ({ code: 200, ids: [3, 1, 2] }),
    '/user/playlist': () => ({ code: 200, playlist: [{ id: 9, specialType: 5 }, { id: 10, specialType: 0 }] }),
    '/playlist/track/all': () => ({ code: 200, songs: [song(2), song(1)] }),
    '/like': () => ({ code: 200 }),
  });
  const favorites = await client.favorites(50);
  assert.deepEqual(favorites.ids, ['3', '1', '2']);
  assert.deepEqual(favorites.tracks.map(track => track.id), ['2', '1']);
  assert.equal(favorites.tracks[0].cover, 'https://p1.music.126.net/c.jpg');
  assert.equal(calls.find(call => call.path === '/likelist').body.uid, 42);
  assert.equal(calls.find(call => call.path === '/playlist/track/all').body.id, '9');
  assert.deepEqual(await client.like('7', false), { liked: false });
  assert.equal(calls.at(-1).body.like, 'false');
  await assert.rejects(client.like('not-an-id'), { code: 'MUSIC_INVALID_INPUT' });

  const signedOut = routed({ '/login/status': () => ({ code: 200, data: { profile: null } }) });
  assert.equal(await signedOut.client.favorites(), null);
  await assert.rejects(signedOut.client.like('7'), { code: 'MUSIC_LOGIN_REQUIRED' });
});
