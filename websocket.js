import WebSocket from 'ws';
import {logger} from './logger.js';
import {desktopWebSocketHeaders} from './request-headers.js';

export function websocketUrl(baseUrl) {
  const url = new URL('/api/v4/websocket', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('connection_id', '');
  url.searchParams.set('sequence_number', '0');
  url.searchParams.set('posted_ack', 'true');
  return url.toString();
}

export function runReconnectingWebSocket({
  baseUrl,
  getSession,
  reconnectMs,
  userAgent,
  validateSession,
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
  let invalidCookieHeader;
  let sessionWaitLogged = false;

  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
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

  const schedule = (delayMs = reconnectMs) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delayMs);
  };

  const connect = async () => {
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

    if (invalidCookieHeader === session.cookieHeader) {
      if (!sessionWaitLogged) {
        logger.warn('监听脚本读取的本地 Session 无效或未同步，已暂停 Socket 重连');
        sessionWaitLogged = true;
      }
      await onSessionInvalid(new Error('Mattermost Session 仍未恢复'));
      schedule(30000);
      return;
    }

    if (validateSession) {
      try {
        await validateSession(session);
        invalidCookieHeader = undefined;
        sessionWaitLogged = false;
      } catch (error) {
        if (error.authInvalid) {
          invalidCookieHeader = session.cookieHeader;
          await onSessionInvalid(error);
          logger.warn('当前磁盘 Session 验证失败，等待叮咚刷新 Cookie');
          schedule(30000);
          return;
        }
        logger.warn('Session 验证遇到网络错误，稍后重试:', error.message);
        schedule(30000);
        return;
      }
    }

    const url = websocketUrl(baseUrl);
    logger.info(`连接 ${url}`);
    socket = new WebSocket(url, {
      headers: desktopWebSocketHeaders({userAgent, origin: baseUrl, session}),
      handshakeTimeout: 15000,
    });

    socket.on('open', () => {
      logger.info('WebSocket 已连接');
      socket._socket?.setKeepAlive?.(true, 30000);
      startHeartbeat();
      startSessionCheck(session);
      onConnected(session);
    });
    // 部分代理/VPN 会丢弃 WebSocket 控制帧。单次缺少 Pong 不能作为
    // 真实断线证据，否则会由脚本自己制造 1006。
    socket.on('pong', () => {});
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
      logger.info(`${reconnectMs / 1000} 秒后重新连接…`);
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
