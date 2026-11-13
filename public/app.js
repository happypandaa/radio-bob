'use strict';

const $ = (id) => document.getElementById(id);
const music = $('music-audio');
const speech = $('speech-audio');
const state = { messages: [], queue: [], nowPlayingId: null, taste: '', volume: 0.7 };
let services = null;
let activeTrack = null;
let pendingUser = null;
let chatBusy = false;
let loadingTrack = false;
let musicRequest = 0;
let speechRequest = 0;
let searchRequest = 0;
let userVolume = 0.7;
let autoVoice = true;
let toastTimer;
let qrTimer;
let qrGeneration = 0;
let qrCheckingGeneration = null;
let lastStateFingerprint = '';
let favorites = [];
let showingFavorites = false;
let libraryOpen = false;
let chatScrollBeforeLibrary = 0;
// A "segment" is Bob speaking and then starting a set of songs. Any explicit
// listener action bumps the token so a pending segment never overrides it.
let segmentToken = 0;
let introPhase = false;
let queueFinished = false;
let fading = false;
let outro = null;
const OUTRO_LEAD_SECONDS = 40;
// Favorites live in NetEase "我喜欢的音乐" when signed in, otherwise in this browser.
// The two lists are deliberately never synchronised.
let favoriteSource = 'local';
let remoteFavorites = [];
let remoteLikedIds = new Set();
let remoteFavoritesState = 'idle';
let lyric = { trackId: null, status: 'idle', lines: [] };
let renderedLyricKey = '';
let lyricIndex = -2;
let previewStartMs = 0;
const lyricCache = new Map();

