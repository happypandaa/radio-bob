import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOCAL_FAILURE = Symbol('fish-failure');
const MAX_AUDIO_BYTES = 20_000_000;
const TIMEOUT_MS = 60_000;

const MODELS = new Set(['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3']);

function failure(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status, [LOCAL_FAILURE]: true });
}

function createFishProvider({ apiKey, model = 's2.1-pro-free', referenceId }) {
  apiKey = String(apiKey || '').trim();
  const voice = String(referenceId || '').trim();
  const configurationError = !apiKey ? '请先填写 Fish Audio 的 FISH_API_KEY；留空时只使用文字和音乐。'
    : !MODELS.has(model) ? 'FISH_MODEL 不是支持的型号，请使用 s2.1-pro-free 或官方已支持的型号。' : null;
  return {
    id: 'fish', label: 'Fish Audio', model, voice, format: 'mp3',
    configured: !configurationError, configurationError,
    configurationCode: !apiKey ? 'FISH_NOT_CONFIGURED' : 'FISH_INVALID_MODEL',
    cacheIdentity: { model, voice, format: 'mp3' },
    async generate(text) {
      const controller = new AbortController();
      const deadline = Date.now() + TIMEOUT_MS;
      const timeoutError = () => failure('Fish Audio 合成超时，请稍后重试。', 'FISH_TIMEOUT', 504);
      let rejectTimeout;
      let reader;
      let response;
      let finished = false;
      const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
      const cancel = () => {
        try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch {}
      };
      const timer = setTimeout(() => {
        const error = timeoutError();
        controller.abort(error);
        cancel();
        rejectTimeout(error);
      }, TIMEOUT_MS);
      const checkActive = () => {
        controller.signal.throwIfAborted();
        if (Date.now() >= deadline) throw timeoutError();
      };
      try {
        const audio = await Promise.race([(async () => {
          response = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST', signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', model },
            body: JSON.stringify({ text, format: 'mp3', ...(voice ? { reference_id: voice } : {}) }),
          });
          checkActive();
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
          if (!/^audio\//i.test(response.headers.get('content-type') || '') || !response.body?.getReader) {
            throw failure('Fish Audio 没有返回音频，请稍后重试。', 'FISH_INVALID_AUDIO');
          }
          if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
            throw failure('Fish Audio 返回的音频过大，请重试。', 'FISH_INVALID_AUDIO');
          }
          reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            checkActive();
            if (done) { finished = true; break; }
            if (!(value instanceof Uint8Array)) throw failure('Fish Audio 没有返回有效音频，请重试。', 'FISH_INVALID_AUDIO');
            size += value.byteLength;
            if (size > MAX_AUDIO_BYTES) throw failure('Fish Audio 返回的音频过大，请重试。', 'FISH_INVALID_AUDIO');
            chunks.push(value);
          }
          if (!size) throw failure('Fish Audio 返回的音频为空，请重试。', 'FISH_INVALID_AUDIO');
          return Buffer.concat(chunks);
        })(), timeout]);
        checkActive();
        return audio;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw timeoutError();
        if (error?.[LOCAL_FAILURE]) throw error;
        throw failure('暂时无法连接 Fish Audio，请检查网络后重试。', 'FISH_UNAVAILABLE', 503);
      } finally {
        clearTimeout(timer);
        if (!finished) cancel();
        try { reader?.releaseLock(); } catch {}
      }
    },
  };
}

// Fish is the only speech service. Legacy provider settings are ignored.
export function createTtsClientFromEnv(env, cacheDir) {
  return createTtsClient({ cacheDir, apiKey: env.FISH_API_KEY,
    model: env.FISH_MODEL || undefined, referenceId: env.FISH_REFERENCE_ID });
}

export function createTtsClient({ cacheDir, ...options } = {}) {
  const cache = path.resolve(cacheDir || '.data/tts');
  const adapter = createFishProvider(options);
  const pending = new Map();

  async function generate(text, filename) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const destination = path.join(cache, filename);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size > 0 && existing.size <= 20_000_000) return { url: `/tts/${filename}` };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const audio = await adapter.generate(text);
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > 20_000_000) {
      throw failure(`${adapter.label} 没有返回有效音频，请重试。`, `${adapter.id.toUpperCase()}_INVALID_AUDIO`);
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
    configured: adapter.configured,
    status: { provider: adapter.id, label: adapter.label, ready: adapter.configured, model: adapter.model || null,
      message: adapter.configurationError || `${adapter.label} 配置已就绪；实际调用仍需有效密钥、额度和网络。` },
    async synthesize(input) {
      if (!adapter.configured) {
        throw failure(adapter.configurationError, adapter.configurationCode || `${adapter.id.toUpperCase()}_NOT_CONFIGURED`,
          adapter.configurationCode === 'FISH_INVALID_MODEL' ? 400 : 503);
      }
      if (typeof input !== 'string' || !input.trim() || [...input.trim()].length > 800) {
        throw failure('口播内容需要为 1 至 800 字。', `${adapter.id.toUpperCase()}_INVALID_TEXT`, 400);
      }
      const text = input.trim();
      // Preserve existing Fish cache filenames across upgrades.
      const identity = { model: adapter.model, voice: adapter.voice, text, format: 'mp3' };
      const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const filename = `${hash}.${adapter.format}`;
      if (!pending.has(hash)) {
        pending.set(hash, generate(text, filename).finally(() => pending.delete(hash)));
      }
      return pending.get(hash);
    },
  };
}
