import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 20_000_000;
const MAX_JSON_BYTES = 30_000_000;
const MAX_STREAM_BYTES = 40_000_000;
const GEMINI_MODELS = new Set(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const LOCAL_FAILURE = Symbol('tts-provider-failure');
const deadlines = new WeakMap();

function failure(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status, [LOCAL_FAILURE]: true });
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function credentialError(apiKey, prefix, label) {
  if (!apiKey) return [failure(`请填写 ${prefix}_API_KEY（${label}控制台的 API Key）。`, `${prefix}_NOT_CONFIGURED`, 503)];
  if (apiKey.length > 8192 || /\s|[\u0000-\u001f\u007f]/u.test(apiKey)) {
    return [failure(`${prefix}_API_KEY 格式不正确，请重新复制完整密钥。`, `${prefix}_INVALID_CONFIGURATION`, 400)];
  }
  return [];
}

function validIdentifier(value, maximum = 200) {
  return value.length > 0 && value.length <= maximum && IDENTIFIER.test(value);
}

function metadata({ id, label, model, voice, format, cacheIdentity, errors }) {
  const error = errors[0] || null;
  return {
    id, label, model, voice, format,
    configured: !error,
    configurationError: error?.message || null,
    configurationCode: error?.code || null,
    cacheIdentity,
  };
}

function validateText(text, prefix) {
  if (typeof text !== 'string' || !text.trim() || [...text.trim()].length > 800) {
    throw failure('口播内容需要为 1 至 800 字。', `${prefix}_INVALID_TEXT`, 400);
  }
  return text.trim();
}

function httpError(prefix, label, status) {
  const messages = {
    400: [`${label}请求参数不正确，请检查模型、音色和资源配置。`, 'BAD_REQUEST'],
    401: [`${label}密钥无效或已过期，请检查 ${prefix}_API_KEY。`, 'UNAUTHORIZED'],
    402: [`${label}账户额度或余额不足，请到控制台检查计费。`, 'PAYMENT_REQUIRED'],
    403: [`${label}拒绝访问，请检查服务开通、账号权限及可用地区。`, 'FORBIDDEN'],
    404: [`${label}模型或接口不可用，请检查型号与服务权限。`, 'NOT_FOUND'],
    413: [`${label}请求内容过大，请缩短口播后重试。`, 'TEXT_LIMIT'],
    429: [`${label}请求过于频繁或项目额度已用尽，请检查额度后稍后重试。`, 'RATE_LIMITED'],
    503: [`${label}服务繁忙，请稍后重试。`, 'UNAVAILABLE'],
  };
  const [message, code] = messages[status] || [`${label}请求失败（HTTP ${status}），请稍后重试。`, 'REQUEST_FAILED'];
  return failure(message, `${prefix}_${code}`, status === 429 ? 429 : 502);
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
}

function checkActive(signal) {
  signal.throwIfAborted();
  // Already-buffered streams can keep resolving reads without letting timers run.
  if (Date.now() >= deadlines.get(signal)) throw new DOMException('Deadline exceeded', 'TimeoutError');
}

async function withDeadline(prefix, label, action) {
  const controller = new AbortController();
  const deadline = Date.now() + TIMEOUT_MS;
  deadlines.set(controller.signal, deadline);
  const timeoutError = () => failure(`${label}合成超时，请稍后重试。`, `${prefix}_TIMEOUT`, 504);
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    const error = timeoutError();
    controller.abort(error);
    rejectTimeout(error);
  }, TIMEOUT_MS);
  try {
    const result = await Promise.race([action(controller.signal), timeout]);
    if (controller.signal.aborted || Date.now() > deadline) throw timeoutError();
    return result;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw timeoutError();
    if (error?.[LOCAL_FAILURE]) throw error;
    throw failure(`暂时无法连接${label}，请检查网络后重试。`, `${prefix}_UNAVAILABLE`, 503);
  } finally {
    clearTimeout(timer);
    deadlines.delete(controller.signal);
  }
}

