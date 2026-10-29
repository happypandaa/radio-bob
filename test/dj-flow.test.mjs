import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRadioApplication } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { controlIntent } from '../server/router.mjs';
import { baseTitle, bestMatch, scoreMatch } from '../server/match.mjs';

const localFetch = globalThis.fetch;
const TOKEN = 'artificial-dj-flow-instance-token';

test('track matching accepts remaster suffixes and joined artists but rejects other songs and covers', () => {
  assert.equal(baseTitle("Truckin' (2013 Remaster)"), "Truckin'");
  assert.equal(baseTitle('Ripple - Remastered 2001'), 'Ripple');
  assert.equal(baseTitle('稻香（Live）'), '稻香');
  const wanted = { title: "Truckin'", artist: 'Grateful Dead' };
  const original = { id: '1', title: "Truckin' (2013 Remaster)", artist: 'Grateful Dead' };
  const live = { id: '2', title: "Truckin' - Live at Winterland", artist: 'Grateful Dead' };
  const cover = { id: '3', title: "Truckin'", artist: 'Some Tribute Band' };
  assert.equal(bestMatch(wanted, [cover, live, original]).id, '1');
  assert.ok(scoreMatch(wanted, original) > scoreMatch(wanted, live));
  assert.equal(scoreMatch(wanted, cover), 0);
  assert.equal(bestMatch({ title: 'October Song', artist: 'The Incredible String Band' },
    [{ id: '4', title: 'October Song', artist: 'Incredible String Band' }]).id, '4');
  assert.equal(bestMatch({ title: '稻香', artist: '周杰伦' }, [{ id: '5', title: '稻香', artist: '周杰伦 / 合唱团' }]).id, '5');
  assert.equal(bestMatch({ title: 'Ok', artist: 'Artist' }, [{ id: '6', title: 'Okie From Muskogee', artist: 'Artist' }]), null);
  // An explicitly requested live version is not penalised.
  assert.equal(bestMatch({ title: 'Dark Star (Live)', artist: 'Grateful Dead' },
    [{ id: '7', title: 'Dark Star - Live', artist: 'Grateful Dead' }]).id, '7');
});

test('short replies are recognised as accepting Bob\'s next set without swallowing requests', () => {
  for (const reply of ['好', '好的！', 'ok', '来吧', '接着放']) assert.equal(controlIntent(reply), 'accept');
  assert.equal(controlIntent('好想听爵士'), null);
  assert.equal(controlIntent('继续'), 'play');
});

test('replaying speech finds messages older than the visible history window', () => {
  const root = mkdtempSync(join(tmpdir(), 'radio-bob-message-'));
  const store = createStore(root);
  try {
    const first = store.addMessage('assistant', '很早的一段口播');
    for (let index = 0; index < 70; index += 1) store.addMessage('user', `消息 ${index}`);
    assert.equal(store.state().messages.some(message => message.id === first.id), false);
    assert.equal(store.message(first.id).content, '很早的一段口播');
    assert.equal(store.message('missing'), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

const catalogue = {
  'Ripple Grateful Dead': [{ id: 101, name: 'Ripple (2015 Remaster)', ar: [{ name: 'Grateful Dead' }], al: { name: 'American Beauty' }, dt: 250000 }],
  'Cocaine Blues Muddy Waters': [{ id: 102, name: 'Cocaine Blues', ar: [{ name: 'Muddy Waters' }], al: { name: 'Folk Singer' }, dt: 200000 }],
  'October Song The Incredible String Band': [{ id: 103, name: 'October Song', ar: [{ name: 'Incredible String Band' }], al: { name: 'ISB' }, dt: 210000 }],
  'Box of Rain Grateful Dead': [{ id: 104, name: 'Box of Rain', ar: [{ name: 'Grateful Dead' }], al: { name: 'American Beauty' }, dt: 300000 }],
};
const firstPlan = { say: '先来两首。', play: [{ title: 'Ripple', artist: 'Grateful Dead' }, { title: 'Cocaine Blues', artist: 'Muddy Waters' }], reason: '', segue: '' };
const outroPlan = { say: '这一组差不多了。顺着这个感觉继续，还是换点别的？', play: [
  { title: 'Ripple', artist: 'Grateful Dead' },
  { title: 'October Song', artist: 'The Incredible String Band' },
  { title: 'Box of Rain', artist: 'Grateful Dead' }], reason: '', segue: '' };

async function application(t, plans) {
  const root = await mkdtemp(join(tmpdir(), 'radio-dj-flow-'));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages');
    const body = JSON.parse(options.body);
    requests.push(JSON.parse(body.messages[0].content));
    const plan = plans.shift();
    return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] });
  });
  const app = createRadioApplication({
    root, env: { ANTHROPIC_API_KEY: 'artificial-dj-flow-key' }, dataDir: join(root, 'data'), cacheDir: join(root, 'cache'),
    managed: { instanceId: 'artificial_dj_flow', token: TOKEN },
    musicTransport: {
      health: async () => true,
      async request(path, params) {
        assert.equal(path, '/cloudsearch');
        const songs = catalogue[params.keywords] || [];
        return { ok: true, status: 200, body: { code: 200, result: { songs, songCount: songs.length } } };
      },
    },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, data) => {
    const response = await localFetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, requests };
}

