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
let qrChecking = false;
let lastStateFingerprint = '';
let favorites = [];
let showingFavorites = false;
let libraryOpen = false;
let chatScrollBeforeLibrary = 0;

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
  $('weekday').textContent = now.toLocaleDateString('en-US', { weekday: 'long' });
  $('calendar-date').textContent = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase().replaceAll(' ', '·');
}

function setTheme(theme) {
  theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  savePreference('radio-bob-theme', theme);
  for (const value of ['dark', 'light']) $(`theme-${value}`).setAttribute('aria-pressed', String(theme === value));
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#050507' : '#f3f3f3';
}

function setLibraryOpen(open) {
  const scroll = $('conversation-scroll');
  if (open && !libraryOpen) chatScrollBeforeLibrary = scroll.scrollTop;
  const wasOpen = libraryOpen;
  libraryOpen = open;
  $('library-body').hidden = !open;
  $('hide-queue').textContent = open ? 'HIDE' : 'SHOW';
  $('hide-queue').setAttribute('aria-expanded', String(open));
  $('queue-tab').setAttribute('aria-expanded', String(open));
  if (open || wasOpen) scroll.scrollTo({ top: open ? 0 : chatScrollBeforeLibrary, behavior: 'instant' });
}

function renderFavorite() {
  const saved = Boolean(activeTrack && favorites.some(track => track.id === activeTrack.id));
  $('favorite').disabled = !activeTrack;
  $('favorite').classList.toggle('saved', saved);
  $('favorite').setAttribute('aria-pressed', String(saved));
  $('favorite').setAttribute('aria-label', saved ? '取消收藏当前歌曲' : '收藏当前歌曲');
}

function toggleFavorite() {
  if (!activeTrack) return;
  const exists = favorites.some(track => track.id === activeTrack.id);
  favorites = exists ? favorites.filter(track => track.id !== activeTrack.id) : [...favorites, activeTrack];
  savePreference('radio-bob-favorites', JSON.stringify(favorites));
  renderFavorite();
  if (showingFavorites) renderQueue();
  toast(exists ? '已从收藏中移除。' : '已收藏，点击 FAV 查看。');
}

