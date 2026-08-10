import {config} from './config.js';
import {logger} from './logger.js';
import {readDesktopSession} from './session.js';
import {runReconnectingWebSocket} from './websocket.js';

const getSession = () => readDesktopSession({
  url: config.mattermostUrl,
  desktopDataDir: config.desktopDataDir,
  keychainService: config.keychainService,
});

try {
  const session = getSession();
  logger.info(`已读取 Desktop Session: ${session.dataDir}`);
  logger.info(`Keychain: ${session.keychainService}`);
  logger.info(`用户 ID: ${session.userId || '(Cookie 中未提供)'}`);
} catch (error) {
  logger.error(error.message);
  logger.warn('请重新登录 Mattermost');
}

const stop = runReconnectingWebSocket({
  baseUrl: config.mattermostUrl,
  getSession,
  reconnectMs: config.reconnectMs,
  onEvent: (event) => console.log(JSON.stringify(event, null, 2)),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`收到 ${signal}，退出`);
    stop();
    process.exit(0);
  });
}
