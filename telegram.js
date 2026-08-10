const TELEGRAM_API = 'https://api.telegram.org';

async function callTelegram(token, method, body = undefined) {
  if (!token) throw new Error('缺少 TELEGRAM_BOT_TOKEN');
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? {'content-type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram ${method} 失败: ${result?.description || `HTTP ${response.status}`}`);
  }
  return result.result;
}

export const getTelegramMe = (token) => callTelegram(token, 'getMe');
export const getTelegramUpdates = (token) => callTelegram(token, 'getUpdates');

export async function sendTelegramMessage({token, chatId, text}) {
  if (!chatId) throw new Error('缺少 TELEGRAM_CHAT_ID');
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
  });
}
