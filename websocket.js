import WebSocket from 'ws';
import {logger} from './logger.js';

export function websocketUrl(baseUrl) {
  const url = new URL('/api/v4/websocket', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function runReconnectingWebSocket({
  baseUrl,
  getSession,
  reconnectMs,
  onEvent,
  onConnected = () => {},
  onDisconnected = () => {},
  onSessionInvalid = () => {},
}) {
  let stopped = false;
  let socket;
  let timer;
  let heartbeatTimer;
  let sessionCheckTimer;
  let awaitingPong = false;

  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    awaitingPong = false;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        logger.warn('WebSocket 心跳超时，主动重建连接');
        socket.terminate();
        return;
      }
      awaitingPong = true;
      socket.ping();
    }, 25000);
  };

  const stopSessionCheck = () => {
    clearInterval(sessionCheckTimer);
    sessionCheckTimer = undefined;
  };

  const startSessionCheck = (connectedSession) => {
    stopSessionCheck();
    sessionCheckTimer = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        const latestSession = getSession();
        if (latestSession.cookieHeader !== connectedSession.cookieHeader) {
          logger.info('检测到 Mattermost Session 已变化，重新连接');
          socket.terminate();
        }
      } catch (error) {
        logger.warn('当前无法读取 Mattermost Session，等待重新登录:', error.message);
        onSessionInvalid(error);
        socket.terminate();
      }
    }, 10000);
  };

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
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
      onSessionInvalid(error);
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

    socket.on('open', () => {
      logger.info('WebSocket 已连接');
      startHeartbeat();
      startSessionCheck(session);
      onConnected(session);
    });
    socket.on('pong', () => {
      awaitingPong = false;
    });
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
        onSessionInvalid(new Error(`Mattermost Session 无效: HTTP ${response.statusCode}`));
      } else {
        logger.warn(`WebSocket 握手失败: HTTP ${response.statusCode}`);
      }
    });
    socket.on('error', (error) => logger.warn('WebSocket 错误:', error.message));
    socket.on('close', (code, reason) => {
      stopHeartbeat();
      stopSessionCheck();
      logger.warn(`WebSocket 已关闭: ${code} ${reason.toString()}`.trim());
      onDisconnected({code, reason: reason.toString()});
      schedule();
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopHeartbeat();
    stopSessionCheck();
    socket?.close(1000, 'shutdown');
  };
}
