import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DJS, publicDjs } from './djs.mjs';

export function createStore(root, { dataDir = join(root, '.data'), profileDir = join(root, 'user'), djs = DEFAULT_DJS } = {}) {
  if (!Array.isArray(djs) || !djs.length || djs.some(dj => !dj || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dj.id))
    || new Set(djs.map(dj => dj.id)).size !== djs.length) throw new Error('DJ 配置需要唯一且有效的 ID。');
  const definitions = new Map(djs.map(dj => [dj.id, dj]));
  const availableDjs = publicDjs(djs);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const dbPath = join(dataDir, 'state.db');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, tracks_json TEXT NOT NULL, speech_url TEXT);
    CREATE TABLE IF NOT EXISTS plays (id TEXT PRIMARY KEY, track_id TEXT, title TEXT, artist TEXT, action TEXT, played_at TEXT, position_ms INTEGER);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, created_at TEXT, reason TEXT, segue TEXT, tracks_json TEXT);
  `);
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'note')) db.exec('ALTER TABLE messages ADD COLUMN note TEXT');
  // All pre-existing data belongs to Bob. Keep it when DJs are added or removed.
  for (const table of ['messages', 'plays', 'plans']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'dj_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN dj_id TEXT NOT NULL DEFAULT 'bob'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_dj_id ON ${table}(dj_id)`);
  }
  const scopedKeys = new Set(['queue', 'nowPlayingId', 'lastPlan']);
  for (const key of scopedKeys) {
    db.prepare('INSERT OR IGNORE INTO settings(key,value) SELECT ?,value FROM settings WHERE key=?').run(`dj:bob:${key}`, key);
  }
  mkdirSync(profileDir, { recursive: true });
  const tastePath = join(profileDir, 'taste.md');
  if (!existsSync(tastePath)) writeFileSync(tastePath, '', { mode: 0o600 });
  const getSetting = (key, fallback = null) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  if (!definitions.has(getSetting('djId'))) setSetting('djId', djs[0].id);
  const selectedId = () => getSetting('djId');
  const taste = () => readFileSync(tastePath, 'utf8');
  const toMessage = row => ({ id: row.id, djId: row.dj_id, role: row.role, content: row.content, createdAt: row.created_at, tracks: JSON.parse(row.tracks_json), ...(row.speech_url ? { speechUrl: row.speech_url } : {}), ...(row.note ? { note: row.note } : {}) });
  function forDj(djId = selectedId()) {
    if (!definitions.has(djId)) throw Object.assign(new Error('没有找到这个 DJ。'), { status: 404 });
    const get = (key, fallback = null) => getSetting(scopedKeys.has(key) ? `dj:${djId}:${key}` : key, fallback);
    const set = (key, value) => setSetting(scopedKeys.has(key) ? `dj:${djId}:${key}` : key, value);
    const messages = () => db.prepare('SELECT * FROM (SELECT rowid AS sequence, * FROM messages WHERE dj_id=? ORDER BY rowid DESC LIMIT 60) ORDER BY sequence').all(djId).map(toMessage);
    return {
      djId, dj: definitions.get(djId), get, set, taste,
      state: () => ({ djId, djs: availableDjs, messages: messages(), queue: get('queue', []), nowPlayingId: get('nowPlayingId'), taste: taste(), lastPlan: get('lastPlan'), volume: get('volume', 0.7) }),
      addMessage(role, content, tracks = [], speechUrl = null, note = null) {
        const message = { id: randomUUID(), djId, role, content, createdAt: new Date().toISOString(), tracks, ...(speechUrl ? { speechUrl } : {}), ...(note ? { note } : {}) };
        db.prepare('INSERT INTO messages(id,role,content,created_at,tracks_json,speech_url,note,dj_id) VALUES(?,?,?,?,?,?,?,?)').run(message.id, role, content, message.createdAt, JSON.stringify(tracks), speechUrl, note, djId);
        return message;
      },
      message(id) {
        const row = typeof id === 'string' ? db.prepare('SELECT * FROM messages WHERE id=? AND dj_id=?').get(id, djId) : null;
        return row ? toMessage(row) : undefined;
      },
      speech(id, url) { db.prepare('UPDATE messages SET speech_url=? WHERE id=? AND role=? AND dj_id=?').run(url, id, 'assistant', djId); },
      recordPlan(plan, tracks) {
        const item = { id: randomUUID(), djId, createdAt: new Date().toISOString(), reason: plan.reason, segue: plan.segue, tracks };
        db.prepare('INSERT INTO plans(id,created_at,reason,segue,tracks_json,dj_id) VALUES(?,?,?,?,?,?)').run(item.id, item.createdAt, item.reason, item.segue, JSON.stringify(tracks), djId);
        set('lastPlan', item);
      },
      recordPlay(track, action, positionMs = 0) {
        db.prepare('INSERT INTO plays(id,track_id,title,artist,action,played_at,position_ms,dj_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), track.id, track.title, track.artist, action, new Date().toISOString(), positionMs, djId);
      },
      recentPlays() { return db.prepare('SELECT title,artist,action,played_at AS playedAt FROM plays WHERE dj_id=? ORDER BY rowid DESC LIMIT 15').all(djId); },
    };
  }
  return {
    forDj,
    selectDj(djId) { forDj(djId); setSetting('djId', djId); return forDj(djId).state(); },
    get: (key, fallback) => forDj().get(key, fallback),
    set: (key, value) => forDj().set(key, value),
    state: () => forDj().state(),
    taste,
    setTaste(text) { writeFileSync(tastePath, text, { mode: 0o600 }); },
    addMessage: (...args) => forDj().addMessage(...args),
    message: (...args) => forDj().message(...args),
    speech: (...args) => forDj().speech(...args),
    recordPlan: (...args) => forDj().recordPlan(...args),
    recordPlay: (...args) => forDj().recordPlay(...args),
    recentPlays: () => forDj().recentPlays(),
    close() { db.close(); }
  };
}
