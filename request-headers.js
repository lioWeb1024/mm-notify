export function desktopHttpHeaders({userAgent, origin, session}) {
  const headers = {
    Accept: '*/*',
    'Accept-Language': 'zh-CN',
    Cookie: session.cookieHeader,
    Origin: origin,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': userAgent,
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
  if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
  return headers;
}

export function desktopWebSocketHeaders({userAgent, origin, session}) {
  return {
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN',
    'Cache-Control': 'no-cache',
    Cookie: session.cookieHeader,
    Origin: origin,
    Pragma: 'no-cache',
    // Node.js 拒绝 Header 字符串中的直接中文。转为 latin1 字符串后，
    // http 模块发出的原始字节仍是 Chromium 使用的 UTF-8。
    'User-Agent': Buffer.from(userAgent, 'utf8').toString('latin1'),
  };
}
