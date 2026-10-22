import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRadioApplication } from '../server/app.mjs';
import { createMusicClient } from '../server/music.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(source, 'test/fixtures/managed-no-network.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = predicate(); if (result) return result; await delay(15); }
  throw new Error('Timed out waiting for child');
}
async function fixture(t, overrides = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'radio-managed-disposable-')));
  const cwd = join(temp, 'fake-source');
  await mkdir(cwd);
  // Synthetic sentinel only. Never open the original source .env.
  await writeFile(join(cwd, '.env'), 'ANTHROPIC_MODEL=must-not-load-sentinel\nANTHROPIC_API_KEY=artificial-must-not-load\n');
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8',
    APP_DATA_DIR: join(temp, 'data'), APP_CACHE_DIR: join(temp, 'cache'), APP_TEMP_DIR: join(temp, 'tmp'),
    RADIO_TEST_FORBIDDEN_ROOT: source, ...overrides };
  const child = spawn(process.execPath, ['--import', guard, join(source, 'server/managed.mjs')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const messages = [];
  let pending = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { messages.push(JSON.parse(line)); } catch { messages.push({ invalid: line }); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  const token = randomBytes(32).toString('hex');
  const instanceId = `trial_${randomBytes(10).toString('hex')}`;
  const send = message => child.stdin.write(`${JSON.stringify({ protocolVersion: 1, instanceId, ...message })}\n`);
  child.stdin.on('error', () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(temp, { recursive: true, force: true });
  });
  const start = async () => {
    send({ type: 'initialize', token });
    const ready = await eventually(() => messages.find(message => message.type === 'ready'));
    assert.equal(ready.host, '127.0.0.1'); assert.ok(ready.port > 0 && ![3000, 8080].includes(ready.port));
    return `http://${ready.host}:${ready.port}`;
  };
  return { child, temp, env, cwd, token, instanceId, send, start, messages, exit,
    output: () => ({ stdout, stderr, pending }) };
}

test('managed waits for initialize, authenticates every route, isolates data, and closes cleanly', async t => {
  const f = await fixture(t);
  await delay(100);
  assert.deepEqual(await readdir(f.temp), ['fake-source']);
  const base = await f.start();
  const headers = { Authorization: `Bearer ${f.token}` };
  for (const path of ['/_platform/health', '/api/state', '/api/events', '/', '/app.js', '/tts/' + 'a'.repeat(64) + '.mp3']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const health = await fetch(base + '/_platform/health', { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(health.headers.get('transfer-encoding'), null);
  assert.ok(Number(health.headers.get('content-length')) > 0);
  assert.deepEqual(await health.json(), { protocolVersion: 1, instanceId: f.instanceId, status: 'ok' });
  const status = await (await fetch(base + '/api/status', { headers })).json();
  assert.equal(status.services.claude.ready, false);
  assert.notEqual(status.services.claude.model, 'must-not-load-sentinel');
  assert.equal(status.services.music.loginEnabled, false);
  assert.equal(status.services.music.loggedIn, false);
  assert.equal((await fetch(base + '/api/login/qr', { headers })).status, 403);
  assert.equal((await fetch(base + '/api/login/check?key=artificial', { headers })).status, 403);
  assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(base + '/', { headers })).status, 404);
  assert.equal((await fetch(base + '/app.js', { headers })).status, 404);
  const written = await fetch(base + '/api/taste', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '人工隔离品味' }) });
  assert.equal(written.status, 200);
  assert.equal(await readFile(join(f.env.APP_DATA_DIR, 'profile/taste.md'), 'utf8'), '人工隔离品味');
  assert.deepEqual((await readdir(f.cwd)).sort(), ['.env']);
  f.send({ type: 'ping', requestId: 'check_1' });
  await eventually(() => f.messages.find(message => message.type === 'pong' && message.requestId === 'check_1'));
  const events = await fetch(base + '/api/events', { headers });
  const reader = events.body.getReader();
  await reader.read();
  f.send({ type: 'shutdown', requestId: 'stop_1' });
  assert.deepEqual(await f.exit, { code: 0, signal: null });
  await reader.cancel();
  assert.ok(f.messages.some(message => message.type === 'stopping'));
  assert.equal(f.messages.some(message => message.invalid), false);
  assert.equal(f.output().stdout.includes(f.token), false);
  assert.equal(f.output().stderr.includes(f.token), false);
  await assert.rejects(fetch(base + '/_platform/health', { headers, signal: AbortSignal.timeout(1000) }));
  const restarted = await fixture(t, { APP_DATA_DIR: f.env.APP_DATA_DIR, APP_CACHE_DIR: f.env.APP_CACHE_DIR, APP_TEMP_DIR: f.env.APP_TEMP_DIR });
  const nextBase = await restarted.start();
  assert.equal((await fetch(nextBase + '/api/state', { headers })).status, 401);
  const nextState = await (await fetch(nextBase + '/api/state', { headers: { Authorization: `Bearer ${restarted.token}` } })).json();
  assert.equal(nextState.taste, '人工隔离品味');
  restarted.send({ type: 'shutdown' });
  assert.deepEqual(await restarted.exit, { code: 0, signal: null });
});

