import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';

const COOKIE_NAMES = ['MMAUTHTOKEN', 'MMCSRF', 'MMUSERID'];

function runningElectronDataDirs() {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'command='], {encoding: 'utf8'});
    return [...output.matchAll(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)]
      .map((match) => match[1] || match[2] || match[3])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function candidateDataDirs(explicitDir) {
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
  return [...new Set([
    explicitDir,
    ...runningElectronDataDirs(),
    path.join(appSupport, 'Mattermost'),
    path.join(appSupport, 'Mattermost Desktop'),
    path.join(appSupport, '叮咚'),
  ].filter(Boolean))];
}

function findCookieDb(dataDir) {
  const candidates = [path.join(dataDir, 'Network', 'Cookies'), path.join(dataDir, 'Cookies')];
  return candidates.find((file) => fs.existsSync(file));
}

function appNameFromDataDir(dataDir) {
  return path.basename(dataDir);
}

function keychainPassword(service) {
  return execFileSync('security', ['find-generic-password', '-w', '-s', service], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function decryptChromiumCookie(encrypted, password, host) {
  if (!encrypted?.length) return '';
  const prefix = encrypted.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new Error(`不支持的 Chromium Cookie 加密格式: ${prefix || 'unknown'}`);
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);

  // Chromium DB schema >= 24 prefixes SHA-256(host_key) before the value.
  const hostHash = crypto.createHash('sha256').update(host).digest();
  if (plain.length >= 32 && crypto.timingSafeEqual(plain.subarray(0, 32), hostHash)) {
    plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

function readRows(cookieDb, hostname) {
  const db = new Database(cookieDb, {readonly: true, fileMustExist: true, timeout: 3000});
  try {
    return db.prepare(`
      SELECT host_key, name, value, encrypted_value
      FROM cookies
      WHERE name IN (${COOKIE_NAMES.map(() => '?').join(',')})
        AND (
          ? = ltrim(host_key, '.')
          OR ? LIKE '%.' || ltrim(host_key, '.')
        )
      ORDER BY last_access_utc DESC
    `).all(...COOKIE_NAMES, hostname, hostname);
  } finally {
    db.close();
  }
}

export function readDesktopSession({url, desktopDataDir = '', keychainService = ''}) {
  const hostname = new URL(url).hostname;
  const attempts = [];

  for (const dataDir of candidateDataDirs(desktopDataDir)) {
    const cookieDb = findCookieDb(dataDir);
    if (!cookieDb) continue;
    const rows = readRows(cookieDb, hostname);
    const tokenRow = rows.find((row) => row.name === 'MMAUTHTOKEN');
    if (!tokenRow) {
      attempts.push(`${dataDir}: 没有 ${hostname} 的 MMAUTHTOKEN`);
      continue;
    }

    const services = [...new Set([
      keychainService,
      `${appNameFromDataDir(dataDir)} Safe Storage`,
      'Mattermost Safe Storage',
    ].filter(Boolean))];

    for (const service of services) {
      try {
        const password = keychainPassword(service);
        const cookies = {};
        for (const row of rows) {
          // Rows are ordered newest first. Keep the first value for each cookie
          // so an older cookie from another matching domain cannot overwrite it.
          if (Object.hasOwn(cookies, row.name)) continue;
          cookies[row.name] = row.value
            || decryptChromiumCookie(row.encrypted_value, password, row.host_key);
        }
        if (!cookies.MMAUTHTOKEN) continue;
        return {
          dataDir,
          keychainService: service,
          userId: cookies.MMUSERID || '',
          csrfToken: cookies.MMCSRF || '',
          cookieHeader: COOKIE_NAMES.filter((name) => cookies[name])
            .map((name) => `${name}=${cookies[name]}`).join('; '),
        };
      } catch (error) {
        attempts.push(`${dataDir} / ${service}: ${error.message}`);
      }
    }
  }

  throw new Error(`无法读取 Mattermost Desktop Session。${attempts.join('；')}`);
}
