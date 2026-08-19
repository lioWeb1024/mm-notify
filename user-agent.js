import crypto from 'node:crypto';

const BASE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ??/1.0.0 Chrome/126.0.6478.185 Electron/31.3.1 Safari/537.36';
const WEBSOCKET_BASE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) 叮咚/1.0.0 Chrome/126.0.6478.185 Electron/31.3.1 Safari/537.36';
const MATTERMOST_VERSION = '1.0.0';
const SIGN_APP_ID = 'com.dingdong.im-plus';
const SIGN_BUILD_TIMESTAMP = '1725519171338';

export function buildDingDongUserAgent(baseUserAgent = BASE_USER_AGENT) {
  // 叮咚桌面客户端使用构建时间戳，而不是每次请求的当前时间：
  // sign = MD5(appId + buildTimestamp)。
  const signature = crypto
    .createHash('md5')
    .update(`${SIGN_APP_ID}${SIGN_BUILD_TIMESTAMP}`)
    .digest('hex');
  return `${baseUserAgent} Mattermost/${MATTERMOST_VERSION} sign/${signature}/${SIGN_BUILD_TIMESTAMP}`;
}

export const dingDongUserAgent = buildDingDongUserAgent();
export const dingDongWebSocketUserAgent = buildDingDongUserAgent(WEBSOCKET_BASE_USER_AGENT);
