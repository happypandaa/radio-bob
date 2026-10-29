/** Only safe, user-facing messages leave this adapter; upstream bodies may contain credentials. */
export class MusicError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'MusicError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const fail = (code, message, status) => new MusicError(code, message, status);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const safeHttpUrl = (value) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : '';
  } catch {
    return '';
  }
};

// NetEase can return a signed HTTP URL even though its official media CDN
// serves the same resource over HTTPS. Preserve the full path/signature and
// account/preview decision; do not guess TLS support for unrelated hosts/ports.
const playbackUrl = (value) => {
  const safe = safeHttpUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  if (url.protocol === 'http:' && !url.port
    && (url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net'))) {
    return safe.replace(/^http:/, 'https:');
  }
  return safe;
};

const MAX_LYRIC_LINES = 400;
const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function timedLines(source) {
  const lines = [];
  let untimed = [];
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line = raw.trim();
    // NetEase prefixes some lyrics with JSON credit lines; metadata tags carry no lyric text.
    if (!line || line.startsWith('{') || /^\[[a-z]+:.*\]$/i.test(line)) continue;
    const stamps = [...line.matchAll(TIMESTAMP)];
    const content = line.replace(TIMESTAMP, '').trim().slice(0, 300);
    if (!stamps.length) { if (content) untimed.push(content); continue; }
    if (!content) continue;
    for (const [, minutes, seconds, fraction = '0'] of stamps) {
      const ms = Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
      lines.push({ time: ms, text: content });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return { lines, untimed };
}

/** Normalize a NetEase lyric payload into display lines. Exported for tests. */
export function parseLyrics(payload) {
  const original = payload?.lrc?.lyric;
  const translated = payload?.tlyric?.lyric;
  const { lines, untimed } = timedLines(original);
  const instrumentalText = /^(?:纯音乐[，,]?\s*请(?:您)?欣赏|此歌曲为没有填词的纯音乐)/;
  const instrumental = Boolean(payload?.pureMusic)
    || [...lines, ...untimed.map((value) => ({ text: value }))].some((line) => instrumentalText.test(line.text));
  if (instrumental) return { status: 'instrumental', lines: [] };
  if (lines.length) {
    const translations = new Map(timedLines(translated).lines.map((line) => [line.time, line.text]));
    return {
      status: 'synced',
      lines: lines.slice(0, MAX_LYRIC_LINES).map((line) => ({
        time: line.time, text: line.text,
        ...(translations.get(line.time) && translations.get(line.time) !== line.text ? { translation: translations.get(line.time) } : {}),
      })),
    };
  }
  if (untimed.length) return { status: 'unsynced', lines: untimed.slice(0, MAX_LYRIC_LINES).map((value) => ({ text: value })) };
  return { status: 'none', lines: [] };
}

/**
 * @typedef {{id:string,title:string,artist:string,album:string,cover:string,durationMs:number}} Track
 * cookieProvider stays on the server. Only checkQr's authorized result contains a cookie,
 * for the caller to persist; never forward that result directly to the browser.
 * fetchImpl/timeoutMs are optional seams for deterministic tests.
 */
export function createMusicClient({
  baseUrl = 'http://127.0.0.1:3000',
  cookieProvider = () => '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  transport,
  unavailableMessage = '暂时无法连接音乐服务，请确认本地音乐服务已启动。',
} = {}) {
  let base;
  try {
    base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error();
    }
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  } catch {
    throw fail('MUSIC_INVALID_CONFIG', '音乐接口地址格式不正确，请检查服务配置。', 500);
  }
  if (typeof fetchImpl !== 'function' || typeof cookieProvider !== 'function'
    || (transport && (typeof transport.request !== 'function' || typeof transport.health !== 'function'))) {
    throw fail('MUSIC_INVALID_CONFIG', '音乐接口配置不完整。', 500);
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  let requestSequence = 0;

  async function withTimeout(operation, milliseconds = requestTimeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = () => reject(new Error('request aborted')); });
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (error instanceof MusicError) throw error;
      if (controller.signal.aborted) {
        throw fail('MUSIC_SERVICE_TIMEOUT', '音乐服务响应超时，请稍后重试。', 504);
      }
      // Do not attach the original error or cause: fetch errors can contain request URLs/bodies.
      throw fail('MUSIC_SERVICE_UNAVAILABLE', unavailableMessage, 503);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAborted);
    }
  }

  async function request(path, params = {}, { authenticated = true, allowedCodes = [200] } = {}) {
    return withTimeout(async (signal) => {
      const url = new URL(path.replace(/^\//, ''), base);
      // The upstream HTTP cache keys by URL. Keep polling and resolved media URLs fresh.
      url.searchParams.set('timestamp', String(Date.now()));
      url.searchParams.set('_rb', String(++requestSequence));
      const body = { ...params, noCookie: true };
      if (authenticated) {
        const cookie = await cookieProvider();
        if (typeof cookie === 'string' && cookie.trim()) body.cookie = cookie;
      }
      const response = transport ? await transport.request(path, body, { signal }) : await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
        cache: 'no-store',
        // A redirect must not forward a POST body containing the session to another host.
        redirect: 'error',
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw fail('MUSIC_LOGIN_REQUIRED', '音乐服务拒绝了请求，请检查登录状态或服务访问权限。', 401);
        }
        throw fail('MUSIC_UPSTREAM_ERROR', '音乐服务暂时无法完成请求，请稍后重试。', 502);
      }
      let payload;
      try {
        payload = transport ? response.body : await response.json();
      } catch {
        if (signal.aborted) throw new Error();
        throw fail('MUSIC_BAD_RESPONSE', '音乐服务返回了无法识别的数据，请检查服务地址。', 502);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw fail('MUSIC_BAD_RESPONSE', '音乐服务返回的数据不完整。', 502);
      }
      const code = Number(payload.code ?? payload.data?.code ?? 200);
      if (!allowedCodes.includes(code)) {
        if (code === 301 || code === 401) {
          throw fail('MUSIC_LOGIN_REQUIRED', '网易云登录已失效，请重新扫码登录。', 401);
        }
        throw fail('MUSIC_UPSTREAM_ERROR', '音乐服务暂时无法完成请求，请稍后重试。', 502);
      }
      return payload;
    });
  }

  const toTrack = (song) => ({
    id: String(song.id),
    title: text(song.name) || '未知歌曲',
    artist: (Array.isArray(song.ar ?? song.artists) ? song.ar ?? song.artists : [])
      .map((artist) => text(artist?.name)).filter(Boolean).join(' / ') || '未知歌手',
    album: text((song.al ?? song.album)?.name),
    cover: safeHttpUrl((song.al ?? song.album)?.picUrl).replace(/^http:/, 'https:'),
    durationMs: positiveNumber(song.dt ?? song.duration) ?? 0,
  });
  const songList = (songs) => (Array.isArray(songs) ? songs : [])
    .filter((song) => song && /^\d{1,24}$/.test(String(song.id ?? ''))).map(toTrack);

  async function profile() {
    let result;
    try {
      result = await request('/login/status');
    } catch (error) {
      if (error instanceof MusicError && error.code === 'MUSIC_LOGIN_REQUIRED') return null;
      throw error;
    }
    const data = (result.data ?? result).profile;
    const userId = data ? positiveNumber(data.userId) : undefined;
    return userId ? { userId, nickname: text(data.nickname) } : null;
  }

  const validId = (id) => {
    const value = String(id ?? '').trim();
    if (!/^\d{1,24}$/.test(value)) {
      throw fail('MUSIC_INVALID_INPUT', '歌曲编号无效。', 400);
    }
    return value;
  };

  return {
    /** @returns {Promise<Track[]>} */
    async search(query, limit = 8) {
      const keywords = text(query);
      if (!keywords) return [];
      if (keywords.length > 500) throw fail('MUSIC_INVALID_INPUT', '搜索内容过长，请缩短后重试。', 400);
      const requestedLimit = Number(limit);
      const count = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.trunc(requestedLimit))) : 8;
      const payload = await request('/cloudsearch', { keywords, type: 1, limit: count, offset: 0 });
      const songs = payload.result?.songs;
      if (songs == null && (payload.result?.songCount === 0 || payload.result?.songCount === '0')) return [];
      if (!Array.isArray(songs)) throw fail('MUSIC_BAD_RESPONSE', '音乐搜索返回的数据不完整。', 502);
      return songList(songs).slice(0, count);
    },

    async resolve(trackId) {
      const id = validId(trackId);
      const payload = await request('/song/url/v1', { id, level: 'standard', unblock: 'false' });
      if (!Array.isArray(payload.data)) throw fail('MUSIC_BAD_RESPONSE', '音乐播放地址返回的数据不完整。', 502);
      const song = payload.data.find((entry) => String(entry?.id) === id);
      if (!song) throw fail('MUSIC_BAD_RESPONSE', '音乐服务没有返回对应歌曲。', 502);
      const url = playbackUrl(song.url);
      if (!url || (song.code != null && Number(song.code) !== 200)) {
        throw fail('MUSIC_UNAVAILABLE', '该歌曲暂无可播放音源，可能受账号权限或版权限制。可以登录后重试，或换一首歌。', 422);
      }
      const trial = song.freeTrialInfo;
      const preview = trial != null && trial !== false && trial !== '' && trial !== 'null';
      const previewDuration = trial && typeof trial === 'object'
        ? positiveNumber((Number(trial.end) - Number(trial.start)) * 1000) : undefined;
      const durationMs = preview ? previewDuration : positiveNumber(song.time ?? song.duration);
      // A preview clip starts part-way into the song; lyrics need that offset.
      const previewStartMs = preview && trial && typeof trial === 'object' ? positiveNumber(Number(trial.start) * 1000) : undefined;
      return { url, preview, ...(durationMs ? { durationMs } : {}), ...(previewStartMs ? { previewStartMs } : {}) };
    },

    /** Lyrics as timed lines; translations are attached to the matching line. */
    async lyric(trackId) {
      const id = validId(trackId);
      const payload = await request('/lyric', { id });
      return parseLyrics(payload);
    },

    /** The signed-in listener's NetEase likes, or null when nobody is signed in. */
    async favorites(limit = 100) {
      const user = await profile();
      if (!user) return null;
      const [liked, playlists] = await Promise.all([
        request('/likelist', { uid: user.userId }),
        request('/user/playlist', { uid: user.userId, limit: 1, offset: 0 }),
      ]);
      const ids = (Array.isArray(liked.ids) ? liked.ids : []).map(String).filter((value) => /^\d{1,24}$/.test(value));
      const lists = Array.isArray(playlists.playlist) ? playlists.playlist : [];
      // The first own playlist is "我喜欢的音乐"; it keeps the order songs were liked in.
      const likedList = lists.find((item) => item?.specialType === 5) || lists[0];
      let tracks = [];
      if (likedList && /^\d{1,24}$/.test(String(likedList.id ?? ''))) {
        const detail = await request('/playlist/track/all', { id: String(likedList.id), limit, offset: 0 });
        tracks = songList(detail.songs).slice(0, limit);
      }
      return { ids, tracks };
    },

    async like(trackId, like = true) {
      const id = validId(trackId);
      const user = await profile();
      if (!user) throw fail('MUSIC_LOGIN_REQUIRED', '请先连接网易云账号。', 401);
      await request('/like', { id, like: like ? 'true' : 'false' });
      return { liked: Boolean(like) };
    },

    async createQr() {
      const result = await request('/login/qr/key', {}, { authenticated: false });
      const key = text(result.data?.unikey);
      if (!key) throw fail('MUSIC_BAD_RESPONSE', '暂时无法生成登录二维码，请重试。', 502);
      const qr = await request('/login/qr/create', { key, qrimg: true }, { authenticated: false });
      const image = text(qr.data?.qrimg);
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) {
        throw fail('MUSIC_BAD_RESPONSE', '登录二维码数据不完整，请重试。', 502);
      }
      return { key, image };
    },

    async checkQr(qrKey) {
      const key = text(qrKey);
      if (!key || key.length > 512) throw fail('MUSIC_INVALID_INPUT', '登录二维码无效，请重新生成。', 400);
      const result = await request('/login/qr/check', { key }, {
        authenticated: false, allowedCodes: [800, 801, 802, 803],
      });
      const status = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'authorized' }[Number(result.code)];
      if (!status) throw fail('MUSIC_BAD_RESPONSE', '暂时无法确认登录状态，请重试。', 502);
      const nickname = text(result.nickname);
      if (status === 'authorized') {
        const cookie = text(result.cookie);
        if (!cookie) throw fail('MUSIC_BAD_RESPONSE', '登录授权没有返回有效会话，请重新扫码。', 502);
        return { status, cookie, ...(nickname ? { nickname } : {}) };
      }
      return { status, ...(nickname && status === 'scanned' ? { nickname } : {}) };
    },

    async account() {
      const user = await profile();
      return { loggedIn: Boolean(user), ...(user?.nickname ? { nickname: user.nickname } : {}) };
    },

    async health() {
      try {
        if (transport) return Boolean(await withTimeout(signal => transport.health({ signal }), Math.min(requestTimeout, 3000)));
        return await withTimeout(async (signal) => {
          // The local landing page does not contact NetEase or need the user's session.
          const response = await fetchImpl(base, { method: 'GET', signal, redirect: 'error', cache: 'no-store' });
          await response.body?.cancel();
          return response.ok;
        }, Math.min(requestTimeout, 3000));
      } catch {
        return false;
      }
    },
  };
}