function readPreference(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePreference(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* Playback still works without storage. */ }
}
autoVoice = readPreference('radio-bob-auto-voice', 'true') !== 'false';
$('auto-voice').checked = autoVoice;
try { favorites = normalizeTracks(JSON.parse(readPreference('radio-bob-favorites', '[]'))); } catch { favorites = []; }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}
function safeUrl(value, image = false) {
  if (typeof value !== 'string' || !value) return '';
  if (image && /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/.test(value)) return value;
  try {
    const url = new URL(value, location.origin);
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch { /* Invalid provider URL. */ }
  return '';
}
function normalizeTrack(track) {
  if (!track || track.id === undefined || track.id === null) return null;
  return {
    id: String(track.id), title: String(track.title || '未命名歌曲'),
    artist: String(track.artist || '未知歌手'), album: String(track.album || ''),
    cover: safeUrl(track.cover, true), durationMs: Number(track.durationMs) || 0,
  };
}
function normalizeTracks(tracks) {
  return Array.isArray(tracks) ? tracks.map(normalizeTrack).filter(Boolean) : [];
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function timeLabel(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 125000);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求未完成（${response.status}），请稍后重试。`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('这次等待有点久，请稍后重试。');
    if (error instanceof TypeError) throw new Error('暂时连接不到电台，请检查本地服务是否正在运行。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function post(path, body, options = {}) {
  return api(path, { ...options, method: 'POST', body: JSON.stringify(body) });
}

function updateClock() {
  const now = new Date();
  $('clock').dateTime = now.toISOString();
  $('clock-hours').textContent = String(now.getHours()).padStart(2, '0');
  $('clock-minutes').textContent = String(now.getMinutes()).padStart(2, '0');
  $('clock').setAttribute('aria-label', now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
}

// Follows the system until the listener picks a side with the moon/sun button.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const saved = readPreference('radio-bob-theme-v2', '');
  const theme = saved === 'light' || saved === 'dark' ? saved : systemDark.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换到日间模式' : '切换到夜间模式');
}
function toggleTheme() {
  savePreference('radio-bob-theme-v2', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  applyTheme();
}
systemDark.addEventListener('change', applyTheme);

function setLibraryOpen(open) {
  const scroll = $('conversation-scroll');
  if (open && !libraryOpen) chatScrollBeforeLibrary = scroll.scrollTop;
  const wasOpen = libraryOpen;
  libraryOpen = open;
  $('library-body').hidden = !open;
  $('stream-body').hidden = open;
  $('library-button').setAttribute('aria-expanded', String(open));
  if (open || wasOpen) scroll.scrollTo({ top: open ? 0 : chatScrollBeforeLibrary, behavior: 'instant' });
}

function isFavorite(track) {
  if (!track) return false;
  return favoriteSource === 'netease' ? remoteLikedIds.has(track.id) : favorites.some(item => item.id === track.id);
}
function renderFavorite() {
  const saved = isFavorite(activeTrack);
  $('favorite').disabled = !activeTrack;
  $('favorite').classList.toggle('saved', saved);
  $('favorite').setAttribute('aria-pressed', String(saved));
  const target = favoriteSource === 'netease' ? '网易云「我喜欢的音乐」' : '收藏';
  $('favorite').setAttribute('aria-label', saved ? `从${target}移除当前歌曲` : `把当前歌曲加入${target}`);
}

async function toggleFavorite() {
  if (!activeTrack) return;
  const track = activeTrack;
  const exists = isFavorite(track);
  if (favoriteSource === 'netease') {
    $('favorite').disabled = true;
    try {
      await post('/api/favorites', { track, like: !exists });
      if (exists) { remoteLikedIds.delete(track.id); remoteFavorites = remoteFavorites.filter(item => item.id !== track.id); }
      else { remoteLikedIds.add(track.id); remoteFavorites = [track, ...remoteFavorites.filter(item => item.id !== track.id)]; }
      toast(exists ? '已从网易云「我喜欢的音乐」移除。' : '已加到网易云「我喜欢的音乐」，曲库的「收藏」里能看到。');
    } catch (error) { toast(error.message); }
    finally { renderFavorite(); if (showingFavorites) renderQueue(); }
    return;
  }
  favorites = exists ? favorites.filter(item => item.id !== track.id) : [...favorites, track];
  savePreference('radio-bob-favorites', JSON.stringify(favorites));
  renderFavorite();
  if (showingFavorites) renderQueue();
  toast(exists ? '已从收藏中移除。' : '已收藏，曲库的「收藏」里能看到。');
}
async function refreshFavorites() {
  const signedIn = Boolean(services?.music?.loggedIn);
  favoriteSource = signedIn ? 'netease' : 'local';
  if (!signedIn) { remoteFavorites = []; remoteLikedIds = new Set(); remoteFavoritesState = 'idle'; renderFavorite(); if (showingFavorites) renderQueue(); return; }
  remoteFavoritesState = 'loading';
  if (showingFavorites) renderQueue();
  try {
    const data = await api('/api/favorites', { timeout: 30000 });
    if (data.source === 'netease') {
      remoteFavorites = normalizeTracks(data.tracks);
      remoteLikedIds = new Set([...(Array.isArray(data.ids) ? data.ids.map(String) : []), ...remoteFavorites.map(track => track.id)]);
      remoteFavoritesState = 'ready';
    } else remoteFavoritesState = 'error';
  } catch (error) {
    remoteFavoritesState = 'error';
    if (showingFavorites) toast(error.message);
  }
  renderFavorite();
  if (showingFavorites) renderQueue();
}

function renderStatus() {
  for (const [key, label] of [['claude', 'AI'], ['tts', 'Fish'], ['music', 'Music']]) {
    const item = $(`${key}-status`);
    const service = services?.[key] || (key === 'tts' ? services?.fish : null);
    item.classList.toggle('ready', Boolean(service?.ready));
    item.classList.toggle('failed', Boolean(services && !service?.ready));
    const description = !services ? '正在检查' : service?.message || (service?.ready ? '已就绪' : '未就绪');
    item.title = `${label}：${description}`;
    item.setAttribute('aria-label', `${label}：${description}`);
  }
  const loggedIn = Boolean(services?.music?.loggedIn);
  const loginEnabled = services?.music?.loginEnabled !== false;
  $('account-button').disabled = !loginEnabled;
  $('account-button').classList.toggle('connected', loggedIn);
  $('account-label').textContent = loggedIn ? 'LINKED' : loginEnabled ? 'LOGIN' : 'GUEST';
  $('account-button').setAttribute('aria-label', !loginEnabled ? '游客模式，暂不支持连接网易云账号' : loggedIn ? '查看网易云账号' : '连接网易云');
  $('account-button').title = !loginEnabled ? services.music.message || '暂不支持连接网易云账号。' : '';
  if (speech.paused) $('voice-label').textContent = voiceLabel();
}
function voiceLabel() {
  const voice = services?.tts || services?.fish;
  return services && !voice?.ready ? 'Fish 口播尚未就绪' : 'DJ 口播 · Fish Audio';
}
async function refreshStatus(showFeedback = false) {
  $('refresh-status').disabled = true;
  try {
    const data = await api('/api/status', { timeout: 30000 });
    const wasSignedIn = Boolean(services?.music?.loggedIn);
    services = data.services || {};
    renderStatus();
    if (Boolean(services.music?.loggedIn) !== wasSignedIn || (services.music?.loggedIn && remoteFavoritesState === 'idle')) void refreshFavorites();
    if (showFeedback) {
      const missing = [['claude', 'AI'], ['tts', '语音'], ['music', '音乐']]
        .filter(([key]) => key === 'tts' ? !(services.tts || services.fish)?.ready : !services[key]?.ready)
        .map(([, label]) => label);
      toast(missing.length ? `${missing.join('、')}尚未就绪，请检查本地配置。`
        : 'AI 配置、Fish 口播和音乐服务均已就绪。');
    }
  } catch (error) {
    if (showFeedback) toast(error.message);
  } finally { $('refresh-status').disabled = false; }
}

function applyState(next) {
  if (!next || typeof next !== 'object') return;
  if (Array.isArray(next.messages)) {
    state.messages = next.messages;
    if (pendingUser && next.messages.some(message => message.role === 'user' && message.content === pendingUser.content && !pendingUser.previousIds.has(message.id))) pendingUser = null;
  }
  if (Array.isArray(next.queue)) state.queue = normalizeTracks(next.queue);
  if (typeof next.taste === 'string') state.taste = next.taste;
  if (next.nowPlayingId !== undefined) state.nowPlayingId = next.nowPlayingId === null ? null : String(next.nowPlayingId);
  if (!activeTrack && state.queue.length) {
    activeTrack = state.queue.find(track => track.id === state.nowPlayingId) || state.queue[0];
    renderNowPlaying();
  }
  renderQueue();
  renderMessages();
  updateTransport();
}

function makeTrackRow(track, index, mode = 'queue') {
  const row = node('div', `track-row${activeTrack?.id === track.id ? ' current' : ''}`);
  if (mode === 'queue') row.append(node('span', 'track-number', activeTrack?.id === track.id && !music.paused ? '▸' : String(index + 1).padStart(2, '0')));
  const thumb = node('div', 'track-thumb');
  if (track.cover) {
    const image = node('img');
    image.src = track.cover;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => { thumb.replaceChildren(icon('music')); }, { once: true });
    thumb.append(image);
  } else thumb.append(icon('music'));
  const info = node('div', 'track-info');
  info.append(node('strong', '', track.title), node('small', '', [track.artist, track.album].filter(Boolean).join(' · ')));
  row.append(thumb, info);
  if (mode !== 'message' && track.durationMs) row.append(node('span', 'track-time', formatTime(track.durationMs / 1000)));
  const play = node('button', 'track-action');
  play.type = 'button';
  play.setAttribute('aria-label', `播放 ${track.title}，${track.artist}`);
  play.title = '播放这首';
  play.append(icon('play'));
  play.addEventListener('click', async () => {
    cancelSegment();
    if (!state.queue.some(item => item.id === track.id)) {
      const added = await addTracks([track], 'append');
      if (!added) return;
    }
    await playTrack(track);
  });
  row.append(play);
  if (mode === 'search') {
    const add = node('button', 'track-action');
    add.type = 'button';
    add.setAttribute('aria-label', `将 ${track.title} 加入队列`);
    add.title = '加入队列';
    add.append(icon('plus'));
    add.addEventListener('click', async () => {
      add.disabled = true;
      if (await addTracks([track], 'append')) toast(`已将《${track.title}》加入队列。`);
      add.disabled = false;
    });
    row.append(add);
  }
  return row;
}
function renderQueue() {
  const remote = favoriteSource === 'netease';
  const tracks = showingFavorites ? (remote ? remoteFavorites : favorites) : state.queue;
  $('queue-count').textContent = state.queue.length;
  $('show-favorites').textContent = remote ? '收藏 · 网易云' : '收藏';
  $('queue-tab').classList.toggle('active', !showingFavorites);
  $('queue-empty').firstElementChild.textContent = !showingFavorites ? '队列还空着。告诉 Bob 你想听什么，或自己找一首。'
    : !remote ? '还没有收藏。播放喜欢的歌时，点击爱心保存。'
      : remoteFavoritesState === 'loading' ? '正在读取你在网易云的红心歌曲…'
        : remoteFavoritesState === 'error' ? '网易云红心歌曲暂时没读到，稍后再打开收藏试试。'
          : '网易云「我喜欢的音乐」还是空的。播放喜欢的歌时，点爱心加进去。';
  renderQuickReplies();
  $('queue-empty').hidden = tracks.length > 0;
  $('queue-list').replaceChildren(...tracks.map((track, index) => makeTrackRow(track, index)));
  $('show-favorites').setAttribute('aria-pressed', String(showingFavorites));
  $('show-favorites').classList.toggle('active', showingFavorites);
}
const favoriteButton = $('favorite');
const lyricsBox = $('lyrics');
let historyOpen = false;
let speakingMessageId = null;
function splitSentences(text) {
  // Clause by clause, so the highlight moves at a speaking pace.
  return String(text || '').split(/(?<=[。！？!?…；;，,\n]|——)/).filter(part => part.length);
}
function trackMeta(track) { return [track.artist, track.album].filter(Boolean).join(' · '); }
/** One line per song: title, then artist · album in small type. */
function makeSetRow(track, index, tracks) {
  const row = node('button', 'set-row');
  row.type = 'button';
  row.setAttribute('aria-label', `播放 ${track.title}，${track.artist}`);
  const line = node('span', 'row-line');
  line.append(node('span', 'row-title', track.title), node('span', 'row-meta', trackMeta(track)));
  row.append(node('span', 'row-num', String(index + 1)), line);
  if (track.durationMs) row.append(node('span', 'row-time', formatTime(track.durationMs / 1000)));
  row.addEventListener('click', async () => {
    cancelSegment();
    // A song from an earlier set brings that whole set back as the queue.
    if (!state.queue.some(item => item.id === track.id) && !(await addTracks(tracks, 'replace'))) return;
    await playTrack(state.queue.find(item => item.id === track.id) || track);
  });
  return row;
}
/** The playing song gets its own surface, with the heart and the lyrics inside it. */
function makeActiveRow(track) {
  const box = node('div', 'set-active');
  const row = node('div', 'set-row');
  const eq = node('span', 'eq');
  eq.setAttribute('aria-hidden', 'true');
  eq.append(node('i'), node('i'), node('i'));
  const line = node('span', 'row-line');
  line.append(node('span', 'row-title', track.title), node('span', 'row-meta', trackMeta(track)));
  row.append(eq, line, favoriteButton);
  box.append(row, lyricsBox);
  return box;
}
function parkActiveExtras() {
  const holder = $('active-extras');
  if (favoriteButton.parentElement !== holder) holder.append(favoriteButton);
  if (lyricsBox.parentElement !== holder) holder.append(lyricsBox);
}
function makeBobMessage(message, old) {
  const article = node('article', `msg-bob${old ? ' old' : ''}`);
  article.dataset.id = message.id;
  const head = node('div', 'msg-head');
  head.append(node('strong', '', 'Bob'), node('time', '', timeLabel(message.createdAt)));
  if (message.content) {
    const replay = node('button', 'mini-button');
    replay.type = 'button';
    replay.title = '重播';
    replay.setAttribute('aria-label', '重播 Bob 这段');
    replay.append(icon('sound'));
    replay.addEventListener('click', async () => {
      replay.disabled = true;
      const request = speechRequest;
      try {
        const url = safeUrl(message.speechUrl);
        if (url) await playSpeech(url, message.id);
        else {
          const result = await post('/api/tts', { text: message.content, messageId: message.id });
          if (request === speechRequest) await playSpeech(result.url, message.id);
        }
      } catch (error) { toast(error.message); }
      finally { replay.disabled = false; }
    });
    head.append(replay);
  }
  const text = node('p', 'bob-text');
  for (const part of splitSentences(message.content)) text.append(node('span', 'sentence', part));
  article.append(head, text);
  if (message.note && !old) article.append(node('p', 'msg-note', message.note));
  return article;
}
function renderMessages() {
  const activeId = stageVisible() ? activeTrack.id : '';
  const fingerprint = JSON.stringify([state.messages, pendingUser?.id, activeId, historyOpen]);
  if (fingerprint === lastStateFingerprint) return;
  lastStateFingerprint = fingerprint;
  const container = $('messages');
  const scroll = $('conversation-scroll');
  const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  parkActiveExtras();
  const empty = $('chat-empty');
  for (const child of [...container.children]) if (child !== empty) child.remove();
  const messages = [...state.messages];
  if (pendingUser) messages.push(pendingUser);
  empty.hidden = messages.length > 0;
  // Only the current exchange is shown: from the listener's latest request onward.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === 'user') { start = i; break; }
  const earlier = messages.slice(0, start).filter(message => message.role !== 'user').length;
  const toggle = $('history-toggle');
  toggle.hidden = earlier === 0;
  toggle.textContent = historyOpen ? '收起更早的' : `更早 · ${earlier} 段`;
  toggle.setAttribute('aria-expanded', String(historyOpen));
  const visible = historyOpen ? messages : messages.slice(start);
  let ownerId = null;
  if (activeId) for (const message of visible) if (message.role !== 'user' && normalizeTracks(message.tracks).some(track => track.id === activeId)) ownerId = message.id;
  for (const message of visible) {
    const old = historyOpen && messages.indexOf(message) < start;
    if (message.role === 'user') {
      container.append(node('p', `msg-user${message === pendingUser ? ' pending' : ''}${old ? ' old' : ''}`, `你：${message.content}`));
      continue;
    }
    const article = makeBobMessage(message, old);
    const tracks = normalizeTracks(message.tracks);
    if (tracks.length) {
      const set = node('div', 'set');
      const activeIndex = message.id === ownerId ? tracks.findIndex(track => track.id === activeId) : -1;
      tracks.forEach((track, index) => {
        if (index === activeIndex) { set.append(makeActiveRow(track)); return; }
        const row = makeSetRow(track, index, tracks);
        if (index < activeIndex) row.classList.add('played');
        set.append(row);
      });
      article.append(set);
    }
    container.append(article);
  }
  // A song played from search or favorites still gets its surface at the end of the stream.
  if (activeId && !ownerId) {
    const set = node('div', 'set');
    set.append(makeActiveRow(activeTrack));
    container.append(set);
  }
  syncKaraoke();
  if (activeId) requestAnimationFrame(() => syncLyrics(true));
  if (wasNearBottom || pendingUser) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}
/** Sentence-level karaoke: Fish Audio gives no word timings, so time is shared out by length. */
function syncKaraoke() {
  const speaking = Boolean(speakingMessageId) && !speech.paused && !speech.ended;
  for (const element of document.querySelectorAll('.bob-text.karaoke')) {
    if (!speaking || element.parentElement.dataset.id !== speakingMessageId) element.classList.remove('karaoke');
  }
  if (!speaking) return;
  const text = [...document.querySelectorAll('.msg-bob')].find(item => item.dataset.id === speakingMessageId)?.querySelector('.bob-text');
  if (!text) return;
  text.classList.add('karaoke');
  const parts = [...text.children];
  const total = parts.reduce((sum, part) => sum + part.textContent.length, 0) || 1;
  const fraction = Number.isFinite(speech.duration) && speech.duration > 0 ? speech.currentTime / speech.duration : 0;
  let reached = 0;
  let index = parts.length - 1;
  for (let i = 0; i < parts.length; i += 1) {
    reached += parts[i].textContent.length;
    if (reached / total > fraction) { index = i; break; }
  }
  parts.forEach((part, i) => { part.classList.toggle('said', i < index); part.classList.toggle('now', i === index); });
}

async function addTracks(tracks, mode = 'append') {
  try {
    const result = await post('/api/queue', { tracks, mode });
    state.queue = normalizeTracks(result.queue);
    if (!activeTrack && state.queue.length) {
      activeTrack = state.queue[0];
      renderNowPlaying();
    }
    renderQueue();
    updateTransport();
    return true;
  } catch (error) { toast(error.message); return false; }
}
function renderNowPlaying() {
  renderStage();
  $('current-title').textContent = activeTrack?.title || '今天想听点什么？';
  $('current-artist').textContent = activeTrack ? trackMeta(activeTrack) : '一种心情，一个场景，或一首喜欢的歌。';
  const cover = activeTrack?.cover;
  renderFavorite();
  if (!music.src) $('duration').textContent = formatTime((activeTrack?.durationMs || 0) / 1000);
  if ('mediaSession' in navigator && activeTrack && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeTrack.title, artist: activeTrack.artist, album: activeTrack.album,
      artwork: cover ? [{ src: cover }] : [],
    });
  }
}
function setNotice(text) {
  $('player-notice').textContent = text;
  $('player-notice').hidden = !text;
}
function updateTransport() {
  const hasTrack = Boolean(activeTrack || state.queue.length);
  $('play').disabled = !hasTrack || loadingTrack;
  $('next').disabled = !hasTrack || loadingTrack;
  const playing = !music.paused && !music.ended;
  const speaking = !speech.paused && !speech.ended;
  $('play-icon').setAttribute('href', playing ? '/assets/icons.svg#i-pause' : '/assets/icons.svg#i-play');
  $('play').setAttribute('aria-label', playing ? '暂停' : introPhase ? '跳过开场，直接放歌' : '播放');
  $('next').setAttribute('aria-label', introPhase ? '跳过开场，直接放歌' : '下一首');
  document.body.classList.toggle('is-playing', playing);
  document.body.classList.toggle('is-speaking', speaking);
  renderAirStatus();
  $('profile-air').textContent = playing || speaking ? 'LIVE' : 'IDLE';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : activeTrack ? 'paused' : 'none';
  setBarsMode(speaking ? 'speech' : playing ? 'music' : 'idle');
  renderStage();
}
let eventsStarted = false;
function renderAirStatus() {
  const playing = !music.paused && !music.ended;
  const speaking = !speech.paused && !speech.ended;
  const index = state.queue.findIndex(track => track.id === activeTrack?.id);
  const position = index >= 0 && state.queue.length > 1 ? ` · ${index + 1} / ${state.queue.length}` : '';
  $('air-label').textContent = eventsStarted && !document.body.classList.contains('connected') ? '连接中断，正在重连…'
    : chatBusy ? 'Bob 在选歌…'
      : speaking ? 'Bob 正在说…'
        : loadingTrack ? '正在准备…'
          : playing ? `放歌中${position}`
            : queueFinished ? '这一组放完了'
              : activeTrack && music.getAttribute('src') ? '已暂停' : '待机';
  $('air-status').classList.toggle('live', speaking || chatBusy);
  $('air-status').classList.toggle('playing', playing);
}
function updateMusicVolume() {
  if (fading) return;
  music.volume = Math.min(1, Math.max(0, userVolume * (!speech.paused && !speech.ended ? 0.22 : 1)));
}
async function reportPlayer(action) {
  if (!activeTrack) return;
  try { await post('/api/player', { action, trackId: activeTrack.id, positionMs: Math.round((music.currentTime || 0) * 1000) }); }
  catch { /* A reporting failure must not interrupt audio. */ }
}
async function playTrack(track, prepared) {
  if (!track) return;
  const request = ++musicRequest;
  loadingTrack = true;
  queueFinished = false;
  renderQuickReplies();
  music.pause();
  music.removeAttribute('src');
  music.load();
  activeTrack = track;
  $('preview-badge').hidden = true;
  $('elapsed').textContent = '0:00';
  $('duration').textContent = formatTime(track.durationMs / 1000);
  $('seek').value = 0;
  $('seek').disabled = true;
  setNotice('');
  previewStartMs = 0;
  renderNowPlaying();
  renderQueue();
  updateTransport();
  void loadLyrics(track);
  try {
    const result = await (prepared || resolveTrack(track));
    if (request !== musicRequest) return;
    previewStartMs = Number(result.previewStartMs) || 0;
    const url = safeUrl(result.url);
    if (!url) throw new Error('这首歌暂时无法播放。可以尝试连接网易云账号，或换一首歌。');
    $('preview-badge').hidden = !result.preview;
    if (result.preview) setNotice('当前为试听片段。完整播放取决于这首歌和你的网易云账号权限。');
    music.src = url;
    updateMusicVolume();
    await music.play();
  } catch (error) {
    if (request !== musicRequest) return;
    if (error.name === 'NotAllowedError') setNotice('歌曲已准备好，点击播放按钮开始收听。');
    else if (error.name !== 'AbortError') {
      setNotice(error.message || '这首歌暂时无法播放，请尝试下一首。');
      toast(error.message || '这首歌暂时无法播放。');
    }
  } finally {
    if (request === musicRequest) {
      loadingTrack = false;
      updateTransport();
    }
  }
}
async function togglePlayback() {
  if (!music.paused) {
    pausePlayback();
    return;
  }
  const skippingIntro = introPhase;
  cancelSegment();
  if (skippingIntro) { speechRequest += 1; speech.pause(); }
  if (music.src && activeTrack && !music.error) {
    try {
      await music.play();
      setNotice($('preview-badge').hidden ? '' : '当前为试听片段。完整播放取决于这首歌和你的网易云账号权限。');
    } catch { setNotice('浏览器还没开始播放，请再次点击播放，或尝试下一首。'); }
  } else await playTrack(activeTrack || state.queue[0]);
}
function pausePlayback() {
  // Invalidate an in-flight URL lookup before it can start audio after a pause.
  musicRequest += 1;
  speechRequest += 1;
  cancelSegment();
  loadingTrack = false;
  music.pause();
  speech.pause();
  updateTransport();
}
async function moveTrack(direction, ended = false) {
  if (!state.queue.length) return;
  if (!ended) cancelSegment();
  const request = musicRequest;
  if (direction < 0 && music.currentTime > 3) { music.currentTime = 0; return; }
  const index = state.queue.findIndex(track => track.id === activeTrack?.id);
  const next = index === -1 ? (direction > 0 ? 0 : state.queue.length - 1) : index + direction;
  if (next >= state.queue.length) {
    // The end of a set never wraps around: Bob closes it and asks what comes next.
    if (!ended) { await reportPlayer('skip'); musicRequest += 1; loadingTrack = false; music.pause(); }
    await handleQueueEnd();
    return;
  }
  // Keep the user's chosen target stable if an SSE update replaces the queue.
  const target = state.queue[Math.max(0, next)];
  if (!ended) await reportPlayer('skip');
  if (request !== musicRequest) return;
  await playTrack(target);
}
function resolveTrack(track) {
  return api(`/api/music/url/${encodeURIComponent(track.id)}`, { timeout: 40000 });
}
function cancelSegment() {
  segmentToken += 1;
  introPhase = false;
}
function currentPlayerState() {
  if (introPhase || loadingTrack || (!music.paused && !music.ended)) return 'playing';
  if (queueFinished || music.ended) return 'ended';
  return music.getAttribute('src') ? 'paused' : 'idle';
}
function fadeOutMusic(duration = 700) {
  if (music.paused || music.ended) return Promise.resolve();
  return new Promise(resolve => {
    const startVolume = music.volume;
    const began = performance.now();
    fading = true;
    // Timers keep running in a background tab, unlike animation frames.
    const step = () => {
      const progress = Math.min(1, (performance.now() - began) / duration);
      music.volume = startVolume * (1 - progress);
      if (progress < 1 && !music.paused) { setTimeout(step, 40); return; }
      music.pause();
      fading = false;
      updateMusicVolume();
      resolve();
    };
    step();
  });
}
function speakAndWait(url, messageId = null) {
  return new Promise(resolve => {
    const events = ['ended', 'pause', 'error'];
    const done = () => { for (const name of events) speech.removeEventListener(name, done); resolve(); };
    playSpeech(url, messageId).then(started => {
      if (!started || speech.paused || speech.ended) return resolve();
      for (const name of events) speech.addEventListener(name, done);
    }, error => { toast(error.message); resolve(); });
  });
}
/** Bob introduces a new set, then the first song starts. */
async function startSegment(tracks, speechUrl, messageId = null) {
  if (!tracks.length) return;
  cancelSegment();
  const token = segmentToken;
  outro = null;
  queueFinished = false;
  // Drop any in-flight lookup for the previous song, then prepare the new one while Bob talks.
  musicRequest += 1;
  loadingTrack = false;
  const first = tracks[0];
  const prepared = resolveTrack(first);
  prepared.catch(() => {});
  await fadeOutMusic();
  if (token !== segmentToken) return;
  activeTrack = first;
  music.removeAttribute('src');
  music.load();
  $('elapsed').textContent = '0:00';
  $('seek').value = 0;
  setNotice('');
  void loadLyrics(first);
  if (speechUrl) {
    introPhase = true;
    renderNowPlaying();
    renderQueue();
    updateTransport();
    await speakAndWait(speechUrl, messageId);
    if (token !== segmentToken) return;
    introPhase = false;
  }
  await playTrack(first, prepared);
}
async function playSet(tracks) {
  cancelSegment();
  if (await addTracks(tracks, 'replace')) await playTrack(state.queue[0]);
}
function outroKey() { return state.queue.map(track => track.id).join(','); }
function requestOutro() {
  const last = state.queue.at(-1);
  const key = outroKey();
  if (!last || chatBusy || outro?.key === key) return;
  const entry = { key, spoken: false };
  outro = entry;
  entry.promise = post('/api/dj/outro', { lastTrackId: last.id }, { timeout: 190000 }).then(result => {
    entry.result = result;
    if (result.message && !state.messages.some(message => message.id === result.message.id)) {
      state.messages.push(result.message);
      renderMessages();
    }
    return result;
  }).catch(() => null);
}
async function handleQueueEnd() {
  queueFinished = true;
  const token = segmentToken;
  updateTransport();
  renderQueue();
  renderQuickReplies();
  if (!state.queue.length) return;
  requestOutro();
  const entry = outro;
  if (!entry) { setNotice('这一轮听完了。和 Bob 再聊聊，续上下一段音乐。'); return; }
  setNotice('这一组听完了，Bob 正在想下一段…');
  const result = await entry.promise;
  if (token !== segmentToken || !queueFinished || outro !== entry) return;
  if (!result) { setNotice('这一轮听完了。和 Bob 再聊聊，续上下一段音乐。'); return; }
  renderQuickReplies();
  setNotice(result.tracks?.length
    ? 'Bob 准备了下一组：点「好，接着放」或回复「好」就开始，也可以直接告诉他想听什么。'
    : '这一轮听完了。和 Bob 再聊聊，续上下一段音乐。');
  const url = result.speech?.url || result.message?.speechUrl;
  if (autoVoice && url && !entry.spoken) {
    entry.spoken = true;
    await speakAndWait(url, result.message?.id);
  }
}
async function playSpeech(url, messageId = null) {
  const source = safeUrl(url);
  if (!source) throw new Error('这段口播暂时无法播放，可以稍后重试。');
  const request = ++speechRequest;
  speakingMessageId = messageId;
  speech.pause();
  speech.src = source;
  try { await speech.play(); return request === speechRequest; }
  catch (error) {
    if (request !== speechRequest) return false;
    if (error.name === 'NotAllowedError') { toast('口播已生成，点 Bob 那段话旁边的重播就能听。'); return false; }
    throw new Error('口播音频未能播放，请稍后重试。');
  }
}
function updateSpeechState() {
  const playing = !speech.paused && !speech.ended;
  $('voice-label').textContent = playing ? 'Bob 正在说话…' : voiceLabel();
  updateMusicVolume();
  updateTransport();
  syncKaraoke();
}

function coverUrl(url, size) {
  const safe = safeUrl(url, true);
  if (!safe || safe.startsWith('data:')) return safe;
  // NetEase's image CDN resizes on request; other hosts ignore the parameter.
  return /music\.126\.net\//.test(safe) && !safe.includes('?') ? `${safe}?param=${size}y${size}` : safe;
}
function stageVisible() {
  return Boolean(activeTrack && (introPhase || loadingTrack || queueFinished || music.getAttribute('src')));
}
function renderStage() {
  renderMessages();
  if (stageVisible()) renderLyrics();
}
async function loadLyrics(track) {
  if (!track) return;
  const id = track.id;
  if (lyric.trackId === id && lyric.status !== 'error') return;
  const cached = lyricCache.get(id);
  lyric = cached ? { trackId: id, ...cached } : { trackId: id, status: 'loading', lines: [] };
  renderLyrics();
  if (cached) return;
  let data;
  try {
    data = await api(`/api/music/lyric/${encodeURIComponent(id)}`, { timeout: 20000 });
    if (!['synced', 'unsynced', 'instrumental', 'none'].includes(data.status) || !Array.isArray(data.lines)) throw new Error();
    lyricCache.set(id, data);
    if (lyricCache.size > 40) lyricCache.delete(lyricCache.keys().next().value);
  } catch { data = { status: 'error', lines: [] }; }
  if (lyric.trackId !== id) return;
  lyric = { trackId: id, ...data };
  renderLyrics();
}
function renderLyrics() {
  if (!activeTrack) return;
  const current = lyric.trackId === activeTrack.id ? lyric : { status: 'loading', lines: [] };
  const showLines = !introPhase && ['synced', 'unsynced'].includes(current.status) && current.lines.length;
  const key = `${activeTrack.id}|${showLines ? current.status : 'info'}|${introPhase}|${current.status}`;
  $('lyrics').classList.toggle('unsynced', showLines && current.status === 'unsynced');
  $('lyrics').classList.toggle('info-mode', !showLines);
  if (key === renderedLyricKey) { if (showLines) syncLyrics(); return; }
  renderedLyricKey = key;
  lyricIndex = -2;
  $('lyric-info').hidden = Boolean(showLines);
  $('lyric-lines').hidden = !showLines;
  if (!showLines) {
    $('lyric-lines').replaceChildren();
    $('info-title').textContent = activeTrack.title;
    $('info-artist').textContent = [activeTrack.artist, activeTrack.album].filter(Boolean).join(' · ');
    const hints = { loading: '正在找歌词…', instrumental: '纯音乐，没有歌词', none: '这首歌暂时没有歌词', error: '歌词暂时没取到' };
    $('info-hint').textContent = introPhase ? 'Bob 正在介绍这首歌' : hints[current.status] || '';
    return;
  }
  $('lyric-lines').replaceChildren(...current.lines.map(line => {
    const item = node('li', 'lyric-line');
    item.append(node('span', 'lyric-text', line.text));
    if (line.translation) item.append(node('span', 'lyric-translation', line.translation));
    return item;
  }));
  $('lyric-lines').style.transform = '';
  $('lyrics').scrollTop = 0;
  syncLyrics();
}
function syncLyrics(force = false) {
  if (lyric.status !== 'synced' || lyric.trackId !== activeTrack?.id || $('lyric-lines').hidden) return;
  const position = (music.currentTime || 0) * 1000 + previewStartMs + 250;
  let index = -1;
  for (let i = 0; i < lyric.lines.length && lyric.lines[i].time <= position; i += 1) index = i;
  if (index === lyricIndex && !force) return;
  lyricIndex = index;
  const items = $('lyric-lines').children;
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle('current', i === index);
    items[i].classList.toggle('past', i < index);
  }
  // Keep the current line on the panel's optical centre; before the first line, show the opening lines.
  const target = items[Math.max(0, index)];
  if (!target) return;
  const box = $('lyrics').clientHeight;
  const offset = index < 0 ? 0 : Math.max(0, target.offsetTop + target.offsetHeight / 2 - box / 2);
  $('lyric-lines').style.transform = `translateY(${-offset}px)`;
}
function renderQuickReplies() {
  const container = $('quick-replies');
  const awaiting = queueFinished && Boolean(outro?.result?.tracks?.length);
  // Replies appear only when Bob is waiting for an answer, or before the first set.
  const options = awaiting ? ['好，接着放', '换点安静的', '来点更有劲的', '换个风格']
    : state.queue.length ? []
      : ['适合专注工作的歌', '深夜放松一下', '来点老派摇滚'];
  container.hidden = chatBusy;
  const key = options.join('|');
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.replaceChildren(...options.map((text, index) => {
    const button = node('button', `quick-reply${awaiting && index === 0 ? ' primary' : ''}`, text);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (chatBusy) return;
      $('chat-input').value = text;
      sendMessage();
    });
    return button;
  }));
}
function renderProgress(steps) {
  for (const item of $('thinking-steps').children) {
    const value = steps[item.dataset.step] || 'pending';
    item.hidden = value === 'skipped';
    item.classList.toggle('active', value === 'active');
    item.classList.toggle('done', value === 'done');
  }
}

async function sendMessage(event) {
  event?.preventDefault();
  const content = $('chat-input').value.trim();
  if (!content || chatBusy) return;
  chatBusy = true;
  renderAirStatus();
  const playerState = currentPlayerState();
  // A new request replaces Bob's end-of-set question; do not let it speak over the reply.
  if (queueFinished) { cancelSegment(); speechRequest += 1; speech.pause(); }
  const voiceRequest = speechRequest;
  pendingUser = { id: `pending-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString(), previousIds: new Set(state.messages.map(message => message.id)) };
  $('chat-input').value = '';
  $('send').disabled = true;
  renderProgress({ plan: 'active' });
  $('thinking').hidden = false;
  renderQuickReplies();
  $('chat-form').setAttribute('aria-busy', 'true');
  renderMessages();
  try {
    const result = await post('/api/chat', { message: content, playerState }, { timeout: 190000 });
    if (Array.isArray(result.queue)) state.queue = normalizeTracks(result.queue);
    if (result.message && !state.messages.some(message => message.id === result.message.id)) state.messages.push(result.message);
    try { applyState(await api('/api/state', { timeout: 15000 })); }
    catch {
      if (pendingUser) state.messages.splice(Math.max(0, state.messages.length - 1), 0, { ...pendingUser, previousIds: undefined });
    }
    pendingUser = null;
    renderMessages();
    renderQueue();
    updateTransport();
    if (result.control) {
      if (result.control.action === 'next') await moveTrack(1);
      else if (result.control.action === 'previous') await moveTrack(-1);
      else if (result.control.action === 'pause') pausePlayback();
      else if (result.control.action === 'play' && music.paused) await togglePlayback();
      else if (result.control.action === 'start-queue') { cancelSegment(); outro = null; await playTrack(state.queue[0]); }
    } else {
      const tracks = normalizeTracks(result.tracks);
      const speechUrl = autoVoice && voiceRequest === speechRequest ? result.speech?.url || result.message?.speechUrl : null;
      if (result.speech?.error) toast(`歌曲和文字已准备好；口播暂未生成：${result.speech.error}`);
      // Bob speaks first; the new set starts as soon as he finishes, replacing what was playing.
      if (tracks.length) await startSegment(tracks, speechUrl, result.message?.id);
      else if (speechUrl) {
        try { await playSpeech(speechUrl, result.message?.id); }
        catch (error) { toast(error.message); }
      }
    }
  } catch (error) {
    pendingUser = null;
    if (!$('chat-input').value) $('chat-input').value = content;
    renderMessages();
    toast(error.message);
  } finally {
    chatBusy = false;
    renderAirStatus();
    $('send').disabled = false;
    $('thinking').hidden = true;
    renderQuickReplies();
    $('chat-form').removeAttribute('aria-busy');
    $('chat-input').focus({ preventScroll: true });
  }
}