test('end of a set: Bob wraps up once, proposes fresh songs, and a short reply starts them', async t => {
  const { call, requests } = await application(t, [firstPlan, outroPlan]);
  const chat = await call('/api/chat', { message: '来点老派的' });
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.body.queue.map(track => track.id), ['101', '102']);

  assert.equal((await call('/api/dj/outro', { lastTrackId: '101' })).status, 409, 'only the last song can trigger the outro');
  const outro = await call('/api/dj/outro', { lastTrackId: '102' });
  assert.equal(outro.status, 200);
  assert.equal(outro.body.message.content, outroPlan.say);
  // Songs from the set that just played are not proposed again.
  assert.deepEqual(outro.body.tracks.map(track => track.id), ['103', '104']);
  assert.equal(requests[1].segment, 'queue-ending');
  assert.deepEqual(requests[1].justPlayed.map(track => track.title), ['Ripple (2015 Remaster)', 'Cocaine Blues']);
  assert.equal(requests[0].segment, undefined);
  // The current queue is untouched until the listener answers.
  assert.deepEqual((await call('/api/state')).body.queue.map(track => track.id), ['101', '102']);
  assert.equal((await call('/api/dj/outro', { lastTrackId: '102' })).status, 409, 'one outro per set');

  // "继续" while music is still playing keeps its old meaning.
  const resume = await call('/api/chat', { message: '继续', playerState: 'playing' });
  assert.equal(resume.body.control.action, 'play');
  const accept = await call('/api/chat', { message: '好' });
  assert.equal(accept.body.control.action, 'start-queue');
  assert.deepEqual(accept.body.queue.map(track => track.id), ['103', '104']);
  assert.deepEqual((await call('/api/state')).body.queue.map(track => track.id), ['103', '104']);
  // Once accepted, "好" is an ordinary play command.
  assert.equal((await call('/api/chat', { message: '好' })).body.control.action, 'play');
});

test('a queue replaced by the listener cancels the pending proposal', async t => {
  const { call } = await application(t, [firstPlan, outroPlan]);
  await call('/api/chat', { message: '来点老派的' });
  await call('/api/dj/outro', { lastTrackId: '102' });
  await call('/api/queue', { mode: 'replace', tracks: [{ id: '900', title: '自己选的歌', artist: '某人' }] });
  const reply = await call('/api/chat', { message: '好' });
  assert.equal(reply.body.control.action, 'play');
  assert.deepEqual(reply.body.queue.map(track => track.id), ['900']);
});