test('control EOF terminates a running instance', async t => {
  const f = await fixture(t);
  await f.start();
  f.child.stdin.end();
  assert.deepEqual(await f.exit, { code: 0, signal: null });
});

test('missing initialize times out without opening application storage', { timeout: 13_000 }, async t => {
  const f = await fixture(t);
  const started = Date.now();
  assert.deepEqual(await f.exit, { code: 1, signal: null });
  assert.ok(Date.now() - started >= 9500);
  assert.deepEqual(await readdir(f.temp), ['fake-source']);
});

test('noncancellable artificial work makes shutdown fail within its five-second bound', { timeout: 9000 }, async t => {
  const f = await fixture(t, { FISH_API_KEY: 'artificial-not-a-real-key', RADIO_TEST_HANG_FETCH: 'true' });
  const base = await f.start();
  const request = fetch(base + '/api/tts', { method: 'POST',
    headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '人工停机测试，不发送外部请求。' }),
  }).catch(() => null);
  await eventually(() => f.output().stderr.includes('[TEST] artificial request is pending'));
  const started = Date.now();
  f.send({ type: 'shutdown' });
  assert.deepEqual(await f.exit, { code: 1, signal: null });
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7000);
  await request;
  assert.match(f.output().stderr, /data is not confirmed clean/);
});

test('invalid, oversized, duplicate, and wrong-instance messages fail closed', async t => {
  for (const scenario of ['malformed', 'oversized', 'duplicate', 'instance']) {
    await t.test(scenario, async t => {
      const f = await fixture(t);
      if (scenario === 'malformed') f.child.stdin.write('not-json\n');
      if (scenario === 'oversized') f.child.stdin.write('x'.repeat(8193));
      if (scenario === 'duplicate') { await f.start(); f.send({ type: 'initialize', token: f.token }); }
      if (scenario === 'instance') { await f.start(); f.send({ type: 'ping', instanceId: 'other', requestId: 'x' }); }
      assert.deepEqual(await f.exit, { code: 1, signal: null });
      if (['malformed', 'oversized'].includes(scenario)) assert.deepEqual(await readdir(f.temp), ['fake-source']);
      assert.equal(f.output().stdout.includes(f.token), false);
    });
  }
});

test('source/data overlap is rejected before opening any store', async t => {
  const f = await fixture(t, { APP_DATA_DIR: source });
  f.send({ type: 'initialize', token: f.token });
  assert.deepEqual(await f.exit, { code: 1, signal: null });
  assert.deepEqual(await readdir(f.temp), ['fake-source']);
});

test('SDK transport loads only functions in isolated cwd; local QR generation needs no service or network', async t => {
  const f = await fixture(t);
  const script = `
    import { mkdir } from 'node:fs/promises';
    import { createSdkMusicTransport } from ${JSON.stringify(new URL('../server/music-sdk.mjs', import.meta.url).href)};
    await mkdir(process.env.APP_TEMP_DIR, {recursive:true});
    process.env.TMPDIR=process.env.TMP=process.env.TEMP=process.env.APP_TEMP_DIR;
    process.chdir(process.env.APP_TEMP_DIR);
    const transport=await createSdkMusicTransport({tempDir:process.env.APP_TEMP_DIR});
    const result=await transport.request('/login/qr/create',{key:'artificial-not-a-real-login',qrimg:true});
    if (!result.ok || !result.body.data.qrimg.startsWith('data:image/png;base64,')) process.exit(2);
    if (process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_API_KEY) process.exit(3);
    process.stdout.write('offline-qr-ok');
  `;
  const child = spawn(process.execPath, ['--import', guard, '--input-type=module', '-e', script], { cwd: f.cwd, env: f.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr); assert.equal(stdout, 'offline-qr-ok');
});

test('music function transport retains normalization and times out a noncancellable SDK call', async () => {
  const client = createMusicClient({ transport: {
    health: async () => true,
    request: async () => ({ ok: true, status: 200, body: { code: 200, result: { songs: [{ id: 1, name: '人工歌曲', ar: [{ name: '人工歌手' }] }] } } }),
  } });
  assert.equal((await client.search('人工'))[0].title, '人工歌曲');
  const hanging = createMusicClient({ timeoutMs: 10, transport: { health: async () => true, request: () => new Promise(() => {}) } });
  await assert.rejects(hanging.search('人工'), { code: 'MUSIC_SERVICE_TIMEOUT' });
});

test('standalone factory retains local static serving and original origin checks on disposable data', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'radio-standalone-disposable-')));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public/index.html'), '<!doctype html><title>Disposable</title>');
  const app = createRadioApplication({ root, env: {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/api/state')).status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'https://other.example' } })).status, 403);
});
