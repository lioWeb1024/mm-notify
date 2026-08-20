import {desktopHttpHeaders} from './request-headers.js';

class AuthError extends Error {
  constructor(message, {kind, status} = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.authInvalid = kind === 'session-invalid';
  }
}

async function request(url, options, timeoutMs) {
  try {
    return await fetch(url, {...options, signal: AbortSignal.timeout(timeoutMs)});
  } catch (cause) {
    throw new AuthError('公司 VPN、DNS 或目标服务器当前不可达', {kind: 'network', cause});
  }
}

async function bodyOf(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {message: text.slice(0, 300)}; }
}

function explicitCredentialFailure(status, body) {
  const message = String(body?.message || body?.id || body?.error || '');
  return status === 401 || /invalid.{0,15}(credentials|password)|incorrect.{0,15}(credentials|password)|login.invalid/i.test(message);
}

export function createDirectAuth({baseUrl, userAgent, timeoutMs = 15000}) {
  const origin = baseUrl.replace(/\/+$/, '');

  async function checkReachability() {
    const response = await request(`${origin}/api/v4/system/ping`, {
      headers: desktopHttpHeaders({userAgent, origin}),
    }, timeoutMs);
    if (response.status >= 500) throw new AuthError(`服务器暂时异常: HTTP ${response.status}`, {kind: 'server', status: response.status});
  }

  async function validateSession(session) {
    const response = await request(`${origin}/api/v4/users/me`, {
      headers: desktopHttpHeaders({userAgent, origin, session}),
    }, timeoutMs);
    const body = await bodyOf(response);
    if (response.ok) return {valid: true, user: body};
    if (response.status === 401 || response.status === 403) return {valid: false, status: response.status};
    if (response.status >= 500) throw new AuthError(`验证 Session 时服务器异常: HTTP ${response.status}`, {kind: 'server', status: response.status});
    throw new AuthError(`无法确认 Session 状态: HTTP ${response.status}`, {kind: 'unknown', status: response.status});
  }

  async function login(username, password) {
    const response = await request(`${origin}/api/v4/users/login`, {
      method: 'POST',
      headers: {...desktopHttpHeaders({userAgent, origin}), 'Content-Type': 'application/json'},
      body: JSON.stringify({login_id: username, password}),
    }, timeoutMs);
    const body = await bodyOf(response);
    if (!response.ok) {
      throw new AuthError(`登录请求被拒绝: HTTP ${response.status}`, {
        kind: explicitCredentialFailure(response.status, body) ? 'credential' : response.status >= 500 ? 'server' : 'unknown',
        status: response.status,
      });
    }
    const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    const cookies = {};
    for (const header of setCookies) {
      for (const match of String(header).matchAll(/(?:^|,\s*)(MMAUTHTOKEN|MMUSERID|MMCSRF)=([^;,\s]+)/g)) cookies[match[1]] = match[2];
    }
    const token = response.headers.get('token') || cookies.MMAUTHTOKEN;
    if (!token || !body?.id) throw new AuthError('登录响应缺少 Token 或用户 ID', {kind: 'protocol'});
    return {
      token,
      cookie: [`MMAUTHTOKEN=${token}`, `MMUSERID=${cookies.MMUSERID || body.id}`, cookies.MMCSRF ? `MMCSRF=${cookies.MMCSRF}` : ''].filter(Boolean).join('; '),
      csrfToken: cookies.MMCSRF || '',
      userId: body.id,
      username: body.username || username,
      savedAt: Date.now(),
    };
  }

  return {checkReachability, validateSession, login};
}