function selectLibraryTab(name) {
  setLibraryOpen(true);
  if (name === 'search') showingFavorites = false;
  for (const key of ['queue', 'search']) {
    const selected = name === key;
    $(`${key}-tab`).classList.toggle('active', selected);
    $(`${key}-tab`).setAttribute('aria-selected', String(selected));
    $(`${key}-tab`).tabIndex = selected ? 0 : -1;
    $(`${key}-panel`).hidden = !selected;
  }
  if (name === 'search') $('search-input').focus({ preventScroll: true });
  renderQueue();
}
async function searchMusic(event) {
  event.preventDefault();
  const query = $('search-input').value.trim();
  if (!query) { $('search-input').focus(); return; }
  const request = ++searchRequest;
  $('search-submit').disabled = true;
  $('search-status').textContent = '正在网易云曲库里找找…';
  $('search-results').replaceChildren();
  try {
    const data = await api(`/api/music/search?q=${encodeURIComponent(query)}`, { timeout: 40000 });
    if (request !== searchRequest) return;
    const tracks = normalizeTracks(data.tracks);
    $('search-status').textContent = tracks.length ? `找到 ${tracks.length} 首歌曲 · 点击播放，或加入待播队列` : '暂时没有找到，试试歌名或歌手名。';
    $('search-results').replaceChildren(...tracks.map((track, index) => makeTrackRow(track, index, 'search')));
  } catch (error) { if (request === searchRequest) $('search-status').textContent = error.message; }
  finally { if (request === searchRequest) $('search-submit').disabled = false; }
}

