import WebSocket from 'ws';
import {logger} from './logger.js';

export function websocketUrl(baseUrl) {
  const url = new URL('/api/v4/websocket', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function runReconnectingWebSocket({baseUrl, getSession, reconnectMs, onEvent}) {
  let stopped = false;
  let socket;
  let timer;

  const schedule = () => {
    if (stopped) return;
    logger.info(`${reconnectMs / 1000} 秒后重新连接…`);
    timer = setTimeout(connect, reconnectMs);
  };

  const connect = () => {
    let session;
    try {
      session = getSession();
    } catch (error) {
      logger.error(error.message);
      logger.warn('请重新登录 Mattermost');
      schedule();
      return;
    }

    const url = websocketUrl(baseUrl);
    logger.info(`连接 ${url}`);
    socket = new WebSocket(url, {
      headers: {
        Cookie: session.cookieHeader,
        Origin: baseUrl,
      },
      handshakeTimeout: 15000,
    });

    socket.on('open', () => logger.info('WebSocket 已连接，正在打印全部事件'));
    socket.on('message', (data) => {
      try {
        onEvent(JSON.parse(data.toString()));
      } catch (error) {
        logger.warn('收到无法解析的消息', error.message, data.toString());
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        logger.warn('请重新登录 Mattermost');
      } else {
        logger.warn(`WebSocket 握手失败: HTTP ${response.statusCode}`);
      }
    });
    socket.on('error', (error) => logger.warn('WebSocket 错误:', error.message));
    socket.on('close', (code, reason) => {
      logger.warn(`WebSocket 已关闭: ${code} ${reason.toString()}`.trim());
      schedule();
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close(1000, 'shutdown');
  };
}
