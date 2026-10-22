import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

// Child-only test guard. Never read source secrets/data to check whether they exist.
const forbiddenRoot = process.env.RADIO_TEST_FORBIDDEN_ROOT;
function check(input) {
  if (!forbiddenRoot || typeof input === 'number') return;
  const path = resolve(input instanceof URL ? fileURLToPath(input) : String(input));
  const base = resolve(forbiddenRoot);
  const protectedPaths = ['.env', '.data', 'user'].map(name => resolve(base, name));
  if (protectedPaths.some(protectedPath => path === protectedPath || path.startsWith(`${protectedPath}${sep}`))) {
    throw new Error('SOURCE_DATA_ACCESS_FORBIDDEN');
  }
}
for (const name of ['readFileSync', 'writeFileSync', 'openSync', 'mkdirSync', 'chmodSync', 'existsSync', 'statSync', 'lstatSync']) {
  const original = fs[name];
  fs[name] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
}
for (const name of ['readFile', 'writeFile', 'open', 'mkdir', 'chmod', 'stat', 'lstat']) {
  const original = fsp[name];
  fsp[name] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
}
const blocked = () => { throw new Error('OUTBOUND_NETWORK_FORBIDDEN'); };
globalThis.fetch = process.env.RADIO_TEST_HANG_FETCH === 'true'
  ? () => { process.stderr.write('[TEST] artificial request is pending\n'); return new Promise(() => {}); }
  : blocked;
http.request = http.get = https.request = https.get = blocked;
syncBuiltinESMExports();
