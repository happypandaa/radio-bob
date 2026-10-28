import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, openSync, readFileSync, closeSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMusicSessionStore } from '../server/music-session.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'radio-session-disposable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'credentials', 'netease-session');
  return { root, directory, filename: join(directory, 'session.cookie') };
}

const unavailable = error => {
  assert.equal(error.code, 'MUSIC_SESSION_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.message.includes('MUSIC_U='), false);
  assert.equal(error.message.includes('radio-session-disposable-'), false);
  return true;
};

test('private session survives restart, atomically replaces its file, and clears independently', async t => {
  const { directory, filename } = await fixture(t);
  const store = createMusicSessionStore(directory);
  assert.equal(store.get(), '');
  store.set('MUSIC_U=artificial-first; __csrf=artificial-csrf');
  assert.equal(createMusicSessionStore(directory).get(), 'MUSIC_U=artificial-first; __csrf=artificial-csrf');
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  const oldDescriptor = openSync(filename, 'r');
  try {
    store.set('MUSIC_U=artificial-second');
    assert.equal(readFileSync(oldDescriptor, 'utf8'), 'MUSIC_U=artificial-first; __csrf=artificial-csrf');
  } finally { closeSync(oldDescriptor); }
  assert.deepEqual(await readdir(directory), ['session.cookie']);
  assert.equal(store.get(), 'MUSIC_U=artificial-second');
  store.clear();
  store.clear();
  assert.deepEqual(await readdir(directory), []);
  assert.equal(createMusicSessionStore(directory).get(), '');
});

test('invalid or oversized incoming cookies never replace an existing session', async t => {
  const { directory } = await fixture(t);
  const store = createMusicSessionStore(directory);
  store.set('MUSIC_U=artificial-keep');
  for (const cookie of ['', ' ', null, {}, 'MUSIC_U=artificial\r\nextra', 'MUSIC_U=' + 'x'.repeat(16_384)]) {
    assert.throws(() => store.set(cookie), { code: 'MUSIC_SESSION_INVALID_COOKIE', status: 400 });
    assert.equal(store.get(), 'MUSIC_U=artificial-keep');
  }
  assert.deepEqual(await readdir(directory), ['session.cookie']);
});

test('session refuses a symlink directory, symlink file and hard-linked cookie', async t => {
  const { root, directory, filename } = await fixture(t);
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(join(root, 'credentials'), { mode: 0o700 });
  symlinkSync(target, directory, 'dir');
  assert.throws(() => createMusicSessionStore(directory), unavailable);
  await rm(directory);
  const store = createMusicSessionStore(directory);
  const external = join(root, 'external.cookie');
  writeFileSync(external, 'MUSIC_U=artificial-external', { mode: 0o600 });
  symlinkSync(external, filename);
  for (const action of [() => store.get(), () => store.set('MUSIC_U=artificial-new'), () => store.clear()]) {
    assert.throws(action, unavailable);
  }
  assert.equal(readFileSync(external, 'utf8'), 'MUSIC_U=artificial-external');
  await rm(filename);
  linkSync(external, filename);
  assert.throws(() => store.get(), unavailable);
  assert.throws(() => store.clear(), unavailable);
  assert.equal(readFileSync(external, 'utf8'), 'MUSIC_U=artificial-external');
});

test('session rejects an existing public directory or credential instead of silently relaxing access', async t => {
  if (process.platform === 'win32') return t.skip('POSIX permission modes');
  const { directory, filename } = await fixture(t);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o755);
  assert.throws(() => createMusicSessionStore(directory), unavailable);
  chmodSync(directory, 0o700);
  const store = createMusicSessionStore(directory);
  writeFileSync(filename, 'MUSIC_U=artificial-public', { mode: 0o644 });
  for (const action of [() => store.get(), () => store.set('MUSIC_U=artificial-new'), () => store.clear()]) {
    assert.throws(action, unavailable);
  }
  assert.equal((await stat(filename)).mode & 0o777, 0o644);
});

test('session refuses oversized or malformed persisted credentials without leaking them', async t => {
  const { directory, filename } = await fixture(t);
  const store = createMusicSessionStore(directory);
  for (const cookie of ['MUSIC_U=' + 'x'.repeat(16_384), 'MUSIC_U=artificial\nunsafe', '']) {
    writeFileSync(filename, cookie, { mode: 0o600 });
    assert.throws(() => store.get(), unavailable);
  }
});

test('session refuses a replaced directory and invalid directory arguments', async t => {
  const { directory } = await fixture(t);
  const store = createMusicSessionStore(directory);
  await rm(directory, { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  assert.throws(() => store.set('MUSIC_U=artificial-new'), unavailable);
  for (const input of [null, {}, 'relative/path', '/invalid\0path']) {
    assert.throws(() => createMusicSessionStore(input), unavailable);
  }
});

test('session refuses a redirected credentials parent even when the leaf directory exists', async t => {
  const { root, directory } = await fixture(t);
  const external = join(root, 'redirected');
  mkdirSync(join(external, 'netease-session'), { recursive: true, mode: 0o700 });
  symlinkSync(external, join(root, 'credentials'), 'dir');
  assert.throws(() => createMusicSessionStore(directory), unavailable);
  assert.deepEqual(await readdir(join(external, 'netease-session')), []);
});
