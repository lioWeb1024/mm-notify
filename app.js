import {config} from './config.js';
import {logger} from './logger.js';
import {readDesktopSession} from './session.js';
import {sendTelegramMessage} from './telegram.js';
import {runReconnectingWebSocket} from './websocket.js';
import {desktopHttpHeaders} from './request-headers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lockDir = path.join(os.tmpdir(), `mm-notify-${process.getuid?.() ?? 'user'}.lock`);

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstance() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, {mode: 0o700});
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), {mode: 0o600});
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10);
      if (processIsAlive(pid)) {
        logger.warn(`mm-notify 已经在运行（PID ${pid}），本次不再启动`);
        process.exit(0);
      }
      fs.rmSync(lockDir, {recursive: true, force: true});
    }
  }
  throw new Error('无法获取 mm-notify 单实例锁');
}

function releaseSingleInstance() {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10);
    if (pid === process.pid) fs.rmSync(lockDir, {recursive: true, force: true});
  } catch {
    // 锁已不存在时无需处理。
  }
}

acquireSingleInstance();
process.on('exit', releaseSingleInstance);

if (!config.telegramBotToken || !config.telegramChatId) {
  logger.error('缺少 Telegram 配置。先在 .env 填写 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID');
  logger.info('可运行 npm run telegram:setup 自动查看 Chat ID');
  process.exit(1);
}

const getSession = () => readDesktopSession({
  url: config.mattermostUrl,
  desktopDataDir: config.desktopDataDir,
  keychainService: config.keychainService,
});