async function* responseChunks(response, signal, maximum, prefix, label) {
  const declared = Number(response.headers?.get('content-length'));
  if (declared > maximum) {
    cancelBody(response);
    throw failure(`${label}返回的数据过大，请缩短口播后重试。`, `${prefix}_OUTPUT_LIMIT`);
  }
  if (!response.body?.getReader) {
    throw failure(`${label}没有返回有效的音频数据，请稍后重试。`, `${prefix}_INVALID_AUDIO`);
  }
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  let received = 0;
  let finished = false;
  try {
    checkActive(signal);
    while (true) {
      const { done, value } = await reader.read();
      checkActive(signal);
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) {
        throw failure(`${label}返回了无法读取的数据，请稍后重试。`, `${prefix}_INVALID_AUDIO`);
      }
      received += value.byteLength;
      if (received > maximum) {
        throw failure(`${label}返回的数据过大，请缩短口播后重试。`, `${prefix}_OUTPUT_LIMIT`);
      }
      yield value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    try { reader.releaseLock(); } catch {}
  }
}

function decodeAudio(value, remaining, prefix, label) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw failure(`${label}返回的音频编码不正确，请稍后重试。`, `${prefix}_INVALID_AUDIO`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > remaining) {
    throw failure(`${label}返回的音频超过 20 MB，请缩短口播后重试。`, `${prefix}_OUTPUT_LIMIT`);
  }
  return Buffer.from(value, 'base64');
}

function doubaoStreamError(packet) {
  const code = Number(packet.code);
  const mapping = {
    40402003: ['豆包语音文本超出服务限制，请缩短口播后重试。', 'DOUBAO_TEXT_LIMIT'],
    45000000: ['豆包语音拒绝合成，请检查 API Key、服务开通、音色权限和并发额度。', 'DOUBAO_REJECTED'],
    45000001: ['豆包语音请求参数不正确，请检查音色与资源 ID。', 'DOUBAO_BAD_REQUEST'],
    45002000: ['豆包语音缺少音色，请检查 DOUBAO_SPEAKER。', 'DOUBAO_BAD_REQUEST'],
    45002001: ['豆包语音没有识别到可朗读文本，请修改口播后重试。', 'DOUBAO_INVALID_TEXT'],
    55000000: ['豆包语音合成失败，请检查资源 ID 与音色是否匹配，或稍后重试。', 'DOUBAO_GENERATION_FAILED'],
  };
  const [message, localCode] = mapping[code] || ['豆包语音合成失败，请检查服务配置与账户额度后重试。', 'DOUBAO_GENERATION_FAILED'];
  const error = failure(message, localCode);
  if (Number.isSafeInteger(code)) error.upstreamCode = code;
  return error;
}