function renderStatus() {
  for (const [key, label] of [['claude', 'AI'], ['fish', 'Voice'], ['music', 'Music']]) {
    const item = $(`${key}-status`);
    const service = services?.[key];
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
  if (speech.paused) $('voice-label').textContent = services && !services.fish?.ready ? '口播尚未就绪' : 'DJ 口播';
}
async function refreshStatus(showFeedback = false) {
  $('refresh-status').disabled = true;
  try {
    const data = await api('/api/status', { timeout: 30000 });
    services = data.services || {};
    renderStatus();
    if (showFeedback) {
      const missing = [['claude', 'AI'], ['fish', '语音'], ['music', '音乐']].filter(([key]) => !services[key]?.ready).map(([, label]) => label);
      toast(missing.length ? `${missing.join('、')}尚未就绪，请检查本地配置。` : 'AI 配置、语音和音乐服务均已就绪。');
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
  const tracks = showingFavorites ? favorites : state.queue;
  $('queue-count').textContent = tracks.length;
  $('queue-tab').textContent = showingFavorites ? 'FAVORITES' : 'QUEUE';
  $('queue-empty').firstElementChild.textContent = showingFavorites ? '还没有收藏。播放喜欢的歌时，点击爱心保存。' : '队列还空着。告诉 Bob 你想听什么，或自己找一首。';
  $('queue-empty').hidden = tracks.length > 0;
  $('queue-list').replaceChildren(...tracks.map((track, index) => makeTrackRow(track, index)));
  $('show-favorites').setAttribute('aria-pressed', String(showingFavorites));
  $('show-favorites').classList.toggle('active', showingFavorites);
}
function renderMessages() {
  const fingerprint = JSON.stringify([state.messages, pendingUser?.id]);
  if (fingerprint === lastStateFingerprint) return;
  lastStateFingerprint = fingerprint;
  const container = $('messages');
  const scroll = $('conversation-scroll');
  const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const empty = $('chat-empty');
  for (const child of [...container.children]) if (child !== empty) child.remove();
  empty.hidden = state.messages.length > 0 || Boolean(pendingUser);
  const messages = [...state.messages];
  if (pendingUser) messages.push(pendingUser);
  for (const message of messages) {
    const isUser = message.role === 'user';
    const article = node('article', `message ${isUser ? 'user' : 'assistant'}${message === pendingUser ? ' pending' : ''}`);
    const avatar = isUser ? icon('user') : node('img');
    avatar.classList.add('message-avatar');
    if (!isUser) { avatar.src = '/assets/bob-avatar.svg'; avatar.alt = 'Bob 的像素头像'; }
    const messageBody = node('div', 'message-body');
    const head = node('div', 'message-head');
    const stamp = node('time', '', timeLabel(message.createdAt));
    head.append(node('strong', '', isUser ? 'YOU' : 'RADIO BOB'));
    const footer = node('div', 'message-footer');
    footer.append(stamp);
    messageBody.append(head, node('div', 'message-content', message.content || ''));
    if (!isUser && message.content) {
      const button = node('button', 'speech-button');
      button.type = 'button';
      button.setAttribute('aria-label', '听 Bob 说');
      button.append(icon('play'), node('span', '', 'REPLAY'));
      button.addEventListener('click', async () => {
        button.disabled = true;
        const request = speechRequest;
        try {
          const url = safeUrl(message.speechUrl);
          if (url) await playSpeech(url);
          else {
            const result = await post('/api/tts', { text: message.content, messageId: message.id });
            if (request === speechRequest) await playSpeech(result.url);
          }
        } catch (error) { toast(error.message); }
        finally { button.disabled = false; }
      });
      footer.append(button);
    }
    const tracks = normalizeTracks(message.tracks);
    if (tracks.length) {
      const list = node('details', 'message-tracks');
      list.append(node('summary', '', `${tracks.length} ${tracks.length === 1 ? 'TRACK' : 'TRACKS'}`));
      const rows = node('div', 'message-track-list');
      rows.append(...tracks.map((track, index) => makeTrackRow(track, index, 'message')));
      list.append(rows);
      footer.append(list);
    }
    messageBody.append(footer);
    article.append(avatar, messageBody);
    container.append(article);
  }
  if (wasNearBottom || pendingUser) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
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
  $('current-title').textContent = activeTrack?.title || 'No track selected';
  $('current-artist').textContent = activeTrack?.artist || '';
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
  $('previous').disabled = !hasTrack || loadingTrack;
  $('next').disabled = !hasTrack || loadingTrack;
  const playing = !music.paused && !music.ended;
  const speaking = !speech.paused && !speech.ended;
  $('play-icon').setAttribute('href', playing ? '/assets/icons.svg#i-pause' : '/assets/icons.svg#i-play');
  $('play').setAttribute('aria-label', playing ? '暂停' : '播放');
  document.querySelector('.player-panel').classList.toggle('is-playing', playing);
  $('air-status').classList.toggle('live', playing || speaking);
  $('air-label').textContent = playing || speaking ? 'ON AIR' : 'STANDBY';
  $('playback-label').textContent = loadingTrack ? 'LOADING' : playing ? 'PLAYING' : activeTrack ? 'PAUSED' : 'STANDBY';
  $('stop').disabled = false;
  $('profile-air').textContent = playing || speaking ? 'LIVE' : 'IDLE';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : activeTrack ? 'paused' : 'none';
}
function updateMusicVolume() {
  music.volume = Math.min(1, Math.max(0, userVolume * (!speech.paused && !speech.ended ? 0.22 : 1)));
}
async function reportPlayer(action) {
  if (!activeTrack) return;
  try { await post('/api/player', { action, trackId: activeTrack.id, positionMs: Math.round((music.currentTime || 0) * 1000) }); }
  catch { /* A reporting failure must not interrupt audio. */ }
}
async function playTrack(track) {
  if (!track) return;
  const request = ++musicRequest;
  loadingTrack = true;
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
  renderNowPlaying();
  renderQueue();
  updateTransport();
  try {
    const result = await api(`/api/music/url/${encodeURIComponent(track.id)}`, { timeout: 40000 });
    if (request !== musicRequest) return;
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
  loadingTrack = false;
  music.pause();
  speech.pause();
  updateTransport();
}
async function moveTrack(direction, ended = false) {
  if (!state.queue.length) return;
  const request = musicRequest;
  if (direction < 0 && music.currentTime > 3) { music.currentTime = 0; return; }
  const index = state.queue.findIndex(track => track.id === activeTrack?.id);
  let next = index === -1 ? (direction > 0 ? 0 : state.queue.length - 1) : index + direction;
  if (ended && next >= state.queue.length) {
    setNotice('这一轮听完了。和 Bob 再聊聊，续上下一段音乐。');
    updateTransport();
    return;
  }
  next = (next + state.queue.length) % state.queue.length;
  // Keep the user's chosen target stable if an SSE update replaces the queue.
  const target = state.queue[next];
  if (!ended) await reportPlayer('skip');
  if (request !== musicRequest) return;
  await playTrack(target);
}
async function playSpeech(url) {
  const source = safeUrl(url);
  if (!source) throw new Error('这段口播暂时无法播放，可以稍后重试。');
  const request = ++speechRequest;
  speech.pause();
  speech.src = source;
  try { await speech.play(); }
  catch (error) {
    if (request !== speechRequest) return;
    if (error.name === 'NotAllowedError') toast('口播已生成，点击消息下方的“听 Bob 说”即可播放。');
    else throw new Error('口播音频未能播放，请稍后重试。');
  }
}
function updateSpeechState() {
  const playing = !speech.paused && !speech.ended;
  $('dj-wave').classList.toggle('speaking', playing);
  $('voice-label').textContent = playing ? 'Bob 正在说话…' : services && !services.fish?.ready ? '口播尚未就绪' : 'DJ 口播';
  updateMusicVolume();
  updateTransport();
}

async function sendMessage(event) {
  event?.preventDefault();
  const content = $('chat-input').value.trim();
  if (!content || chatBusy) return;
  chatBusy = true;
  const playbackRequest = musicRequest;
  const voiceRequest = speechRequest;
  pendingUser = { id: `pending-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString(), previousIds: new Set(state.messages.map(message => message.id)) };
  $('chat-input').value = '';
  $('send').disabled = true;
  $('thinking').hidden = false;
  $('chat-form').setAttribute('aria-busy', 'true');
  renderMessages();
  try {
    const result = await post('/api/chat', { message: content }, { timeout: 190000 });
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
    } else {
      const tracks = normalizeTracks(result.tracks);
      if (tracks.length && music.paused && playbackRequest === musicRequest) await playTrack(tracks[0]);
      if (autoVoice && voiceRequest === speechRequest && (result.speech?.url || result.message?.speechUrl)) {
        try { await playSpeech(result.speech?.url || result.message.speechUrl); }
        catch (error) { toast(error.message); }
      }
      if (result.speech?.error) toast(`歌曲和文字已准备好；口播暂未生成：${result.speech.error}`);
    }
  } catch (error) {
    pendingUser = null;
    if (!$('chat-input').value) $('chat-input').value = content;
    renderMessages();
    toast(error.message);
  } finally {
    chatBusy = false;
    $('send').disabled = false;
    $('thinking').hidden = true;
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
  if (generation !== qrGeneration || !$('login-dialog').open || qrChecking) return;
  qrChecking = true;
  try {
    const result = await api(`/api/login/check?key=${encodeURIComponent(key)}`, { timeout: 15000 });
    if (generation !== qrGeneration || !$('login-dialog').open) return;
    if (result.status === 'authorized') {
      stopQrPolling();
      await refreshStatus();
      if (services?.music?.loggedIn) {
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
  } finally { qrChecking = false; }
}
async function logout() {
  $('logout').disabled = true;
  try {
    await post('/api/logout', {});
    if (services?.music) { services.music.loggedIn = false; delete services.music.nickname; }
    renderStatus();
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
speech.addEventListener('error', () => { speech.pause(); updateSpeechState(); if (speech.getAttribute('src')) toast('口播音频加载失败，可以点击“听 Bob 说”重试。'); });
$('play').addEventListener('click', togglePlayback);
$('stop').addEventListener('click', () => { pausePlayback(); if (music.src) music.currentTime = 0; if (speech.src) speech.currentTime = 0; });
$('favorite').addEventListener('click', toggleFavorite);
$('hide-queue').addEventListener('click', () => setLibraryOpen(!libraryOpen));
$('show-favorites').addEventListener('click', () => { showingFavorites = !showingFavorites; selectLibraryTab('queue'); });
$('theme-dark').addEventListener('click', () => setTheme('dark'));
$('theme-light').addEventListener('click', () => setTheme('light'));
$('mic').addEventListener('click', () => toast('语音输入暂未接入，请在输入框告诉 Bob 你想听什么。'));

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
$('previous').addEventListener('click', () => moveTrack(-1));
$('next').addEventListener('click', () => moveTrack(1));
$('seek').addEventListener('input', () => { if (Number.isFinite(music.duration)) music.currentTime = (Number($('seek').value) / 1000) * music.duration; });
$('volume').addEventListener('input', () => { userVolume = Number($('volume').value); savePreference('radio-bob-volume', userVolume); updateMusicVolume(); });
$('auto-voice').addEventListener('change', () => { autoVoice = $('auto-voice').checked; savePreference('radio-bob-auto-voice', autoVoice); if (!autoVoice) speech.pause(); });
$('chat-form').addEventListener('submit', sendMessage);
$('chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('chat-input').value = button.dataset.prompt; $('chat-input').focus(); }));
$('queue-tab').addEventListener('click', () => {
  showingFavorites = false;
  if (libraryOpen && !$('queue-panel').hidden) setLibraryOpen(false);
  else selectLibraryTab('queue');
  renderQueue();
});
$('search-tab').addEventListener('click', () => selectLibraryTab('search'));
$('empty-search').addEventListener('click', () => selectLibraryTab('search'));
document.querySelector('.library-tabs').addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? 'queue' : event.key === 'End' ? 'search' : $('queue-tab').getAttribute('aria-selected') === 'true' ? 'search' : 'queue'; selectLibraryTab(target); $(`${target}-tab`).focus(); } });
$('search-form').addEventListener('submit', searchMusic);
document.querySelectorAll('.taste-open').forEach(button => button.addEventListener('click', openTaste));
$('taste-form').addEventListener('submit', saveTaste);
$('account-button').addEventListener('click', openLogin);
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

async function start() {
  setTheme(readPreference('radio-bob-theme', 'dark'));
  setLibraryOpen(false);
  updateClock();
  setInterval(updateClock, 10000);
  renderStatus();
  const savedVolume = Number(readPreference('radio-bob-volume', '0.7'));
  userVolume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 0.7;
  $('volume').value = userVolume;
  updateMusicVolume();
  await Promise.allSettled([
    refreshStatus(),
    api('/api/state', { timeout: 15000 }).then(applyState).catch(error => toast(error.message)),
  ]);
  if ('EventSource' in window) {
    const events = new EventSource('/api/events');
    events.addEventListener('state', event => {
      try { applyState(JSON.parse(event.data)); } catch { /* Ignore malformed transient event. */ }
    });
    events.addEventListener('open', () => {
      document.body.classList.add('connected');
      $('connection-label').textContent = 'CONNECTED.';
      $('chat-connection').textContent = 'Connected to Radio Bob server';
      $('dj-live-label').textContent = 'LIVE';
    });
    events.addEventListener('error', () => {
      document.body.classList.remove('connected');
      $('connection-label').textContent = 'RECONNECTING.';
      $('chat-connection').textContent = 'Reconnecting to Radio Bob server…';
      $('dj-live-label').textContent = 'OFFLINE';
    });
    window.addEventListener('pagehide', () => { events.close(); stopQrPolling(); }, { once: true });
  }
}
start();
