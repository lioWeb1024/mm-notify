import {config} from './config.js';
import {getTelegramMe, getTelegramUpdates, sendTelegramMessage} from './telegram.js';

if (!config.telegramBotToken) {
  console.error('请先把 BotFather 给你的 token 写入 .env 的 TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

try {
  const bot = await getTelegramMe(config.telegramBotToken);
  console.log(`Bot 连接成功: @${bot.username}`);

  if (process.argv.includes('--send-test')) {
    if (!config.telegramChatId) throw new Error('缺少 TELEGRAM_CHAT_ID');
    await sendTelegramMessage({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      text: '✅ mm-notify Telegram 测试成功',
    });
    console.log('测试消息已发送');
    process.exit(0);
  }

  const updates = await getTelegramUpdates(config.telegramBotToken);
  const chats = new Map();
  for (const update of updates) {
    const message = update.message || update.edited_message || update.channel_post;
    if (message?.chat) chats.set(String(message.chat.id), message.chat);
  }
  if (!chats.size) {
    console.log(`请先在 Telegram 打开 @${bot.username}，点击 Start 或发送任意消息，然后再次运行 npm run telegram:setup`);
  } else {
    console.log('找到以下 Chat ID：');
    for (const [id, chat] of chats) {
      console.log(`${id}  ${chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.type}`);
    }
    console.log('把你自己的 Chat ID 写入 .env 的 TELEGRAM_CHAT_ID');
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