async function readDoubaoAudio(response, signal) {
  const prefix = 'DOUBAO';
  const label = '豆包语音';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const audio = [];
  let audioBytes = 0;
  let ended = false;
  let pending = '';
  let eventData = [];
  let eventBytes = 0;

  function packet(value) {
    if (!value || value === '[DONE]') return;
    if (Buffer.byteLength(value) > MAX_JSON_BYTES) throw failure('豆包语音返回的数据过大，请缩短口播后重试。', 'DOUBAO_OUTPUT_LIMIT');
    let parsed;
    try { parsed = JSON.parse(value); } catch {
      throw failure('豆包语音返回的数据格式不正确，请稍后重试。', 'DOUBAO_INVALID_RESPONSE');
    }
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.code)) {
      throw failure('豆包语音返回的数据格式不正确，请稍后重试。', 'DOUBAO_INVALID_RESPONSE');
    }
    if (parsed.code !== 0 && parsed.code !== 20000000) throw doubaoStreamError(parsed);
    if (parsed.data !== null && parsed.data !== undefined && parsed.data !== '') {
      const chunk = decodeAudio(parsed.data, MAX_AUDIO_BYTES - audioBytes, prefix, label);
      audio.push(chunk);
      audioBytes += chunk.length;
    }
    if (parsed.code === 20000000) ended = true;
  }

  function flushEvent() {
    if (eventData.length) packet(eventData.join('\n').trim());
    eventData = [];
    eventBytes = 0;
  }

  function line(value) {
    const trimmed = value.replace(/^\uFEFF/u, '').trim();
    if (!trimmed) return flushEvent();
    if (trimmed.startsWith(':') || /^(event|id|retry):/u.test(trimmed)) return;
    if (trimmed.startsWith('data:')) {
      const part = trimmed.slice(5).trimStart();
      eventBytes += Buffer.byteLength(part);
      if (eventBytes > MAX_JSON_BYTES) throw failure('豆包语音返回的数据过大，请缩短口播后重试。', 'DOUBAO_OUTPUT_LIMIT');
      eventData.push(part);
    } else {
      if (eventData.length) flushEvent();
      if (!ended) packet(trimmed);
    }
  }

  try {
    for await (const chunk of responseChunks(response, signal, MAX_STREAM_BYTES, prefix, label)) {
      try { pending += decoder.decode(chunk, { stream: true }); } catch {
        throw failure('豆包语音返回的数据编码不正确，请稍后重试。', 'DOUBAO_INVALID_RESPONSE');
      }
      let cursor = 0;
      let newline;
      while ((newline = pending.indexOf('\n', cursor)) !== -1) {
        line(pending.slice(cursor, newline));
        cursor = newline + 1;
        if (ended) break;
      }
      pending = pending.slice(cursor);
      if (ended) break;
      if (Buffer.byteLength(pending) > MAX_JSON_BYTES) throw failure('豆包语音返回的数据过大，请缩短口播后重试。', 'DOUBAO_OUTPUT_LIMIT');
    }
    if (!ended) {
      try { pending += decoder.decode(); } catch {
        throw failure('豆包语音返回的数据编码不正确，请稍后重试。', 'DOUBAO_INVALID_RESPONSE');
      }
      if (pending) line(pending);
      if (!ended) flushEvent();
    }
  } catch (error) {
    throw error;
  }
  if (!ended) throw failure('豆包语音返回的音频不完整，请稍后重试。', 'DOUBAO_INCOMPLETE_AUDIO');
  const result = Buffer.concat(audio, audioBytes);
  if (result.length < 4 || !(result.subarray(0, 3).toString('ascii') === 'ID3' || (result[0] === 0xff && (result[1] & 0xe0) === 0xe0))) {
    throw failure('豆包语音没有返回有效的 MP3 音频，请稍后重试。', 'DOUBAO_INVALID_AUDIO');
  }
  return result;
}

function isWave(audio) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return false;
  const end = audio.readUInt32LE(4) + 8;
  if (end !== audio.length) return false;
  let hasFormat = false;
  let hasData = false;
  let offset = 12;
  while (offset + 8 <= end) {
    const type = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (size > end - dataStart) return false;
    if (type === 'fmt ') {
      if (size < 16 || !audio.readUInt16LE(dataStart + 2) || !audio.readUInt32LE(dataStart + 4) || !audio.readUInt16LE(dataStart + 14)) return false;
      hasFormat = true;
    }
    if (type === 'data' && size > 0) hasData = true;
    offset = dataStart + size + (size % 2);
  }
  return offset === end && hasFormat && hasData;
}

async function readGeminiAudio(response, signal) {
  const chunks = [];
  let total = 0;
  for await (const chunk of responseChunks(response, signal, MAX_JSON_BYTES, 'GEMINI', 'Gemini')) {
    chunks.push(Buffer.from(chunk));
    total += chunk.length;
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); } catch {
    throw failure('Gemini 返回的数据格式不正确，请稍后重试。', 'GEMINI_INVALID_RESPONSE');
  }
  let part;
  if (Array.isArray(payload?.steps) && !payload.error && !['failed', 'incomplete', 'cancelled'].includes(payload.status)) {
    for (const step of payload.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const candidate of step.content) if (candidate?.type === 'audio') part = candidate;
    }
  }
  if (!part || (part.mime_type && (typeof part.mime_type !== 'string' || !['audio/wav', 'audio/x-wav'].includes(part.mime_type.toLowerCase())))) {
    throw failure('Gemini 没有返回有效的 WAV 音频，请检查 TTS 模型和音色。', 'GEMINI_INVALID_AUDIO');
  }
  const audio = decodeAudio(part.data, MAX_AUDIO_BYTES, 'GEMINI', 'Gemini');
  if (!isWave(audio)) throw failure('Gemini 返回的 WAV 音频不完整或格式不正确，请稍后重试。', 'GEMINI_INVALID_AUDIO');
  return audio;
}