async function getCurrentUser(session) {
  const response = await fetch(`${config.mattermostUrl}/api/v4/users/me`, {
    headers: desktopHttpHeaders({userAgent: config.userAgent, origin: config.mattermostUrl, session}),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error('请重新登录 Mattermost');
    error.authInvalid = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`读取当前用户失败: HTTP ${response.status}`);
  return response.json();
}

const initialSession = getSession();
let me;
let initiallySessionInvalid = false;
try {
  me = await getCurrentUser(initialSession);
  logger.info(`监听提及: ${[me.username, ...config.mentionNames].map((name) => `@${name}`).join(', ')}`);
} catch (error) {
  logger.error(error.message);
  if (!error.authInvalid) process.exit(1);
  initiallySessionInvalid = true;
  me = {id: '', username: ''};
  try {
    await sendTelegramMessage({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      text: '🔐 Mattermost 监听 Session 无效或未同步\n叮咚界面可能仍然正常，但监听脚本读到的磁盘 Cookie 已失效。\n请完全退出并重新打开叮咚，让当前 Session 同步到磁盘。',
    });
  } catch (telegramError) {
    logger.error(telegramError.message);
  }
}

function parsePosted(event) {
  if (event?.event !== 'posted') return null;
  try {
    const post = typeof event.data?.post === 'string' ? JSON.parse(event.data.post) : event.data?.post;
    if (!post || post.user_id === me.id) return null;
    const isDirect = event.data.channel_type === 'D';
    const mentionNames = new Set([me.username, ...config.mentionNames]);
    const isMention = [...mentionNames].some((name) => {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)@${escapedName}(?=$|[\\s.,!?;:，。！？；：])`, 'i')
        .test(post.message || '');
    });
    if (!isDirect && !isMention) return null;
    return {
      post,
      isDirect,
      channel: isDirect ? '私聊' : (event.data.channel_display_name || event.data.channel_name || post.channel_id),
      sender: (event.data.sender_name || post.user_id).replace(/^@/, ''),
    };
  } catch (error) {
    logger.warn('无法解析 posted 事件:', error.message);
    return null;
  }
}

let notificationQueue = Promise.resolve();
function enqueueText(text) {
  notificationQueue = notificationQueue
    .then(() => sendTelegramMessage({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      text,
    }))
    .catch((error) => logger.error(error.message));
  return notificationQueue;
}

function enqueueNotification(item) {
  const text = [
    '🔔 Mattermost',
    `频道：${item.channel}`,
    `发送人：${item.sender}`,
    `内容：${item.post.message || '(无文字内容)'}`,
  ].join('\n');
  notificationQueue = enqueueText(text)
    .then(() => logger.info(`已发送 Telegram 通知: ${item.isDirect ? '私聊' : '@提及'}`))
    .catch((error) => logger.error(error.message));
}

let shuttingDown = false;
let sessionInvalidNotified = initiallySessionInvalid;
let connectionGeneration = 0;
let disconnectNotified = false;
let disconnectNoticeTimer;
let outageStartedAt;
let lastDisconnect = {};
let initialConnectionNotified = false;

function notifySessionInvalid() {
  if (sessionInvalidNotified || shuttingDown) return;
  sessionInvalidNotified = true;
  clearTimeout(disconnectNoticeTimer);
  disconnectNoticeTimer = undefined;
  enqueueText('🔐 Mattermost 监听 Session 无效或未同步\n叮咚界面可能仍然正常，但监听脚本读到的磁盘 Cookie 已失效。\n请完全退出并重新打开叮咚，让当前 Session 同步到磁盘。');
}

async function verifySessionAfterDisconnect() {
  try {
    await getCurrentUser(getSession());
  } catch (error) {
    if (error.authInvalid) notifySessionInvalid();
    else logger.warn('断线后暂时无法验证 Session，按网络故障继续重连:', error.message);
  }
}

const stop = runReconnectingWebSocket({
  baseUrl: config.mattermostUrl,
  getSession,
  reconnectMs: config.reconnectMs,
  userAgent: config.webSocketUserAgent,
  validateSession: getCurrentUser,
  onEvent: (event) => {
    const item = parsePosted(event);
    if (item) enqueueNotification(item);
  },
  onConnected: (session) => {
    getCurrentUser(session)
      .then((currentUser) => {
        me = currentUser;
        sessionInvalidNotified = false;
        logger.info(`已刷新当前用户: @${me.username}`);
      })
      .catch((error) => {
        logger.warn('刷新当前用户失败:', error.message);
        if (error.authInvalid) notifySessionInvalid();
      });
    clearTimeout(disconnectNoticeTimer);
    disconnectNoticeTimer = undefined;
    const generation = ++connectionGeneration;
    setTimeout(() => {
      if (shuttingDown || generation !== connectionGeneration) return;
      if (disconnectNotified) {
        enqueueText(`✅ Mattermost 通知监听已恢复并稳定连接\n断线时间：${new Date(outageStartedAt).toLocaleString('zh-CN')}\n恢复时间：${new Date().toLocaleString('zh-CN')}`);
      } else if (!initialConnectionNotified) {
        enqueueText('✅ Mattermost 通知监听已连接');
        initialConnectionNotified = true;
      }
      disconnectNotified = false;
      outageStartedAt = undefined;
    }, 30000);
  },
  onDisconnected: ({code, reason}) => {
    if (shuttingDown) return;
    connectionGeneration += 1;
    lastDisconnect = {code, reason};
    outageStartedAt ??= Date.now();
    verifySessionAfterDisconnect();
    if (disconnectNotified || disconnectNoticeTimer) return;
    disconnectNoticeTimer = setTimeout(() => {
      disconnectNoticeTimer = undefined;
      if (shuttingDown) return;
      disconnectNotified = true;
      enqueueText([
        '⚠️ Mattermost 连接已确认中断',
        '持续时间：60 秒以上',
        `最近状态码：${lastDisconnect.code}`,
        lastDisconnect.reason ? `原因：${lastDisconnect.reason}` : '',
        `脚本正在每 ${config.reconnectMs / 1000} 秒自动重连`,
      ].filter(Boolean).join('\n'));
    }, 60000);
  },
  onSessionInvalid: () => {
    notifySessionInvalid();
  },
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(disconnectNoticeTimer);
    logger.info(`收到 ${signal}，退出`);
    stop();
    await enqueueText(`🛑 Mattermost 通知监听已关闭\n信号：${signal}`);
    releaseSingleInstance();
    process.exit(0);
  });
}
