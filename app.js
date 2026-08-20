import {config} from './config.js';
import {logger} from './logger.js';
import {sendTelegramMessage} from './telegram.js';
import {runReconnectingWebSocket} from './websocket.js';
import {createDirectAuth} from './direct-auth.js';
import {readLoginPassword} from './credentials.js';
import {readJson, writeSecureJson, clearFile, loadLoginLock, defaultLoginLock} from './direct-state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const sessionFile = path.join(projectDir, 'direct-session.json');
const loginLockFile = path.join(projectDir, 'direct-login-lock.json');
const lockDir = path.join(os.tmpdir(), `mm-notify-${process.getuid?.() ?? 'user'}.lock`);
const NETWORK_DELAYS = [5000, 15000, 30000, 60000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  } catch {}
}

acquireSingleInstance();
process.on('exit', releaseSingleInstance);

if (!config.telegramBotToken || !config.telegramChatId) {
  logger.error('缺少 Telegram 配置。先在 .env 填写 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID');
  process.exit(1);
}

let notificationQueue = Promise.resolve();
function enqueueText(text) {
  notificationQueue = notificationQueue
    .then(() => sendTelegramMessage({token: config.telegramBotToken, chatId: config.telegramChatId, text}))
    .catch(error => logger.error(error.message));
  return notificationQueue;
}

const auth = createDirectAuth({baseUrl: config.mattermostUrl, userAgent: config.userAgent});
let activeSession;
let me;
let shuttingDown = false;
let recoveryPromise;

async function obtainSession() {
  let networkAttempt = 0;
  let invalidNoticeSent = false;
  while (!shuttingDown) {
    const existing = readJson(sessionFile, null);
    if (existing?.token) {
      try {
        const result = await auth.validateSession(existing);
        if (result.valid) {
          writeSecureJson(loginLockFile, defaultLoginLock);
          return {session: existing, user: result.user, reused: true};
        }
        if (!invalidNoticeSent) {
          invalidNoticeSent = true;
          await enqueueText('🔐 Mattermost 独立监听 Session 已失效\n将按账号安全规则自动重新登录。');
        }
        clearFile(sessionFile);
      } catch (error) {
        const delay = NETWORK_DELAYS[Math.min(networkAttempt++, NETWORK_DELAYS.length - 1)];
        logger.warn(`${error.message}；${delay / 1000} 秒后重试，不会提交密码`);
        await sleep(delay);
        continue;
      }
    }

    const lock = loadLoginLock(loginLockFile);
    writeSecureJson(loginLockFile, lock);
    if (lock.loginLocked) {
      await enqueueText('🚨 Mattermost 自动登录已停止\n连续认证失败：2 次\n为避免账号被锁，需要人工处理。');
      await sleep(60000);
      continue;
    }

    let password;
    try {
      password = readLoginPassword({service: config.loginKeychainService, username: config.mattermostUsername});
    } catch (error) {
      logger.error(error.message);
      await enqueueText(`🚨 Mattermost 独立监听无法登录\n${error.message}`);
      await sleep(60000);
      continue;
    }

    try {
      await auth.checkReachability();
      const session = await auth.login(config.mattermostUsername, password);
      password = '';
      writeSecureJson(sessionFile, session);
      writeSecureJson(loginLockFile, defaultLoginLock);
      await enqueueText(`✅ Mattermost 独立登录成功\n时间：${new Date().toLocaleString('zh-CN')}\nSession 已安全保存\nSocket 正在恢复`);
      return {session, user: {id: session.userId, username: session.username}, reused: false};
    } catch (error) {
      password = '';
      if (error.kind !== 'credential') {
        const delay = NETWORK_DELAYS[Math.min(networkAttempt++, NETWORK_DELAYS.length - 1)];
        logger.warn(`${error.message}；不计入登录失败，${delay / 1000} 秒后重试`);
        await sleep(delay);
        continue;
      }
      const current = loadLoginLock(loginLockFile);
      const failures = Math.min(2, current.loginFailures + 1);
      writeSecureJson(loginLockFile, {loginFailures: failures, loginLocked: failures >= 2, lastFailureAt: Date.now()});
      if (failures >= 2) {
        await enqueueText('🚨 Mattermost 自动登录已停止\n连续登录失败：2 次\n需要人工检查账号或密码。');
      } else {
        await enqueueText('⚠️ Mattermost 登录失败\n第 1 / 2 次\n程序将再尝试一次。');
        await sleep(15000);
      }
    }
  }
  throw new Error('服务正在停止');
}

