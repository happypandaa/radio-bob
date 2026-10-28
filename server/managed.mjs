import { resolve, dirname, isAbsolute, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, lstat, chmod } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MESSAGE = 8192;
let initialized = false;
let stopping = false;
let instanceId;
let application;
let initializePromise;
let pending = Buffer.alloc(0);
let queue = Promise.resolve();
const diagnostic = message => process.stderr.write(`[Radio Bob managed] ${message}\n`);
// Third-party SDK diagnostics can contain upstream data. Keep stdout protocol-only,
// and suppress their contents rather than attempting to redact arbitrary objects.
for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = () => diagnostic('Library diagnostic suppressed.');
const emit = (type, extra = {}) => process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type, instanceId, ...extra })}\n`);
const initTimer = setTimeout(() => { diagnostic('Initialization timed out.'); void stop(1); }, 10_000);

function inside(parent, child) {
  const path = relative(parent, child);
  return !path || !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}
async function checkedDirectory(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('Invalid managed directory');
  const path = resolve(input);
  if (inside(root, path) || inside(path, root)) throw new Error('Managed directories must be separate from the source project');
  let current = path;
  while (true) {
    const info = await lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Invalid directory identity');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path;
}
function validMessage(message, keys) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && message.protocolVersion === 1 && Object.keys(message).every(key => keys.includes(key));
}
function id(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

async function initialize(message) {
  if (initialized || initializePromise || !validMessage(message, ['protocolVersion', 'type', 'instanceId', 'token'])
    || !id(message.instanceId) || typeof message.token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(message.token)) throw new Error('Invalid initialization');
  instanceId = message.instanceId;
  initializePromise = (async () => {
    const directories = await Promise.all(['APP_DATA_DIR', 'APP_CACHE_DIR', 'APP_TEMP_DIR'].map(name => checkedDirectory(process.env[name])));
    for (let i = 0; i < directories.length; i++) for (let j = i + 1; j < directories.length; j++) {
      if (inside(directories[i], directories[j]) || inside(directories[j], directories[i])) throw new Error('Managed directories overlap');
    }
    for (const directory of directories) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
    const [dataDir, cacheDir, tempDir] = directories;
    // Do this before any SDK import. Its request modules use os.tmpdir() and some
    // operations call dotenv relative to cwd; neither may point at the source .env.
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = tempDir;
    process.env.ENABLE_GENERAL_UNBLOCK = 'false';
    process.env.ENABLE_PROXY = 'false';
    process.env.DOTENV_CONFIG_QUIET = 'true';
    process.chdir(tempDir);
    const { createSdkMusicTransport } = await import('./music-sdk.mjs');
    const musicTransport = await createSdkMusicTransport({ tempDir });
    const { createRadioApplication } = await import('./app.mjs');
    application = createRadioApplication({ root, dataDir, profileDir: join(dataDir, 'profile'), cacheDir,
      env: { ...process.env, NETEASE_API_BASE_URL: undefined }, musicTransport,
      managed: { instanceId, token: message.token } });
    if (stopping) return;
    await new Promise((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(0, '127.0.0.1', resolve);
    });
    if (stopping) return;
    initialized = true;
    clearTimeout(initTimer);
    emit('ready', { host: '127.0.0.1', port: application.server.address().port });
    diagnostic('Ready. Music login is available through the authenticated application API.');
  })();
  await initializePromise;
}

async function stop(code = 0, requestId) {
  if (stopping) { if (code) process.exitCode = code; return; }
  stopping = true;
  clearTimeout(initTimer);
  if (instanceId) emit('stopping', requestId ? { requestId } : {});
  const timer = setTimeout(() => { diagnostic('Shutdown timed out; data is not confirmed clean.'); process.exit(1); }, 5000);
  try {
    await initializePromise?.catch(() => {});
    await application?.close();
    clearTimeout(timer);
    process.exit(process.exitCode || code);
  } catch {
    diagnostic('Shutdown failed; data is not confirmed clean.');
    process.exit(1);
  }
}
async function dispatch(message) {
  if (stopping) return;
  if (message?.type === 'initialize') return initialize(message);
  if (!initialized || message?.instanceId !== instanceId) throw new Error('Invalid instance');
  if (message.type === 'ping' && validMessage(message, ['protocolVersion', 'type', 'instanceId', 'requestId']) && id(message.requestId)) {
    emit('pong', { requestId: message.requestId }); return;
  }
  if (message.type === 'shutdown' && validMessage(message, ['protocolVersion', 'type', 'instanceId', 'requestId'])
    && (message.requestId === undefined || id(message.requestId))) return stop(0, message.requestId);
  throw new Error('Invalid control message');
}
function invalid() { diagnostic('Invalid or oversized control message.'); void stop(1); }
process.stdin.on('data', chunk => {
  if (stopping) return;
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const newline = pending.indexOf(10);
    if (newline < 0) break;
    const line = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    if (!line.length || line.length > MAX_MESSAGE) return invalid();
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { return invalid(); }
    queue = queue.then(() => dispatch(message)).catch(() => { invalid(); });
  }
  if (pending.length > MAX_MESSAGE) invalid();
});
process.stdin.on('end', () => {
  if (pending.length) return invalid();
  void queue.then(() => stop(initialized ? 0 : 1));
});
process.stdin.on('error', () => { diagnostic('Control channel failed.'); void stop(1); });
process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });
process.on('uncaughtException', () => { diagnostic('Unexpected process failure.'); void stop(1); });
process.on('unhandledRejection', () => { diagnostic('Unexpected asynchronous failure.'); void stop(1); });
