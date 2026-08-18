import 'dotenv/config';
import {dingDongUserAgent} from './user-agent.js';

export const config = Object.freeze({
  mattermostUrl: (process.env.MM_URL || 'https://second.dingdongs.vip').replace(/\/+$/, ''),
  desktopDataDir: process.env.MM_DESKTOP_DATA_DIR || '',
  keychainService: process.env.MM_KEYCHAIN_SERVICE || '',
  reconnectMs: Number.parseInt(process.env.MM_RECONNECT_MS || '5000', 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  mentionNames: (process.env.MM_MENTION_NAMES || '')
    .split(',')
    .map((name) => name.trim().replace(/^@/, ''))
    .filter(Boolean),
  userAgent: dingDongUserAgent,
});