const getSession = () => {
  if (!activeSession?.token) throw new Error('独立 Session 尚未就绪');
  return {...activeSession, cookieHeader: activeSession.cookie};
};

async function getCurrentUser(session = getSession()) {
  const normalized = session.cookie ? session : {...session, cookie: session.cookieHeader};
  const result = await auth.validateSession(normalized);
  if (!result.valid) {
    const error = new Error('Mattermost Session 已失效');
    error.authInvalid = true;
    error.status = result.status;
    throw error;
  }
  return result.user;
}

async function recoverSession() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    try {
      const validation = activeSession ? await auth.validateSession(activeSession) : {valid: false};
      if (validation.valid) return;
    } catch (error) {
      logger.warn('当前无法确认 Session 状态，不会提交密码:', error.message);
      return;
    }
    clearFile(sessionFile);
    const state = await obtainSession();
    activeSession = state.session;
    me = state.user;
  })().finally(() => { recoveryPromise = undefined; });
  return recoveryPromise;
}

const initial = await obtainSession();
activeSession = initial.session;
me = initial.user;
logger.info(`独立 Session ${initial.reused ? '已复用' : '已创建'}；监听提及: ${[me.username, ...config.mentionNames].map(name => `@${name}`).join(', ')}`);

function parsePosted(event) {
  if (event?.event !== 'posted') return null;
  try {
    const post = typeof event.data?.post === 'string' ? JSON.parse(event.data.post) : event.data?.post;
    if (!post || post.user_id === me.id) return null;
    const isDirect = event.data.channel_type === 'D';
    const names = new Set([me.username, ...config.mentionNames].filter(Boolean));
    const isMention = [...names].some(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?;:，。！？；：])`, 'i').test(post.message || '');
    });
    if (!isDirect && !isMention) return null;
    return {post, isDirect, channel: isDirect ? '私聊' : event.data.channel_display_name || event.data.channel_name || post.channel_id, sender: (event.data.sender_name || post.user_id).replace(/^@/, '')};
  } catch (error) {
    logger.warn('无法解析 posted 事件:', error.message);
    return null;
  }
}

function enqueueNotification(item) {
  enqueueText(['🔔 Mattermost', `频道：${item.channel}`, `发送人：${item.sender}`, `内容：${item.post.message || '(无文字内容)'}`].join('\n'));
}

let connectionGeneration = 0;
let disconnectNotified = false;
let disconnectNoticeTimer;
let outageStartedAt;
let lastDisconnect = {};
let initialConnectionNotified = false;

async function verifySessionAfterDisconnect() {
  try { await getCurrentUser(); } catch (error) { if (error.authInvalid) recoverSession(); else logger.warn('断线后无法验证 Session:', error.message); }
}

const stop = runReconnectingWebSocket({
  baseUrl: config.mattermostUrl,
  getSession,
  reconnectMs: config.reconnectMs,
  userAgent: config.webSocketUserAgent,
  validateSession: getCurrentUser,
  onEvent: event => { const item = parsePosted(event); if (item) enqueueNotification(item); },
  onConnected: session => {
    getCurrentUser(session).then(user => { me = user; }).catch(error => { if (error.authInvalid) recoverSession(); });
    clearTimeout(disconnectNoticeTimer);
    disconnectNoticeTimer = undefined;
    const generation = ++connectionGeneration;
    setTimeout(() => {
      if (shuttingDown || generation !== connectionGeneration) return;
      if (disconnectNotified) enqueueText(`✅ Mattermost 通知监听已恢复并稳定连接\n断线时间：${new Date(outageStartedAt).toLocaleString('zh-CN')}\n恢复时间：${new Date().toLocaleString('zh-CN')}`);
      else if (!initialConnectionNotified) { enqueueText('✅ Mattermost 独立通知监听已连接'); initialConnectionNotified = true; }
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
      enqueueText(['⚠️ Mattermost 连接已确认中断', '持续时间：60 秒以上', `最近状态码：${lastDisconnect.code}`, lastDisconnect.reason ? `原因：${lastDisconnect.reason}` : '', '正在使用独立 Session 自动恢复'].filter(Boolean).join('\n'));
    }, 60000);
  },
  onSessionInvalid: () => recoverSession(),
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(disconnectNoticeTimer);
    stop();
    await enqueueText(`🛑 Mattermost 通知监听已关闭\n信号：${signal}`);
    releaseSingleInstance();
    process.exit(0);
  });
}
