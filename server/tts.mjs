import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MODELS = new Set(['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3']);

function failure(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

export function createTtsClient({ apiKey, model = 's2.1-pro-free', referenceId, cacheDir } = {}) {
  const cache = path.resolve(cacheDir || '.data/tts');
  const voice = String(referenceId || '').trim();
  const configured = Boolean(apiKey?.trim());
  const pending = new Map();

  async function generate(text, filename) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const destination = path.join(cache, filename);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size > 0) return { url: `/tts/${filename}` };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    let response;
    let audio;
    try {
      response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', model },
        body: JSON.stringify({ text, format: 'mp3', ...(voice ? { reference_id: voice } : {}) }),
      });
      if (!response.ok) {
        const errors = {
          400: ['Fish Audio 请求参数不正确，请检查音色 ID。', 'FISH_BAD_REQUEST'],
          401: ['Fish Audio 密钥无效或已过期，请检查 FISH_API_KEY。', 'FISH_UNAUTHORIZED'],
          402: ['Fish Audio 当前模型额度不足，请检查账户额度。', 'FISH_PAYMENT_REQUIRED'],
          403: ['Fish Audio 拒绝访问，请检查账号或音色权限。', 'FISH_FORBIDDEN'],
          429: ['Fish Audio 请求过于频繁，请稍后重试。', 'FISH_RATE_LIMITED'],
          503: ['Fish Audio 服务繁忙，请稍后重试。', 'FISH_UNAVAILABLE'],
        };
        const [message, code] = errors[response.status]
          || [`Fish Audio 请求失败（HTTP ${response.status}）。`, 'FISH_REQUEST_FAILED'];
        throw failure(message, code, response.status === 429 ? 429 : 502);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/^audio\//i.test(contentType)) {
        throw failure('Fish Audio 没有返回音频，请稍后重试。', 'FISH_INVALID_AUDIO');
      }
      audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length || audio.length > 20_000_000) {
        throw failure('Fish Audio 返回的音频为空或过大，请重试。', 'FISH_INVALID_AUDIO');
      }
    } catch (error) {
      if (error.code?.startsWith('FISH_')) throw error;
      throw failure(error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'Fish Audio 合成超时，请稍后重试。' : '暂时无法连接 Fish Audio，请检查网络后重试。',
      'FISH_UNAVAILABLE', 503);
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, audio, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return { url: `/tts/${filename}` };
  }

  return {
    configured,
    async synthesize(input) {
      if (!configured) throw failure('请先在 .env 中填写 FISH_API_KEY。', 'FISH_NOT_CONFIGURED', 503);
      // Fish silently falls back to its paid default on an unknown model header.
      if (!MODELS.has(model)) {
        throw failure('FISH_MODEL 不是支持的型号，请使用 s2.1-pro-free 或官方已支持的型号。', 'FISH_INVALID_MODEL', 400);
      }
      if (typeof input !== 'string' || !input.trim() || [...input.trim()].length > 800) {
        throw failure('口播内容需要为 1 至 800 字。', 'FISH_INVALID_TEXT', 400);
      }
      const text = input.trim();
      const hash = createHash('sha256').update(JSON.stringify({ model, voice, text, format: 'mp3' })).digest('hex');
      const filename = `${hash}.mp3`;
      if (!pending.has(hash)) {
        pending.set(hash, generate(text, filename).finally(() => pending.delete(hash)));
      }
      return pending.get(hash);
    },
  };
}
