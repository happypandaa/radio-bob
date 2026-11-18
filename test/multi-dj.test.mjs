import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createRadioApplication } from '../server/app.mjs';
import { DEFAULT_DJS } from '../server/djs.mjs';

const localFetch = globalThis.fetch;
const alice = { ...DEFAULT_DJS[0], id: 'alice', name: 'Alice', stationName: 'Radio Alice', avatar: '/assets/bob-avatar.svg', persona: '你是 Alice，一位热爱爵士乐的电台 DJ。' };
const djs = [...DEFAULT_DJS, alice];
const bobTrack = { id: '101', title: 'Ripple', artist: 'Grateful Dead' };
const aliceTrack = { id: '202', title: 'Blue in Green', artist: 'Miles Davis' };

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'radio-multi-dj-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('legacy Bob messages, queue and play history migrate without leaking into a second DJ', t => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, '.data'));
  const legacy = new DatabaseSync(join(root, '.data', 'state.db'));
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, tracks_json TEXT NOT NULL, speech_url TEXT);
    CREATE TABLE plays (id TEXT PRIMARY KEY, track_id TEXT, title TEXT, artist TEXT, action TEXT, played_at TEXT, position_ms INTEGER);
    CREATE TABLE plans (id TEXT PRIMARY KEY, created_at TEXT, reason TEXT, segue TEXT, tracks_json TEXT);
    INSERT INTO messages VALUES ('old-message','assistant','原来的 Bob 对话','2026-11-01T00:00:00Z','[]','/tts/old.mp3');
    INSERT INTO plays VALUES ('old-play','101','Ripple','Grateful Dead','play','2026-11-01T00:00:00Z',5000);
  `);
  legacy.prepare('INSERT INTO settings VALUES (?,?)').run('queue', JSON.stringify([bobTrack]));
  legacy.prepare('INSERT INTO settings VALUES (?,?)').run('nowPlayingId', JSON.stringify('101'));
  legacy.prepare('INSERT INTO settings VALUES (?,?)').run('lastPlan', JSON.stringify({ id: 'old-plan', tracks: [bobTrack] }));
  legacy.close();
  const store = createStore(root, { djs });
  try {
    const bob = store.forDj('bob');
    const other = store.forDj('alice');
    assert.equal(store.state().djId, 'bob');
    assert.equal(bob.state().messages[0].content, '原来的 Bob 对话');
    assert.equal(bob.message('old-message').speechUrl, '/tts/old.mp3');
    assert.deepEqual(bob.state().queue, [bobTrack]);
    assert.equal(bob.state().nowPlayingId, '101');
    assert.equal(bob.state().lastPlan.id, 'old-plan');
    assert.equal(bob.recentPlays()[0].title, 'Ripple');
    assert.deepEqual(other.state().messages, []);
    assert.deepEqual(other.state().queue, []);
    assert.deepEqual(other.recentPlays(), []);
    assert.equal(other.message('old-message'), undefined);
    other.speech('old-message', '/tts/incorrect.mp3');
    assert.equal(bob.message('old-message').speechUrl, '/tts/old.mp3');
    assert.equal(JSON.stringify(store.state()).includes('persona'), false, 'only public DJ metadata is exposed');
  } finally { store.close(); }
});

test('DJ selection and independent histories survive restart and removing the temporary DJ', t => {
  const root = temporaryRoot(t);
  let store = createStore(root, { djs });
  try {
    store.setTaste('喜欢自然的演奏');
    store.set('musicCookie', 'artificial-private-cookie');
    store.addMessage('user', 'Bob 的历史');
    store.set('queue', [bobTrack]);
    store.selectDj('alice');
    store.addMessage('user', 'Alice 的历史');
    store.set('queue', [aliceTrack]);
    store.set('nowPlayingId', aliceTrack.id);
    store.recordPlan({ reason: '爵士', segue: '' }, [aliceTrack]);
    store.recordPlay(aliceTrack, 'play');
    store.close();
    store = createStore(root, { djs });
    assert.equal(store.state().djId, 'alice');
    assert.deepEqual(store.state().messages.map(item => item.content), ['Alice 的历史']);
    assert.deepEqual(store.state().queue, [aliceTrack]);
    assert.equal(store.state().nowPlayingId, '202');
    assert.equal(store.state().lastPlan.reason, '爵士');
    assert.equal(store.state().taste, '喜欢自然的演奏');
    assert.equal(JSON.stringify(store.state()).includes('artificial-private-cookie'), false);
    store.close();
    store = createStore(root);
    assert.equal(store.state().djId, 'bob', 'removed selection falls back to the shipped DJ');
    assert.deepEqual(store.state().djs.map(dj => dj.id), ['bob']);
    assert.deepEqual(store.state().messages.map(item => item.content), ['Bob 的历史']);
    assert.deepEqual(store.state().queue, [bobTrack]);
    assert.throws(() => store.selectDj('alice'), { status: 404 });
    store.close();
    store = createStore(root, { djs });
    store.selectDj('alice');
    assert.deepEqual(store.state().messages.map(item => item.content), ['Alice 的历史'], 'removing a definition never deletes saved history');
  } finally { store.close(); }
});

test('switching during a pending programme keeps AI context, responses and queues with their DJ', async t => {
  const root = temporaryRoot(t);
  let beginBob;
  const bobStarted = new Promise(resolve => { beginBob = resolve; });
  let finishBob;
  const bobRelease = new Promise(resolve => { finishBob = resolve; });
  t.after(() => finishBob());
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages');
    const request = JSON.parse(options.body);
    requests.push(request);
    const isAlice = request.system.startsWith(alice.persona);
    if (!isAlice) { beginBob(); await bobRelease; }
    const track = isAlice ? aliceTrack : bobTrack;
    const plan = { say: isAlice ? 'Alice 的爵士节目' : 'Bob 的摇滚节目', play: [{ title: track.title, artist: track.artist }], reason: '', segue: '' };
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] });
  });
  const app = createRadioApplication({ root, djs, env: { ANTHROPIC_API_KEY: 'artificial-multi-dj-key' }, musicTransport: {
    health: async () => true,
    async request(path, params) {
      assert.equal(path, '/cloudsearch');
      const track = [bobTrack, aliceTrack].find(item => params.keywords === `${item.title} ${item.artist}`);
      return { ok: true, status: 200, body: { code: 200, result: { songs: track ? [{ id: Number(track.id), name: track.title, ar: [{ name: track.artist }], al: {} }] : [] } } };
    },
  } });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, data) {
    const response = await localFetch(base + path, { method: data ? 'POST' : 'GET', ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const pendingBob = call('/api/chat', { djId: 'bob', message: '给 Bob 的摇滚需求' });
  await bobStarted;
  assert.equal((await call('/api/chat', { djId: 'bob', message: '重复请求' })).status, 409);
  const selected = await call('/api/dj/select', { djId: 'alice' });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.body.messages, []);
  const aliceResponse = await call('/api/chat', { djId: 'alice', message: '给 Alice 的爵士需求' });
  assert.equal(aliceResponse.status, 200, 'a pending Bob request does not block Alice');
  finishBob();
  const bobResponse = await pendingBob;
  assert.equal(bobResponse.body.djId, 'bob');
  assert.equal(bobResponse.body.message.djId, 'bob');
  assert.deepEqual(bobResponse.body.queue.map(item => item.id), ['101']);
  const aliceState = (await call('/api/state')).body;
  assert.equal(aliceState.djId, 'alice', 'the delayed Bob response does not switch selection');
  assert.deepEqual(aliceState.messages.map(item => item.content), ['给 Alice 的爵士需求', 'Alice 的爵士节目']);
  assert.deepEqual(aliceState.queue.map(item => item.id), ['202']);
  assert.equal(JSON.parse(requests[1].messages[0].content).history.length, 0, 'Bob history is excluded from Alice context');
  assert.ok(requests[0].system.startsWith('你是 Radio Bob'));
  assert.ok(requests[1].system.startsWith(alice.persona));
  assert.equal((await call('/api/tts', { djId: 'alice', messageId: bobResponse.body.message.id })).status, 404);
  const restoredBob = (await call('/api/dj/select', { djId: 'bob' })).body;
  assert.deepEqual(restoredBob.messages.map(item => item.content), ['给 Bob 的摇滚需求', 'Bob 的摇滚节目']);
  assert.deepEqual(restoredBob.queue.map(item => item.id), ['101']);
  assert.equal((await call('/api/dj/select', { djId: 'unknown' })).status, 404);
  assert.equal((await call('/api/state')).body.djId, 'bob');
});
