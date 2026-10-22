import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;
async function reachable(url) {
  try { const response = await fetch(`${url}/inner/version`, { signal: AbortSignal.timeout(1000) }); return response.ok; }
  catch { return false; }
}
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(0), 2500).unref();
}
const musicUrl = new URL(process.env.NETEASE_API_BASE_URL || 'http://127.0.0.1:3000');
if (['localhost', '127.0.0.1'].includes(musicUrl.hostname) && !(await reachable(musicUrl.origin))) {
  const cwd = join(root, '.data', 'music');
  const tmp = join(cwd, 'tmp');
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const allowed = ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const entry = join(dirname(require.resolve('@neteasecloudmusicapienhanced/api/package.json')), 'app.js');
  const child = spawn(process.execPath, [entry], { cwd, env: { ...env, HOST: '127.0.0.1', PORT: musicUrl.port || '3000', TMPDIR: tmp, ENABLE_GENERAL_UNBLOCK: 'false' }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child);
  child.on('error', () => console.error('音乐接口未能启动；Radio Bob 仍可打开，请检查本机端口。'));
  child.on('exit', code => { if (!stopping && code) console.error('音乐接口已停止，搜索和登录暂不可用。'); });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await reachable(musicUrl.origin)) { console.log('本地音乐接口已就绪。'); break; }
    if (attempt === 29) console.warn('音乐接口仍在连接，将在后台继续启动。');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} else if (!['localhost', '127.0.0.1'].includes(musicUrl.hostname)) {
  console.log('使用配置中的音乐接口服务。');
} else console.log('复用已运行的本地音乐接口。');
const app = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
children.push(app);
app.on('error', error => { console.error(`Radio Bob 未能启动：${error.code || '未知错误'}`); stop(); });
app.on('exit', code => { if (!stopping) { stop(); process.exitCode = code || 0; } });
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop());
