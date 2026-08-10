import {config} from './config.js';
import {logger} from './logger.js';
import {readDesktopSession} from './session.js';
import {sendTelegramMessage} from './telegram.js';
import {runReconnectingWebSocket} from './websocket.js';

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
function enqueueNotification(item) {
  const text = [
    '🔔 Mattermost',
    '',
    '频道：', item.channel,
    '',
    '发送人：', item.sender,
    '',
    '内容：', item.post.message || '(无文字内容)',
  ].join('\n');
  notificationQueue = notificationQueue
    .then(() => sendTelegramMessage({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      text,
    }))
    .then(() => logger.info(`已发送 Telegram 通知: ${item.isDirect ? '私聊' : '@提及'}`))
    .catch((error) => logger.error(error.message));
}

const stop = runReconnectingWebSocket({
  baseUrl: config.mattermostUrl,
  getSession,
  reconnectMs: config.reconnectMs,
  onEvent: (event) => {
    const item = parsePosted(event);
    if (item) enqueueNotification(item);
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`收到 ${signal}，退出`);
    stop();
    process.exit(0);
  });
}
