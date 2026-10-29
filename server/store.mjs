import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(root, { dataDir = join(root, '.data'), profileDir = join(root, 'user') } = {}) {
  const dir = dataDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dbPath = join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, tracks_json TEXT NOT NULL, speech_url TEXT);
    CREATE TABLE IF NOT EXISTS plays (id TEXT PRIMARY KEY, track_id TEXT, title TEXT, artist TEXT, action TEXT, played_at TEXT, position_ms INTEGER);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, created_at TEXT, reason TEXT, segue TEXT, tracks_json TEXT);
  `);
  // Added after the first release: a short system note shown outside Bob's bubble.
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'note')) db.exec('ALTER TABLE messages ADD COLUMN note TEXT');
  mkdirSync(profileDir, { recursive: true });
  const tastePath = join(profileDir, 'taste.md');
  if (!existsSync(tastePath)) writeFileSync(tastePath, '', { mode: 0o600 });
  const get = (key, fallback = null) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const set = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const toMessage = row => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at, tracks: JSON.parse(row.tracks_json), ...(row.speech_url ? { speechUrl: row.speech_url } : {}), ...(row.note ? { note: row.note } : {}) });
  const messages = () => db.prepare('SELECT * FROM (SELECT rowid AS sequence, * FROM messages ORDER BY rowid DESC LIMIT 60) ORDER BY sequence').all().map(toMessage);
  const taste = () => readFileSync(tastePath, 'utf8');
  const state = () => ({ messages: messages(), queue: get('queue', []), nowPlayingId: get('nowPlayingId'), taste: taste(), lastPlan: get('lastPlan'), volume: get('volume', 0.7) });
  return {
    get, set, state, taste,
    setTaste(text) { writeFileSync(tastePath, text, { mode: 0o600 }); },
    addMessage(role, content, tracks = [], speechUrl = null, note = null) {
      const message = { id: randomUUID(), role, content, createdAt: new Date().toISOString(), tracks, ...(speechUrl ? { speechUrl } : {}), ...(note ? { note } : {}) };
      db.prepare('INSERT INTO messages(id,role,content,created_at,tracks_json,speech_url,note) VALUES(?,?,?,?,?,?,?)').run(message.id, role, content, message.createdAt, JSON.stringify(tracks), speechUrl, note);
      return message;
    },
    message(id) {
      const row = typeof id === 'string' ? db.prepare('SELECT * FROM messages WHERE id = ?').get(id) : null;
      return row ? toMessage(row) : undefined;
    },
    speech(id, url) { db.prepare('UPDATE messages SET speech_url=? WHERE id=? AND role=?').run(url, id, 'assistant'); },
    recordPlan(plan, tracks) {
      const item = { id: randomUUID(), createdAt: new Date().toISOString(), reason: plan.reason, segue: plan.segue, tracks };
      db.prepare('INSERT INTO plans VALUES(?,?,?,?,?)').run(item.id, item.createdAt, item.reason, item.segue, JSON.stringify(tracks));
      set('lastPlan', item);
    },
    recordPlay(track, action, positionMs = 0) {
      db.prepare('INSERT INTO plays VALUES(?,?,?,?,?,?,?)').run(randomUUID(), track.id, track.title, track.artist, action, new Date().toISOString(), positionMs);
    },
    recentPlays() { return db.prepare('SELECT title,artist,action,played_at AS playedAt FROM plays ORDER BY rowid DESC LIMIT 15').all(); },
    close() { db.close(); }
  };
}