async function openTaste() {
  $('profile-dialog').close();
  $('taste-input').value = state.taste || '';
  $('taste-dialog').showModal();
  try {
    const result = await api('/api/taste', { timeout: 10000 });
    // Do not overwrite anything the user started typing during the request.
    if ($('taste-input').value === (state.taste || '')) $('taste-input').value = result.text || '';
    state.taste = result.text || '';
  } catch (error) { toast(error.message); }
}
async function saveTaste(event) {
  event.preventDefault();
  $('save-taste').disabled = true;
  try {
    const result = await api('/api/taste', { method: 'PUT', body: JSON.stringify({ text: $('taste-input').value }) });
    state.taste = result.text || '';
    $('taste-dialog').close();
    toast('记住了。Bob 之后会参考你的音乐品味。');
  } catch (error) { toast(error.message); }
  finally { $('save-taste').disabled = false; }
}

function stopQrPolling() {
  clearTimeout(qrTimer);
  qrGeneration += 1;
}
function renderLoggedIn() {
  $('qr-wrap').hidden = true;
  $('refresh-qr').hidden = true;
  $('logout').hidden = false;
  $('login-description').textContent = '你的网易云账号已连接。';
  $('login-status').textContent = services?.music?.nickname ? `你好，${services.music.nickname}。准备好听歌了。` : '已连接，准备好听歌了。';
}
async function openLogin() {
  if (services?.music?.loginEnabled === false) {
    toast(services.music.message || '暂不支持连接网易云账号。');
    return;
  }
  $('login-dialog').showModal();
  if (services?.music?.loggedIn) renderLoggedIn();
  else await beginQr();
}
async function beginQr() {
  stopQrPolling();
  const generation = qrGeneration;
  $('qr-wrap').hidden = false;
  $('qr-image').hidden = true;
  $('qr-placeholder').hidden = false;
  $('qr-placeholder').textContent = '正在准备二维码…';
  $('refresh-qr').hidden = true;
  $('logout').hidden = true;
  $('login-description').textContent = '用网易云音乐 App 扫码，连接你的收听权限。';
  $('login-status').textContent = '连接后，歌曲会按照你的账号权限播放。';
  try {
    const result = await api('/api/login/qr', { timeout: 30000 });
    if (generation !== qrGeneration || !$('login-dialog').open) return;
    const source = safeUrl(result.image, true);
    if (!result.key || !source) throw new Error('暂时无法生成二维码，请稍后再试。');
    $('qr-image').src = source;
    $('qr-image').hidden = false;
    $('qr-placeholder').hidden = true;
    $('login-status').textContent = '打开网易云音乐 App，扫描上方二维码。';
    qrTimer = setTimeout(() => checkQr(result.key, generation), 2500);
  } catch (error) {
    if (generation !== qrGeneration) return;
    $('qr-placeholder').textContent = '二维码暂未生成';
    $('login-status').textContent = error.message;
    $('refresh-qr').hidden = false;
  }
}
async function checkQr(key, generation) {
  if (generation !== qrGeneration || !$('login-dialog').open || qrCheckingGeneration === generation) return;
  qrCheckingGeneration = generation;
  try {
    const result = await api(`/api/login/check?key=${encodeURIComponent(key)}`, { timeout: 15000 });
    if (generation !== qrGeneration || !$('login-dialog').open) return;
    if (result.status === 'authorized') {
      stopQrPolling();
      const authorizedGeneration = qrGeneration;
      await refreshStatus();
      if (authorizedGeneration !== qrGeneration || !$('login-dialog').open) return;
      if (services?.music?.loggedIn) {
        void refreshFavorites();
        renderLoggedIn();
        toast('网易云已连接，可以开始听歌了。');
      } else {
        $('login-status').textContent = '已收到授权，账号状态暂未确认。请关闭后重新检查连接。';
        $('refresh-qr').hidden = false;
      }
      return;
    }
    if (result.status === 'expired') {
      $('qr-image').hidden = true;
      $('qr-placeholder').hidden = false;
      $('qr-placeholder').textContent = '二维码已过期';
      $('login-status').textContent = '重新生成二维码后再扫一扫。';
      $('refresh-qr').hidden = false;
      return;
    }
    $('login-status').textContent = result.status === 'scanned' ? '扫描成功，请在网易云 App 中确认登录。' : '等待扫码，连接你的网易云音乐。';
    qrTimer = setTimeout(() => checkQr(key, generation), 2500);
  } catch (error) {
    if (generation !== qrGeneration) return;
    $('login-status').textContent = error.message;
    $('refresh-qr').hidden = false;
  } finally { if (qrCheckingGeneration === generation) qrCheckingGeneration = null; }
}
async function logout() {
  $('logout').disabled = true;
  try {
    stopQrPolling();
    await post('/api/logout', {});
    if (services?.music) { services.music.loggedIn = false; delete services.music.nickname; }
    renderStatus();
    void refreshFavorites();
    $('login-dialog').close();
    toast('已退出网易云账号。');
  } catch (error) { toast(error.message); }
  finally { $('logout').disabled = false; }
}

