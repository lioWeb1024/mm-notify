import {config} from './config.js';
import {logger} from './logger.js';
import {readDesktopSession} from './session.js';
import {sendTelegramMessage} from './telegram.js';
import {runReconnectingWebSocket} from './websocket.js';
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
    headers: {Cookie: session.cookieHeader},
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('请重新登录 Mattermost');
  }
  if (!response.ok) throw new Error(`读取当前用户失败: HTTP ${response.status}`);
  return response.json();
}

const initialSession = getSession();
let me;
try {
  me = await getCurrentUser(initialSession);
  logger.info(`监听提及: ${[me.username, ...config.mentionNames].map((name) => `@${name}`).join(', ')}`);
} catch (error) {
  logger.error(error.message);
  process.exit(1);
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
let sessionInvalidNotified = false;
let connectionGeneration = 0;
let disconnectNotified = false;
const stop = runReconnectingWebSocket({
  baseUrl: config.mattermostUrl,
  getSession,
  reconnectMs: config.reconnectMs,
  onEvent: (event) => {
    const item = parsePosted(event);
    if (item) enqueueNotification(item);
  },
  onConnected: () => {
    sessionInvalidNotified = false;
    const generation = ++connectionGeneration;
    setTimeout(() => {
      if (shuttingDown || generation !== connectionGeneration) return;
      enqueueText(disconnectNotified
        ? '✅ Mattermost 通知监听已恢复并稳定连接'
        : '✅ Mattermost 通知监听已连接');
      disconnectNotified = false;
    }, 30000);
  },
  onDisconnected: ({code, reason}) => {
    if (shuttingDown) return;
    connectionGeneration += 1;
    if (disconnectNotified) return;
    disconnectNotified = true;
    enqueueText([
      '⚠️ Mattermost 连接已断开',
      `状态码：${code}`,
      reason ? `原因：${reason}` : '',
      `将在 ${config.reconnectMs / 1000} 秒后重连`,
    ].filter(Boolean).join('\n'));
  },
  onSessionInvalid: () => {
    if (sessionInvalidNotified || shuttingDown) return;
    sessionInvalidNotified = true;
    enqueueText('🔐 Mattermost Session 已失效或已退出登录\n请重新登录 Mattermost，程序不会自动登录。');
  },
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，退出`);
    stop();
    await enqueueText(`🛑 Mattermost 通知监听已关闭\n信号：${signal}`);
    releaseSingleInstance();
    process.exit(0);
  });
}
