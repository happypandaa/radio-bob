import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRadioApplication } from '../server/app.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('shipped pages, chat avatar, fonts, textures and icon symbols are served from existing public resources', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'radio-public-disposable-'));
  const app = createRadioApplication({ root: source, env: {},
    dataDir: join(temp, 'data'), profileDir: join(temp, 'profile'), cacheDir: join(temp, 'cache') });
  t.after(async () => { await app.close(); await rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const documents = await Promise.all(['index.html', 'app.js', 'styles.css', 'assets/fonts.css', 'manifest.webmanifest']
    .map(name => readFile(join(source, 'public', name), 'utf8')));
  const paths = new Set(['/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg']);
  for (const document of documents) {
    for (const match of document.matchAll(/\/assets\/[a-zA-Z0-9_./-]+\.(?:png|svg|woff2|css)/g)) paths.add(match[0]);
  }
  for (const asset of paths) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
    assert.notEqual(response.headers.get('content-type'), 'application/octet-stream', asset);
  }
  const avatar = await fetch(base + '/assets/bob-pixel-avatar.png');
  assert.equal(avatar.headers.get('content-type'), 'image/png');
  const pixels = Buffer.from(await avatar.arrayBuffer());
  assert.equal(pixels.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(pixels.readUInt32BE(16) > 100 && pixels.readUInt32BE(20) > 100);
  assert.ok(documents[0].includes('/assets/bob-pixel-avatar.png'), 'brand and profile avatar');
  assert.ok(documents[1].includes('/assets/bob-pixel-avatar.png'), 'dynamic chat avatar');
  const symbols = await readFile(join(source, 'public/assets/icons.svg'), 'utf8');
  for (const match of documents.join('\n').matchAll(/\/assets\/icons\.svg#(i-[a-z-]+)/g)) {
    assert.ok(symbols.includes(`id="${match[1]}"`), match[1]);
  }
});