music.addEventListener('play', () => { updateTransport(); renderQueue(); reportPlayer('play'); });
music.addEventListener('pause', () => { updateTransport(); renderQueue(); if (!music.ended && !loadingTrack) reportPlayer('pause'); });
music.addEventListener('ended', async () => {
  const request = musicRequest;
  await reportPlayer('ended');
  if (request === musicRequest) await moveTrack(1, true);
});
music.addEventListener('loadedmetadata', () => {
  $('duration').textContent = formatTime(music.duration);
  $('seek').disabled = !Number.isFinite(music.duration) || music.duration <= 0;
});
music.addEventListener('timeupdate', () => {
  $('elapsed').textContent = formatTime(music.currentTime);
  syncLyrics();
  // Let Bob prepare his wrap-up while the last song of the set is still playing.
  if (activeTrack && state.queue.at(-1)?.id === activeTrack.id && Number.isFinite(music.duration)
    && music.duration - music.currentTime <= OUTRO_LEAD_SECONDS && !music.paused) requestOutro();
  if (Number.isFinite(music.duration) && music.duration > 0) {
    const progress = (music.currentTime / music.duration) * 1000;
    $('seek').value = progress;
    $('seek').style.background = `linear-gradient(to right, var(--text) ${progress / 10}%, color-mix(in srgb, var(--muted) 50%, transparent) ${progress / 10}%)`;
    $('seek').setAttribute('aria-valuetext', `${formatTime(music.currentTime)}，共 ${formatTime(music.duration)}`);
  }
});
music.addEventListener('error', () => {
  if (!music.getAttribute('src')) return;
  loadingTrack = false;
  setNotice('这首歌的播放地址暂不可用，或当前账号没有完整播放权限。请换一首，或连接网易云后重试。');
  updateTransport();
});
for (const event of ['play', 'pause', 'ended']) speech.addEventListener(event, updateSpeechState);
speech.addEventListener('timeupdate', syncKaraoke);
speech.addEventListener('error', () => { speech.pause(); updateSpeechState(); if (speech.getAttribute('src')) toast('口播音频加载失败，可以点击“听 Bob 说”重试。'); });
$('play').addEventListener('click', togglePlayback);
$('favorite').addEventListener('click', toggleFavorite);
$('hide-queue').addEventListener('click', () => setLibraryOpen(false));
$('library-button').addEventListener('click', () => { if (libraryOpen) setLibraryOpen(false); else selectLibraryTab('queue'); });
$('history-toggle').addEventListener('click', () => {
  historyOpen = !historyOpen;
  renderMessages();
  // After renderMessages' own scroll-to-latest, so the opened history is in view.
  if (historyOpen) requestAnimationFrame(() => { $('conversation-scroll').scrollTop = 0; });
});
$('show-favorites').addEventListener('click', () => {
  showingFavorites = !showingFavorites;
  selectLibraryTab('queue');
  if (showingFavorites && favoriteSource === 'netease' && remoteFavoritesState !== 'loading') void refreshFavorites();
});
$('theme-toggle').addEventListener('click', toggleTheme);

