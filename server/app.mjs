import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';
import { createMusicClient } from './music.mjs';
import { createClaudeClient } from './claude.mjs';
import { createTtsClient } from './tts.mjs';
import { controlIntent } from './router.mjs';

export function createRadioApplication({ root, env = process.env, dataDir, profileDir, cacheDir = join(root, '.data', 'tts'), musicTransport, managed } = {}) {
const store = createStore(root, { dataDir, profileDir });
const structuredOutput = env.CLAUDE_STRUCTURED_OUTPUT || 'auto';
const claude = createClaudeClient({
  mode: env.CLAUDE_MODE || 'api',
  apiKey: env.ANTHROPIC_API_KEY,
  authToken: env.ANTHROPIC_AUTH_TOKEN,
  baseUrl: env.ANTHROPIC_BASE_URL,
  model: env.CLAUDE_MODEL || env.ANTHROPIC_MODEL,
  effort: env.CLAUDE_API_EFFORT || env.CLAUDE_CODE_EFFORT_LEVEL,
  maxTokens: env.CLAUDE_MAX_TOKENS ? Number(env.CLAUDE_MAX_TOKENS) : 8192,
  structuredOutput: structuredOutput === 'true' ? true : structuredOutput === 'false' ? false : structuredOutput,
});
const tts = createTtsClient({ apiKey: env.FISH_API_KEY, model: env.FISH_MODEL || 's2.1-pro-free', referenceId: env.FISH_REFERENCE_ID, cacheDir });
const music = createMusicClient({ baseUrl: env.NETEASE_API_BASE_URL || 'http://127.0.0.1:3000', cookieProvider: managed ? () => '' : () => store.get('musicCookie', ''), transport: musicTransport,
  ...(managed ? { unavailableMessage: '暂时无法连接音乐服务，请稍后重试。' } : {}) });
const clients = new Set();
const active = new Set();
let closing = false;
let closePromise;
let chatBusy = false;
let cachedStatus;
let statusAt = 0;

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail('请使用 JSON 格式提交请求。', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw fail('内容太长，请精简后重试。', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  }
  catch { throw fail('请求格式不正确。'); }
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${label}需要填写，且不超过 ${max} 字。`);
  return value.trim();
}
function track(input) {
  if (!input || !/^\d+$/.test(String(input.id)) || typeof input.title !== 'string' || !input.title.trim()) throw fail('歌曲信息不完整。');
  const cover = typeof input.cover === 'string' && /^https:\/\//.test(input.cover) ? input.cover : '';
  return { id: String(input.id), title: input.title.slice(0, 200), artist: String(input.artist || '').slice(0, 200), album: String(input.album || '').slice(0, 200), cover, durationMs: Math.max(0, Math.min(Number(input.durationMs) || 0, 86400000)) };
}
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(store.state())}\n\n`;
  for (const res of clients) res.write(payload);
}
async function serviceStatus(refresh = false) {
  if (!refresh && cachedStatus && Date.now() - statusAt < 10000) return cachedStatus;
  const [brain, musicReady, account] = await Promise.allSettled([claude.health(), music.health(), managed ? Promise.resolve({ loggedIn: false }) : music.account()]);
  cachedStatus = { services: {
    claude: brain.status === 'fulfilled' ? brain.value : { ready: false, mode: 'api', message: '无法连接 AI 接口。' },
    fish: { ready: tts.configured, model: env.FISH_MODEL || 's2.1-pro-free' },
    music: { ready: musicReady.status === 'fulfilled' && musicReady.value, loggedIn: account.status === 'fulfilled' && account.value.loggedIn, ...(managed ? { loginEnabled: false, message: '受管试验暂不接入真实音乐账号。' } : {}), ...(account.status === 'fulfilled' && account.value.nickname ? { nickname: account.value.nickname } : {}) }
  } };
  statusAt = Date.now();
  return cachedStatus;
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' };
async function serveFile(req, res, path, type) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw fail('没有找到这个文件。', 404);
  const bytes = await readFile(path);
  const headers = { 'Content-Type': mime[type || extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': type === '.mp3' ? 'private, max-age=86400' : 'no-cache' };
  if (type === '.mp3') {
    headers['Accept-Ranges'] = 'bytes';
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end || start >= bytes.length) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      res.end(bytes.subarray(start, end + 1)); return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function handle(req, res) {
  try {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw fail('只允许从本机访问。', 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw fail('不允许来自其他网站的请求。', 403);
    if (managed) {
      const expected = Buffer.from(`Bearer ${managed.token}`);
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('需要平台实例认证。', 401);
    }
    if (closing) throw fail('应用正在停止。', 503);
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;
    const method = req.method;
    if (managed && path === '/_platform/health' && method === 'GET') return json(res, 200, { protocolVersion: 1, instanceId: managed.instanceId, status: 'ok' });
    if (managed && ['/api/login/qr', '/api/login/check', '/api/logout'].includes(path)) throw fail('本轮受管试验不接入真实音乐账号，请勿扫码登录。', 403);
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(store.state())}\n\n`);
      clients.add(res);
      const timer = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(timer); clients.delete(res); });
      return;
    }
    if (path === '/api/status' && method === 'GET') return json(res, 200, await serviceStatus());
    if (path === '/api/state' && method === 'GET') return json(res, 200, store.state());
    if (path === '/api/taste' && method === 'GET') return json(res, 200, { text: store.taste() });
    if (path === '/api/taste' && method === 'PUT') {
      const data = await body(req);
      if (typeof data.text !== 'string' || data.text.length > 12000) throw fail('品味资料不能超过 12000 字。');
      store.setTaste(data.text); broadcast(); return json(res, 200, { text: data.text });
    }
    if (path === '/api/music/search' && method === 'GET') {
      const query = text(url.searchParams.get('q'), 160, '搜索关键词');
      return json(res, 200, { tracks: await music.search(query, 12) });
    }
    const songId = path.match(/^\/api\/music\/url\/(\d+)$/);
    if (songId && method === 'GET') return json(res, 200, await music.resolve(songId[1]));
    if (path === '/api/queue' && method === 'POST') {
      const data = await body(req);
      if (!Array.isArray(data.tracks) || data.tracks.length > 50 || !['append', 'replace'].includes(data.mode)) throw fail('队列参数不正确。');
      const existing = data.mode === 'append' ? store.get('queue', []) : [];
      const unique = new Map([...existing, ...data.tracks.map(track)].map(item => [item.id, item]));
      const queue = [...unique.values()].slice(0, 100);
      store.set('queue', queue); broadcast(); return json(res, 200, { queue });
    }
    if (path === '/api/player' && method === 'POST') {
      const data = await body(req);
      if (!['play', 'pause', 'skip', 'ended'].includes(data.action)) throw fail('不支持这个播放操作。');
      const current = store.get('queue', []).find(t => t.id === String(data.trackId));
      if (current) {
        if (data.action === 'play') store.set('nowPlayingId', current.id);
        store.recordPlay(current, data.action, Math.max(0, Math.min(Number(data.positionMs) || 0, 86400000)));
      }
      if (Number.isFinite(data.volume)) store.set('volume', Math.min(1, Math.max(0, data.volume)));
      broadcast(); return json(res, 200, { ok: true });
    }
    if (path === '/api/login/qr' && method === 'GET') return json(res, 200, await music.createQr());
    if (path === '/api/login/check' && method === 'GET') {
      const result = await music.checkQr(text(url.searchParams.get('key'), 256, '登录标识'));
      if (result.status === 'authorized' && result.cookie) { store.set('musicCookie', result.cookie); statusAt = 0; }
      return json(res, 200, { status: result.status, ...(result.nickname ? { nickname: result.nickname } : {}) });
    }
    if (path === '/api/logout' && method === 'POST') {
      await body(req); store.set('musicCookie', ''); statusAt = 0; return json(res, 200, { ok: true });
    }
    if (path === '/api/tts' && method === 'POST') {
      if (managed && !tts.configured) throw fail('尚未配置语音密钥，当前可以先使用文字串词。', 503);
      const data = await body(req);
      const message = data.messageId ? store.message(data.messageId) : null;
      if (data.messageId && message?.role !== 'assistant') throw fail('没有找到这条主持内容。', 404);
      const result = await tts.synthesize(text(message?.content || data.text, 800, '口播内容'));
      if (message) { store.speech(message.id, result.url); broadcast(); }
      return json(res, 200, result);
    }
    if (path === '/api/chat' && method === 'POST') {
      const data = await body(req);
      const message = text(data.message, 2000, '你的需求');
      const action = controlIntent(message);
      if (action) {
        const queue = store.get('queue', []);
        store.addMessage('user', message);
        const descriptions = { play: '好的，继续播放。', pause: '好的，先暂停。', next: '好的，切到下一首。', previous: '好的，回到上一首。' };
        const response = store.addMessage('assistant', queue.length ? descriptions[action] : '队列里还没有歌曲。先搜一首歌，或者告诉我你想听什么。');
        broadcast();
        return json(res, 200, { message: response, tracks: [], queue, ...(queue.length ? { control: { action } } : {}) });
      }
      if (chatBusy) throw fail('DJ 正在准备上一段节目，请稍等。', 409);
      chatBusy = true;
      try {
        const history = store.state().messages.slice(-12).map(({ role, content }) => ({ role, content }));
        store.addMessage('user', message); broadcast();
        const plan = await claude.plan({ message, taste: store.taste(), history, plays: store.recentPlays(), now: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) });
        const [found, speech] = await Promise.all([
          Promise.allSettled(plan.play.map(async song => {
            const matches = await music.search(`${song.title} ${song.artist}`, 5);
            const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
            return matches.find(item => normalize(item.title) === normalize(song.title) && normalize(item.artist).includes(normalize(song.artist))) || null;
          })),
          tts.configured ? tts.synthesize(plan.say).catch(error => ({ error: error.message })) : Promise.resolve({ error: '尚未配置 Fish Audio，先显示文字串词。' })
        ]);
        const tracks = [...new Map(found.filter(x => x.status === 'fulfilled' && x.value).map(x => [x.value.id, x.value])).values()];
        const missing = found.filter(x => x.status === 'rejected' || !x.value).length;
        const note = missing ? `\n\n有 ${missing} 首推荐暂时未能从曲库找到，你可以试试直接搜歌。` : '';
        const response = store.addMessage('assistant', plan.say + note, tracks, speech.url || null);
        if (tracks.length) store.set('queue', tracks);
        store.recordPlan(plan, tracks); broadcast();
        return json(res, 200, { message: response, tracks, speech, reason: plan.reason, queue: store.get('queue', []) });
      } finally { chatBusy = false; }
    }
    if (path.startsWith('/api/')) throw fail('接口不存在。', 404);
    const audio = path.match(/^\/tts\/([a-f0-9]{64})\.mp3$/);
    if (audio && ['GET', 'HEAD'].includes(method)) return await serveFile(req, res, join(cacheDir, `${audio[1]}.mp3`), '.mp3');
    if (managed) throw fail('受管后端不提供静态页面。', 404);
    if (!['GET', 'HEAD'].includes(method)) throw fail('不支持这个请求。', 405);
    if (/^\/assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:woff2|png|jpg|webp|svg|css)$/.test(path)) {
      return await serveFile(req, res, join(root, 'public', path.slice(1)));
    }
    const allowed = new Set(['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg']);
    if (!allowed.has(path)) throw fail('页面不存在。', 404);
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https: http: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    await serveFile(req, res, join(root, 'public', path === '/' ? 'index.html' : path.slice(1)));
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const safe = status === 500 ? '暂时没有完成，请稍后重试。' : error.message;
    if (!res.headersSent) json(res, status, { error: safe, ...(error.code ? { code: error.code } : {}) });
    else res.end();
    console.error(`[Radio Bob] ${error.code || status}: ${safe}`);
  }
}
const server = http.createServer((req, res) => {
  const task = handle(req, res);
  active.add(task);
  task.then(() => active.delete(task), () => active.delete(task));
});
server.requestTimeout = 180000;
function close() {
  if (closePromise) return closePromise;
  closing = true;
  for (const res of clients) res.end();
  clients.clear();
  closePromise = (async () => {
    await new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    await Promise.allSettled([...active]);
    store.close();
  })();
  return closePromise;
}
return { server, close };
}