export function createDoubaoProvider({ apiKey, resourceId = 'seed-tts-2.0', speaker = 'zh_female_vv_uranus_bigtts' } = {}) {
  const key = clean(apiKey);
  const resource = clean(resourceId);
  const voice = clean(speaker);
  const errors = credentialError(key, 'DOUBAO', '豆包语音');
  if (!validIdentifier(resource, 120)) errors.push(failure('DOUBAO_RESOURCE_ID 格式不正确，请从豆包语音控制台复制资源 ID。', 'DOUBAO_INVALID_CONFIGURATION', 400));
  if (!validIdentifier(voice)) errors.push(failure('DOUBAO_SPEAKER 格式不正确，请从豆包语音音色库复制音色 ID。', 'DOUBAO_INVALID_CONFIGURATION', 400));
  return {
    ...metadata({ id: 'doubao', label: '豆包语音', model: resource, voice, format: 'mp3', errors,
      cacheIdentity: { provider: 'doubao', protocol: 'http-v3-api-key', resourceId: resource, speaker: voice, format: 'mp3', sampleRate: 24000 } }),
    async generate(input) {
      if (errors.length) throw errors[0];
      const text = validateText(input, 'DOUBAO');
      return withDeadline('DOUBAO', '豆包语音', async (signal) => {
        const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': resource, 'X-Api-Request-Id': randomUUID() },
          body: JSON.stringify({ req_params: { text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000 } } }),
        });
        if (signal.aborted) { cancelBody(response); signal.throwIfAborted(); }
        if (!response.ok) { cancelBody(response); throw httpError('DOUBAO', '豆包语音', response.status); }
        return readDoubaoAudio(response, signal);
      });
    },
  };
}

export function createGeminiProvider({ apiKey, model = 'gemini-3.8-flash-tts', voice = 'Kore', style = '温暖、自然、松弛的中文电台主持口吻。' } = {}) {
  const key = clean(apiKey);
  const selectedModel = clean(model);
  const selectedVoice = clean(voice);
  const selectedStyle = clean(style);
  const errors = credentialError(key, 'GEMINI', 'Google AI Studio');
  if (!GEMINI_MODELS.has(selectedModel)) errors.push(failure('GEMINI_TTS_MODEL 不支持，请选择 gemini-3.8-flash-tts 或 gemini-3.8-flash-lite-tts。', 'GEMINI_INVALID_MODEL', 400));
  if (!validIdentifier(selectedVoice)) errors.push(failure('GEMINI_TTS_VOICE 格式不正确，请填写官方音色名或音色 ID，例如 Kore。', 'GEMINI_INVALID_CONFIGURATION', 400));
  if (typeof style !== 'string' || selectedStyle.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(selectedStyle)) {
    errors.push(failure('GEMINI_TTS_STYLE 需要是最多 2000 字的语气说明。', 'GEMINI_INVALID_CONFIGURATION', 400));
  }
  return {
    ...metadata({ id: 'gemini', label: 'Gemini', model: selectedModel, voice: selectedVoice, format: 'wav', errors,
      cacheIdentity: { provider: 'gemini', protocol: 'interactions-v1beta', model: selectedModel, voice: selectedVoice, style: selectedStyle, format: 'wav', sampleRate: 24000 } }),
    async generate(input) {
      if (errors.length) throw errors[0];
      const text = validateText(input, 'GEMINI');
      return withDeadline('GEMINI', 'Gemini', async (signal) => {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            model: selectedModel,
            input: [{ type: 'user_input', content: [{ type: 'text', text,
              ...(selectedStyle ? { annotations: [{ type: 'speech_metadata', style: selectedStyle }] } : {}) }] }],
            response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
            generation_config: { speech_config: [{ voice: selectedVoice }] },
          }),
        });
        if (signal.aborted) { cancelBody(response); signal.throwIfAborted(); }
        if (!response.ok) { cancelBody(response); throw httpError('GEMINI', 'Gemini', response.status); }
        return readGeminiAudio(response, signal);
      });
    },
  };
}
