import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRadioApplication } from '../server/app.mjs';

const COOKIE = 'MUSIC_U=artificial-managed-login-session; __csrf=artificial-login-csrf';
const TOKEN = 'artificial-managed-login-instance-token';
const QR_IMAGE = 'data:image/png;base64,aW1hZ2U=';

function fakeMusic() {
  const calls = [];
  let sequence = 0;
  const controls = { status: 801, expired: false, accountFailure: false, delayedCheck: null, onCheck: null };
  return {
    calls, controls,
    transport: {
      health: async () => true,
      async request(path, params) {
        calls.push({ path, params: { ...params } });
        const ok = body => ({ ok: true, status: 200, body });
        if (path === '/login/qr/key') return ok({ code: 200, data: { unikey: `artificial-qr-${++sequence}` } });
        if (path === '/login/qr/create') return ok({ code: 200, data: { qrimg: QR_IMAGE } });
        if (path === '/login/qr/check') {
          controls.onCheck?.();
          if (controls.delayedCheck) await controls.delayedCheck;
          return ok({ code: controls.status, nickname: '人工听众', ...(controls.status === 803 ? { cookie: COOKIE } : {}) });
        }
        if (path === '/login/status') {
          if (controls.accountFailure) throw new Error(`artificial upstream failure: ${COOKIE}`);
          return ok(controls.expired ? { code: 301, message: COOKIE } : {
            code: 200, data: { profile: params.cookie === COOKIE ? { userId: 1, nickname: '人工听众' } : null },
          });
        }
        if (path === '/cloudsearch') return ok({ code: 200, result: {
          songs: [{ id: 123, name: '人工歌曲', ar: [{ name: '人工歌手' }], al: { name: '人工专辑' }, dt: 180000 }],
          songCount: 1,
        } });
        if (path === '/song/url/v1') return ok({ code: 200, data: [
          { id: 123, code: 200, url: 'https://example.invalid/artificial-song.mp3', time: 180000 },
        ] });
        throw new Error(`unexpected artificial route ${path}`);
      },
    },
  };
}

async function fixture(t, music = fakeMusic()) {
  const root = await mkdtemp(join(tmpdir(), 'radio-managed-login-disposable-'));
  const dataDir = join(root, 'data');
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  let app;
  let base;
  const start = async () => {
    app = createRadioApplication({ root, env: {}, dataDir,
      profileDir: join(root, 'profile'), cacheDir: join(root, 'cache'), musicTransport: music.transport,
      managed: { instanceId: 'artificial_login_instance', token: TOKEN },
    });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const raw = (path, options = {}) => fetch(base + path, {
    ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
  });
  const request = async (path, data) => {
    const response = await raw(path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.equal(text.includes(COOKIE), false, path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    return JSON.parse(text);
  };
  const restart = async () => { await app.close(); await start(); };
  const login = async () => {
    const qr = await request('/api/login/qr');
    music.controls.status = 803;
    const result = await request(`/api/login/check?key=${encodeURIComponent(qr.key)}`);
    assert.equal(result.status, 'authorized');
    return qr;
  };
  const checkDatabase = () => {
    const db = new DatabaseSync(join(dataDir, 'state.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('musicCookie'), undefined);
      for (const table of ['settings', 'messages', 'plays', 'plans']) {
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(COOKIE), false, table);
      }
    } finally { db.close(); }
  };
  return { root, dataDir, music, logs, raw, request, restart, login, checkDatabase,
    unauthenticated: path => fetch(base + path),
  };
}

test('managed login requires instance authentication and only polls server-issued QR keys', async t => {
  const f = await fixture(t);
  for (const path of ['/api/status', '/api/login/qr', '/api/login/check?key=artificial']) {
    assert.equal((await f.unauthenticated(path)).status, 401, path);
  }
  const status = await f.request('/api/status');
  assert.equal(status.services.music.loginEnabled, true);
  assert.equal(status.services.music.loggedIn, false);
  assert.equal(f.music.calls.filter(call => call.path === '/login/status').length, 0, 'anonymous status stays local');
  const forged = await f.raw('/api/login/check?key=not-issued-by-this-instance');
  const forgedBody = await forged.json();
  assert.ok(forged.status >= 400 || forgedBody.status === 'expired');
  assert.equal(f.music.calls.filter(call => call.path === '/login/qr/check').length, 0);
  const qr = await f.request('/api/login/qr');
  assert.equal(qr.image, QR_IMAGE);
  assert.equal((await f.request(`/api/login/check?key=${qr.key}`)).status, 'waiting');
  f.music.controls.status = 802;
  assert.equal((await f.request(`/api/login/check?key=${qr.key}`)).status, 'scanned');
  f.music.controls.status = 800;
  assert.equal((await f.request(`/api/login/check?key=${qr.key}`)).status, 'expired');
  assert.ok(f.music.calls.every(call => !('cookie' in call.params)), 'QR creation and polling never send an existing session');
});

test('managed authorization persists privately across restart and supplies only server-side music requests', async t => {
  const f = await fixture(t);
  await f.login();
  const status = await f.request('/api/status');
  assert.equal(status.services.music.loggedIn, true);
  assert.equal(status.services.music.nickname, '人工听众');
  await f.request('/api/music/search?q=artificial');
  await f.request('/api/music/url/123');
  await f.request('/api/state');
  const events = await f.raw('/api/events');
  const reader = events.body.getReader();
  try { assert.equal(Buffer.from((await reader.read()).value).toString().includes(COOKIE), false); }
  finally { await reader.cancel(); }
  for (const path of ['/login/status', '/cloudsearch', '/song/url/v1']) {
    const sent = f.music.calls.filter(call => call.path === path);
    assert.ok(sent.length > 0, path);
    assert.ok(sent.every(call => call.params.cookie === COOKIE), path);
  }
  f.checkDatabase();
  assert.equal(f.logs.join('\n').includes(COOKIE), false);
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, true);
  f.checkDatabase();
});

test('logout clears the persisted account and invalidates previously issued QR keys', async t => {
  const f = await fixture(t);
  await f.login();
  const pending = await f.request('/api/login/qr');
  await f.request('/api/logout', {});
  const check = await f.raw(`/api/login/check?key=${pending.key}`);
  const result = await check.json();
  assert.ok(check.status >= 400 || result.status === 'expired');
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false);
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false);
  f.checkDatabase();
});

test('authorization arriving after logout cannot restore the account', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const qr = await f.request('/api/login/qr');
  let finish;
  f.music.controls.delayedCheck = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { f.music.controls.onCheck = resolve; });
  f.music.controls.status = 803;
  const pending = f.request(`/api/login/check?key=${qr.key}`);
  try {
    await Promise.race([started, pending.then(() => { throw new Error('Poll did not reach the fake upstream'); })]);
    await f.request('/api/logout', {});
  } finally { finish(); }
  assert.equal((await pending).status, 'expired');
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false);
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false);
});

test('a confirmed expired account is removed, while a temporary status failure preserves the private session', async t => {
  const f = await fixture(t);
  await f.login();
  f.music.controls.accountFailure = true;
  const failed = await f.request('/api/status');
  assert.equal(failed.services.music.loggedIn, false);
  assert.equal(f.logs.join('\n').includes(COOKIE), false);
  f.music.controls.accountFailure = false;
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, true, 'transient failures do not erase credentials');
  f.music.controls.expired = true;
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false);
  f.music.controls.expired = false;
  await f.restart();
  assert.equal((await f.request('/api/status')).services.music.loggedIn, false, 'confirmed expired credentials stay cleared');
});
