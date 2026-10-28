import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_COOKIE_BYTES = 16_384;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function unavailable() {
  return Object.assign(new Error('无法安全读写网易云登录凭据，请检查本机文件权限。'), {
    code: 'MUSIC_SESSION_UNAVAILABLE', status: 503,
  });
}

function validCookie(cookie) {
  return typeof cookie === 'string' && Boolean(cookie.trim())
    && Buffer.byteLength(cookie) <= MAX_COOKIE_BYTES && !/[\u0000-\u001f\u007f]/u.test(cookie);
}

function ownedPrivate(info, directory) {
  return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
    && (typeof process.getuid !== 'function' || info.uid === process.getuid())
    && (process.platform === 'win32' || (info.mode & 0o777) === (directory ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE));
}

function maybeStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The caller supplies a directory within its allocated private application data.
// Keep this cookie outside the business database and all public/source files.
export function createMusicSessionStore(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw unavailable();
  const root = resolve(directory);
  const filename = join(root, 'session.cookie');
  let identity;

  function checkDirectory() {
    const parent = maybeStat(dirname(root));
    const info = maybeStat(root);
    if (!parent?.isDirectory() || parent.isSymbolicLink() || !info || !ownedPrivate(info, true)
      || identity && (info.dev !== identity.dev || info.ino !== identity.ino)) throw unavailable();
    return info;
  }

  function checkFile() {
    const info = maybeStat(filename);
    if (info && (!ownedPrivate(info, false) || info.size > MAX_COOKIE_BYTES)) throw unavailable();
    return info;
  }

  function safely(operation) {
    try { return operation(); }
    catch { throw unavailable(); }
  }

  safely(() => {
    // Validate the nearest existing parent before creating missing private dirs;
    // never let a symlink supplied in place of the session directory redirect it.
    let parent = root;
    let info = maybeStat(parent);
    while (!info) {
      const next = dirname(parent);
      if (next === parent) throw unavailable();
      parent = next;
      info = maybeStat(parent);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    identity = checkDirectory();
    checkFile();
  });

  function get() {
    return safely(() => {
      checkDirectory();
      if (!checkFile()) return '';
      const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = fstatSync(descriptor);
        if (!ownedPrivate(info, false) || info.size > MAX_COOKIE_BYTES) throw unavailable();
        const cookie = readFileSync(descriptor, 'utf8');
        if (!validCookie(cookie)) throw unavailable();
        return cookie;
      } finally { closeSync(descriptor); }
    });
  }

  function set(cookie) {
    if (!validCookie(cookie)) {
      throw Object.assign(new Error('网易云登录凭据格式无效，请重新扫码。'), {
        code: 'MUSIC_SESSION_INVALID_COOKIE', status: 400,
      });
    }
    return safely(() => {
      checkDirectory();
      checkFile();
      const temporary = join(root, `.session-${randomUUID()}.tmp`);
      let descriptor;
      try {
        descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | (constants.O_NOFOLLOW || 0), PRIVATE_FILE_MODE);
        writeFileSync(descriptor, cookie, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        checkDirectory();
        checkFile();
        renameSync(temporary, filename);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporary); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    });
  }

  function clear() {
    return safely(() => {
      checkDirectory();
      if (checkFile()) unlinkSync(filename);
    });
  }

  return { get, set, clear };
}
