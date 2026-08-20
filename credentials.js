import {execFileSync} from 'node:child_process';

export function readLoginPassword({service, username}) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-w', '-s', service, '-a', username,
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  } catch {
    throw new Error(`macOS 钥匙串中没有 ${service} / ${username} 的登录密码`);
  }
}
