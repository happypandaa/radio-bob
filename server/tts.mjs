import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDoubaoProvider, createGeminiProvider } from './tts-providers.mjs';

const MODELS = new Set(['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3']);

function failure(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function createFishProvider({ apiKey, model = 's2.1-pro-free', referenceId }) {
  apiKey = String(apiKey || '').trim();
  const voice = String(referenceId || '').trim();
  const configurationError = !apiKey ? '请先填写 Fish Audio 的 FISH_API_KEY；也可以关闭语音，只使用文字和音乐。'
    : !MODELS.has(model) ? 'FISH_MODEL 不是支持的型号，请使用 s2.1-pro-free 或官方已支持的型号。' : null;
  return {
    id: 'fish', label: 'Fish Audio', model, voice, format: 'mp3',
    configured: !configurationError, configurationError,
    configurationCode: !apiKey ? 'FISH_NOT_CONFIGURED' : 'FISH_INVALID_MODEL',
    cacheIdentity: { model, voice, format: 'mp3' },
    async generate(text) {
      try {
        const response = await fetch('https://api.fish.audio/v1/tts', {
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
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > 20_000_000) throw failure('Fish Audio 返回的音频过大，请重试。', 'FISH_INVALID_AUDIO');
          chunks.push(chunk);
        }
        const audio = Buffer.concat(chunks);
        if (!audio.length) {
          throw failure('Fish Audio 返回的音频为空或过大，请重试。', 'FISH_INVALID_AUDIO');
        }
        return audio;
      } catch (error) {
        if (error.code?.startsWith('FISH_')) throw error;
        throw failure(error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'Fish Audio 合成超时，请稍后重试。' : '暂时无法连接 Fish Audio，请检查网络后重试。',
        'FISH_UNAVAILABLE', 503);
      }
    },
  };
}

// Provider selection is explicit: unrelated saved keys never trigger a fallback.
export function createTtsClientFromEnv(env, cacheDir) {
  const provider = String(env.TTS_PROVIDER || 'fish').trim().toLowerCase();
  const options = provider === 'doubao'
    ? { apiKey: env.DOUBAO_API_KEY, resourceId: env.DOUBAO_RESOURCE_ID || undefined, speaker: env.DOUBAO_SPEAKER || undefined }
    : provider === 'gemini'
      ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL || undefined, voice: env.GEMINI_TTS_VOICE || undefined,
          style: env.GEMINI_TTS_STYLE || undefined }
      : { apiKey: env.FISH_API_KEY, model: env.FISH_MODEL || undefined, referenceId: env.FISH_REFERENCE_ID };
  return createTtsClient({ provider, cacheDir, ...options });
}

export function createTtsClient({ provider = 'fish', cacheDir, ...options } = {}) {
  const cache = path.resolve(cacheDir || '.data/tts');
  const adapter = provider === 'fish' ? createFishProvider(options)
    : provider === 'doubao' ? createDoubaoProvider(options)
      : provider === 'gemini' ? createGeminiProvider(options)
        : { id: provider === 'none' ? 'none' : 'invalid', label: '语音', configured: false,
            configurationError: provider === 'none' ? '已关闭语音，使用文字串词和音乐。' : 'TTS_PROVIDER 无效，请选择 fish、doubao、gemini 或 none。',
            configurationCode: provider === 'none' ? 'TTS_DISABLED' : 'TTS_INVALID_PROVIDER' };
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
      // Preserve existing Fish cache filenames; new providers have distinct identities.
      const identity = adapter.id === 'fish' ? { model: adapter.model, voice: adapter.voice, text, format: 'mp3' }
        : { provider: adapter.id, ...adapter.cacheIdentity, text };
      const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const filename = `${hash}.${adapter.format}`;
      if (!pending.has(hash)) {
        pending.set(hash, generate(text, filename).finally(() => pending.delete(hash)));
      }
      return pending.get(hash);
    },
  };
}
