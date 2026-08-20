import fs from 'node:fs';

export const defaultLoginLock = Object.freeze({
  loginFailures: 0,
  loginLocked: false,
  lastFailureAt: null,
});

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export function writeSecureJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function clearFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function loadLoginLock(file) {
  const value = readJson(file, defaultLoginLock);
  return {
    loginFailures: Number.isInteger(value.loginFailures) ? value.loginFailures : 0,
    loginLocked: value.loginLocked === true,
    lastFailureAt: value.lastFailureAt ?? null,
  };
}