function createProfileDots(dialog) {
  const canvas = node('canvas', 'profile-dot-field');
  const context = canvas.getContext('2d');
  if (!context) return { start() {} };
  canvas.setAttribute('aria-hidden', 'true');
  dialog.prepend(canvas);
  dialog.classList.add('has-interactive-dots');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = {
    x: 0, y: 0, targetX: 0, targetY: 0,
    amount: 0, targetAmount: 0, lift: 0, targetLift: 0, movedAt: 0,
  };
  let active = false;
  let frame = 0;
  let previousTime = 0;
  let width = 0;
  let height = 0;
  let gap = 18;
  let base = [135, 147, 143];
  let highlight = [99, 216, 191];
  let lastPointer = null;

  function readColors() {
    const style = getComputedStyle(dialog);
    base = style.getPropertyValue('--profile-dot-base').trim().split(',').map(Number);
    highlight = style.getPropertyValue('--profile-dot-highlight').trim().split(',').map(Number);
    gap = parseFloat(style.getPropertyValue('--profile-dot-gap')) || 18;
  }
  function draw() {
    context.clearRect(0, 0, width, height);
    const influence = Math.min(180, width * 0.4);
    const cols = Math.floor(width / gap);
    const rows = Math.floor(height / gap);
    const startX = (width - cols * gap) / 2;
    const startY = (height - rows * gap) / 2;
    for (let row = 0; row <= rows; row++) {
      const y = startY + row * gap;
      for (let col = 0; col <= cols; col++) {
        const x = startX + col * gap;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const t = Math.max(0, 1 - distance / influence);
        const falloff = t * t * (3 - 2 * t);
        const strength = falloff * pointer.amount;
        const lift = falloff * pointer.lift;
        const radius = 1.15 + 1.2 * lift;
        const blend = Math.pow(strength, 0.65);
        const color = base.map((value, channel) => Math.round(value + (highlight[channel] - value) * blend));
        if (lift > 0.001) {
          context.fillStyle = `rgba(${highlight.join(',')},${lift * 0.065})`;
          context.beginPath();
          context.arc(x, y, radius * 1.7, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = `rgba(${color.join(',')},${0.16 + 0.64 * strength})`;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  function tick(time) {
    frame = 0;
    if (!active || !dialog.open || document.hidden) { previousTime = 0; return; }
    const elapsed = previousTime ? Math.min(50, time - previousTime) : 16.67;
    previousTime = time;
    // Keep the color under a resting pointer; only the lift relaxes after movement.
    if (time - pointer.movedAt >= 150) pointer.targetLift = 0;
    const positionEase = 1 - Math.exp(-elapsed / 48);
    const strengthEase = 1 - Math.exp(-elapsed / 75);
    const liftEase = 1 - Math.exp(-elapsed / (pointer.targetLift > pointer.lift ? 90 : 180));
    pointer.x += (pointer.targetX - pointer.x) * positionEase;
    pointer.y += (pointer.targetY - pointer.y) * positionEase;
    pointer.amount += (pointer.targetAmount - pointer.amount) * strengthEase;
    pointer.lift += (pointer.targetLift - pointer.lift) * liftEase;
    const settled = Math.abs(pointer.amount - pointer.targetAmount) < 0.001 &&
      Math.abs(pointer.lift - pointer.targetLift) < 0.001 && pointer.targetLift === 0 &&
      Math.abs(pointer.x - pointer.targetX) + Math.abs(pointer.y - pointer.targetY) < 0.05;
    if (settled) {
      pointer.x = pointer.targetX;
      pointer.y = pointer.targetY;
      pointer.amount = pointer.targetAmount;
      pointer.lift = pointer.targetLift;
      previousTime = 0;
    }
    draw();
    if (!settled) frame = requestAnimationFrame(tick);
  }
  function wake() {
    if (active && dialog.open && !document.hidden && !frame) frame = requestAnimationFrame(tick);
  }
  function release() {
    lastPointer = null;
    pointer.targetAmount = 0;
    pointer.targetLift = 0;
    wake();
  }
  function projectPointer() {
    if (!lastPointer) return;
    const box = dialog.getBoundingClientRect();
    const x = lastPointer.x - box.left - dialog.clientLeft;
    const y = lastPointer.y - box.top - dialog.clientTop;
    if (x < 0 || x > dialog.clientWidth || y < 0 || y > dialog.clientHeight) { release(); return; }
    const contentY = y + dialog.scrollTop;
    if (pointer.targetAmount === 0 && pointer.amount < 0.01) {
      pointer.x = x;
      pointer.y = contentY;
    }
    pointer.targetX = x;
    pointer.targetY = contentY;
    pointer.targetAmount = 1;
    wake();
  }
  function resize() {
    if (!active || !dialog.open) return;
    const scrollTop = dialog.scrollTop;
    // Ignore the previous canvas size when measuring scrollable content.
    canvas.style.height = '0px';
    width = dialog.clientWidth;
    height = Math.max(dialog.clientHeight, dialog.scrollHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    dialog.scrollTop = scrollTop;
    readColors();
    projectPointer();
    draw();
  }
  function stop() {
    active = false;
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    lastPointer = null;
    pointer.amount = pointer.targetAmount = 0;
    pointer.lift = pointer.targetLift = pointer.movedAt = 0;
  }
  dialog.addEventListener('pointermove', event => {
    if (!active || reducedMotion.matches || event.pointerType !== 'mouse') return;
    const previousPointer = lastPointer;
    lastPointer = { x: event.clientX, y: event.clientY };
    projectPointer();
    if (lastPointer && (!previousPointer || Math.hypot(lastPointer.x - previousPointer.x, lastPointer.y - previousPointer.y) > 0.25)) {
      pointer.movedAt = performance.now();
      pointer.targetLift = 1;
      wake();
    }
  }, { passive: true });
  dialog.addEventListener('pointerleave', release, { passive: true });
  dialog.addEventListener('pointercancel', release, { passive: true });
  dialog.addEventListener('scroll', projectPointer, { passive: true });
  dialog.addEventListener('close', stop);
  window.addEventListener('blur', release);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', event => {
    if (event.persisted && dialog.open) { active = true; resize(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      lastPointer = null;
      pointer.amount = pointer.targetAmount = 0;
      pointer.lift = pointer.targetLift = pointer.movedAt = 0;
    } else if (active) draw();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      lastPointer = null;
      pointer.amount = pointer.targetAmount = 0;
      pointer.lift = pointer.targetLift = pointer.movedAt = 0;
      if (active) draw();
    }
  });
  new ResizeObserver(resize).observe(dialog);
  new MutationObserver(() => { if (active) { readColors(); draw(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return {
    start() {
      stop();
      active = true;
      resize();
    },
  };
}
const profileDots = createProfileDots($('profile-dialog'));
for (const button of document.querySelectorAll('.profile-open')) button.addEventListener('click', () => {
  const tags = [...new Set(state.taste.split(/[\n,，、;；]/).map(item => item.replace(/^[\s#*\-\d.]+/, '').trim()).filter(item => item && item.length <= 24))].slice(0, 9);
  $('profile-genres').textContent = tags.length || '—';
  $('profile-genres-tags').replaceChildren(...(tags.length ? tags.map(tag => node('span', 'genre-tag', tag)) : [node('span', 'profile-empty-taste', '还没有品味资料，告诉 Bob 你喜欢什么。')]));
  $('profile-dialog').showModal();
  profileDots.start();
});
$('next').addEventListener('click', () => moveTrack(1));
$('seek').addEventListener('input', () => { if (Number.isFinite(music.duration)) { music.currentTime = (Number($('seek').value) / 1000) * music.duration; syncLyrics(); } });
new ResizeObserver(() => syncLyrics(true)).observe($('lyrics'));
$('auto-voice').addEventListener('change', () => { autoVoice = $('auto-voice').checked; savePreference('radio-bob-auto-voice', autoVoice); if (!autoVoice) speech.pause(); });
$('chat-form').addEventListener('submit', sendMessage);
$('chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
$('queue-tab').addEventListener('click', () => {
  showingFavorites = false;
  if (libraryOpen && !$('queue-panel').hidden) setLibraryOpen(false);
  else selectLibraryTab('queue');
  renderQueue();
});
$('search-tab').addEventListener('click', () => selectLibraryTab('search'));
document.querySelector('.library-tabs').addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? 'queue' : event.key === 'End' ? 'search' : $('queue-tab').getAttribute('aria-selected') === 'true' ? 'search' : 'queue'; selectLibraryTab(target); $(`${target}-tab`).focus(); } });
$('search-form').addEventListener('submit', searchMusic);
document.querySelectorAll('.taste-open').forEach(button => button.addEventListener('click', openTaste));
$('taste-form').addEventListener('submit', saveTaste);
document.querySelectorAll('.account-open').forEach(button => button.addEventListener('click', () => { if ($('profile-dialog').open) $('profile-dialog').close(); openLogin(); }));
$('refresh-qr').addEventListener('click', beginQr);
$('logout').addEventListener('click', logout);
$('login-dialog').addEventListener('close', stopQrPolling);
$('refresh-status').addEventListener('click', () => refreshStatus(true));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
}

if ('mediaSession' in navigator) {
  for (const [action, handler] of [
    ['play', togglePlayback], ['pause', pausePlayback],
    ['previoustrack', () => moveTrack(-1)], ['nexttrack', () => moveTrack(1)],
    ['seekto', details => { if (Number.isFinite(details.seekTime)) music.currentTime = details.seekTime; }],
  ]) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Optional platform control. */ } }
}

// On-air bars. They are drawn, not measured: the songs stream from another origin,
// so the page cannot read their audio. Their shape follows who is on air.
const barsCanvas = $('bars');
const barsContext = barsCanvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const SHEET_OVERLAP = 40;
let barsMode = 'idle';
let barsFrame = 0;
let barsTick = 0;
let barHeights = [];
let barTargets = [];
function setBarsMode(mode) {
  barsMode = mode;
  if (!barsFrame) barsFrame = requestAnimationFrame(drawBars);
}
function resizeBars() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  barsCanvas.width = Math.round(barsCanvas.clientWidth * ratio);
  barsCanvas.height = Math.round(barsCanvas.clientHeight * ratio);
  barsContext?.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!barsFrame) barsFrame = requestAnimationFrame(drawBars);
}
function barTarget(i, count, t) {
  if (barsMode === 'speech') {
    const phrase = 0.25 + 0.75 * Math.pow(Math.abs(Math.sin(i / 9 + t * 0.9)), 0.8);
    return phrase * (0.45 + 0.55 * Math.abs(Math.sin(i * 2.3 + t * 9) * Math.cos(i * 0.71 - t * 4)));
  }
  if (barsMode === 'music') {
    const tilt = 0.95 - 0.55 * (i / Math.max(1, count - 1));
    const beat = 0.75 + 0.25 * Math.abs(Math.sin(t * 4.4));
    return tilt * beat * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.9 + t * 11) * Math.sin(i * 0.43 + t * 6 + 1)));
  }
  return 0.03 + 0.02 * Math.abs(Math.sin(i * 0.9));
}
function drawBars(now) {
  barsFrame = 0;
  const width = barsCanvas.clientWidth;
  const height = barsCanvas.clientHeight;
  if (!barsContext || !width || !height) return;
  const step = 7;
  const barWidth = 3;
  const count = Math.max(8, Math.floor((width - 24) / step));
  const left = (width - (count * step - (step - barWidth))) / 2;
  const usable = Math.max(10, height - SHEET_OVERLAP - 6);
  if (barHeights.length !== count) { barHeights = Array(count).fill(0.03); barTargets = Array(count).fill(0.03); }
  const still = reducedMotion.matches || document.hidden;
  if (still || now - barsTick > 95) {
    barsTick = now;
    for (let i = 0; i < count; i += 1) {
      barTargets[i] = still && barsMode !== 'idle' ? 0.2 + 0.5 * Math.abs(Math.sin(i / 7)) : barTarget(i, count, now / 1000);
    }
  }
  let moving = false;
  barsContext.clearRect(0, 0, width, height);
  barsContext.fillStyle = '#f2f2f4';
  for (let i = 0; i < count; i += 1) {
    const delta = barTargets[i] - barHeights[i];
    barHeights[i] += still ? delta : delta * 0.28;
    if (Math.abs(delta) > 0.002) moving = true;
    const visible = Math.max(3, barHeights[i] * usable);
    barsContext.fillRect(left + i * step, height - SHEET_OVERLAP - visible, barWidth, visible + SHEET_OVERLAP);
  }
  if (!still && (barsMode !== 'idle' || moving)) barsFrame = requestAnimationFrame(drawBars);
}
new ResizeObserver(resizeBars).observe(barsCanvas);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !barsFrame) barsFrame = requestAnimationFrame(drawBars); });

async function start() {
  applyTheme();
  setLibraryOpen(false);
  updateClock();
  setInterval(updateClock, 10000);
  renderStatus();
  const savedVolume = Number(readPreference('radio-bob-volume', '0.7'));
  userVolume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 0.7;
  updateMusicVolume();
  await Promise.allSettled([
    refreshStatus(),
    api('/api/state', { timeout: 15000 }).then(applyState).catch(error => toast(error.message)),
  ]);
  if ('EventSource' in window) {
    const events = new EventSource('/api/events');
    eventsStarted = true;
    events.addEventListener('state', event => {
      try { applyState(JSON.parse(event.data)); } catch { /* Ignore malformed transient event. */ }
    });
    events.addEventListener('progress', event => {
      if (!chatBusy) return;
      try { renderProgress(JSON.parse(event.data)); } catch { /* Ignore malformed transient event. */ }
    });
    events.addEventListener('open', () => {
      document.body.classList.add('connected');
      renderAirStatus();
    });
    events.addEventListener('error', () => {
      document.body.classList.remove('connected');
      renderAirStatus();
    });
    window.addEventListener('pagehide', () => { events.close(); stopQrPolling(); }, { once: true });
  }
}
start();
