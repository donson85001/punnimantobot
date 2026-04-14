import tmi from 'tmi.js';
import fetch from 'node-fetch';
import http from 'http';

/* =========================================================
 * 環境變數
 * ========================================================= */
const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim();
const OAUTH_TOKEN = (process.env.OAUTH_TOKEN || '').trim();
const API = (process.env.API || '').trim();

const CHANNELS = (
  process.env.CHANNELS ||
  process.env.CHANNEL ||
  ''
)
  .split(',')
  .map(s => s.trim().replace(/^#/, '').toLowerCase())
  .filter(Boolean);

const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);

/* =========================================================
 * 基本設定
 * ========================================================= */
const API_TIMEOUT_MS = 8000;
const MANUAL_RECONNECT_DELAY_MS = 5000;
const WATCHDOG_INTERVAL_MS = 60000;         // 每 60 秒檢查一次
const IRC_IDLE_LIMIT_MS = 4 * 60 * 1000;   // 4 分鐘沒任何 IRC 活動就判定可疑
const QUEUE_STUCK_LIMIT_MS = 2 * 60 * 1000; // queue 卡超過 2 分鐘也判定可疑
const MAX_FORCED_RECONNECTS = 6;            // 連續強制重連上限，超過就自爆給 Railway 重啟
const DUPLICATE_REPLY_WINDOW_MS = 31 * 1000; // Twitch 常見重複訊息限制附近
const MAX_MESSAGE_LENGTH = 450;

/* =========================================================
 * 啟動檢查
 * ========================================================= */
if (!BOT_USERNAME) {
  console.error('❌ 缺少 BOT_USERNAME');
  process.exit(1);
}
if (!OAUTH_TOKEN) {
  console.error('❌ 缺少 OAUTH_TOKEN');
  process.exit(1);
}
if (!API) {
  console.error('❌ 缺少 API');
  process.exit(1);
}
if (!CHANNELS.length) {
  console.error('❌ 缺少 CHANNELS / CHANNEL');
  process.exit(1);
}

/* =========================================================
 * 全域狀態
 * ========================================================= */
let client = null;
let isConnecting = false;
let manualReconnectTimer = null;
let heartbeatTimer = null;
let watchdogTimer = null;
let server = null;

let lastIrcActivityAt = Date.now();
let lastConnectAt = 0;
let lastDisconnectAt = 0;
let lastMessageAt = 0;
let lastApiSuccessAt = 0;
let lastApiErrorAt = 0;
let lastQueueProcessedAt = 0;
let queueProcessingStartedAt = 0;

let forcedReconnectCount = 0;
let shuttingDown = false;

/* =========================================================
 * 發話節流 / 防重複
 * ========================================================= */
const recentBotReplies = new Map(); // key = channel|message => ts

function rememberBotReply(channel, message) {
  const key = `${normalizeChannel(channel)}|${message}`;
  recentBotReplies.set(key, Date.now());
}

function hasRecentSameReply(channel, message) {
  const key = `${normalizeChannel(channel)}|${message}`;
  const ts = recentBotReplies.get(key);
  if (!ts) return false;
  return Date.now() - ts < DUPLICATE_REPLY_WINDOW_MS;
}

function cleanupRecentReplies() {
  const now = Date.now();
  for (const [key, ts] of recentBotReplies.entries()) {
    if (now - ts > DUPLICATE_REPLY_WINDOW_MS + 5000) {
      recentBotReplies.delete(key);
    }
  }
}

/* =========================================================
 * 指令佇列
 * ========================================================= */
const taskQueue = [];
let processingQueue = false;

function enqueueTask(fn) {
  taskQueue.push(fn);
  processQueue().catch(err => {
    console.error('❌ processQueue fatal:', err);
  });
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  queueProcessingStartedAt = Date.now();

  try {
    while (taskQueue.length > 0) {
      const job = taskQueue.shift();
      try {
        await job();
      } catch (err) {
        console.error('❌ Queue job error:', err);
      } finally {
        lastQueueProcessedAt = Date.now();
      }
    }
  } finally {
    processingQueue = false;
    queueProcessingStartedAt = 0;
  }
}

/* =========================================================
 * 工具
 * ========================================================= */
function touchIrcActivity(source = '') {
  lastIrcActivityAt = Date.now();
  if (source) {
    // 想更安靜可以拿掉這行
    // console.log(`🫀 IRC activity: ${source}`);
  }
}

function cleanText(v) {
  return String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChannel(channel) {
  return cleanText(channel).replace(/^#/, '').toLowerCase();
}

function safeEncode(v) {
  return encodeURIComponent(cleanText(v));
}

function truncateMessage(msg, max = MAX_MESSAGE_LENGTH) {
  const text = cleanText(msg);
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function buildApiUrl(action, params = {}) {
  const url = new URL(API);
  url.searchParams.set('action', action);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = cleanText(value);
    if (!text) continue;
    url.searchParams.set(key, text);
  }
  return url.toString();
}

function isAddSongAllowed(tags) {
  const username = cleanText(tags?.username || '').toLowerCase();
  const badges = tags?.badges || {};
  const isBroadcaster = badges?.broadcaster === '1';
  const isMod = tags?.mod === true || badges?.moderator === '1';
  const isWhitelisted = ADD_SONG_USERS.includes(username);
  return isBroadcaster || isMod || isWhitelisted;
}

function getHealthState() {
  const now = Date.now();
  const ircIdleMs = now - lastIrcActivityAt;
  const queueStuckMs = processingQueue && queueProcessingStartedAt
    ? now - queueProcessingStartedAt
    : 0;

  const isIrcStale = ircIdleMs > IRC_IDLE_LIMIT_MS;
  const isQueueStuck = queueStuckMs > QUEUE_STUCK_LIMIT_MS;

  return {
    ok: !shuttingDown && !isConnecting && !isIrcStale && !isQueueStuck,
    now,
    botUsername: BOT_USERNAME,
    channels: CHANNELS,
    ircIdleMs,
    queueStuckMs,
    isConnecting,
    processingQueue,
    forcedReconnectCount,
    lastConnectAt,
    lastDisconnectAt,
    lastMessageAt,
    lastApiSuccessAt,
    lastApiErrorAt,
    lastQueueProcessedAt,
    uptimeSec: Math.floor(process.uptime()),
  };
}

/* =========================================================
 * HTTP Health Server
 * ========================================================= */
function startHealthServer() {
  server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/' || url === '/health') {
      const health = getHealthState();
      const code = health.ok ? 200 : 503;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(PORT, () => {
    console.log(`🌐 Health server listening on :${PORT}`);
  });
}

/* =========================================================
 * Twitch client
 * ========================================================= */
function createClient() {
  return new tmi.Client({
    options: {
      debug: true,
      messagesLogLevel: 'info',
    },
    connection: {
      reconnect: true,
      secure: true,
      // 下面這幾個是 tmi.js 官方支援的 reconnect 參數
      maxReconnectAttempts: Infinity,
      reconnectInterval: 1000,
      maxReconnectInterval: 30000,
      reconnectDecay: 1.5,
    },
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN,
    },
    channels: CHANNELS.map(ch => `#${ch}`),
  });
}

async function connectClient() {
  if (isConnecting || shuttingDown) return;
  isConnecting = true;

  try {
    if (client) {
      try {
        client.removeAllListeners();
      } catch {}
      try {
        await client.disconnect();
      } catch {}
    }

    client = createClient();
    bindClientEvents(client);

    console.log('==================================================');
    console.log('🤖 BOT STARTING');
    console.log('BOT_USERNAME =', BOT_USERNAME);
    console.log('API =', API);
    console.log('CHANNELS =', CHANNELS.join(', '));
    console.log('ADD_SONG_USERS =', ADD_SONG_USERS.join(', '));
    console.log('==================================================');

    await client.connect();
    lastConnectAt = Date.now();
    touchIrcActivity('connectClient');
  } catch (err) {
    console.error('❌ Twitch connect error:', err);
    scheduleManualReconnect('initial connect failed');
  } finally {
    isConnecting = false;
  }
}

function scheduleManualReconnect(reason = '') {
  if (shuttingDown) return;
  if (manualReconnectTimer) return;

  forcedReconnectCount += 1;
  console.warn(`⚠️ 準備手動重連... ${reason ? `(${reason})` : ''} [${forcedReconnectCount}/${MAX_FORCED_RECONNECTS}]`);

  if (forcedReconnectCount > MAX_FORCED_RECONNECTS) {
    console.error('💥 強制重連次數過多，process.exit(1) 交給 Railway 自動重啟');
    process.exit(1);
    return;
  }

  manualReconnectTimer = setTimeout(async () => {
    manualReconnectTimer = null;

    try {
      if (client) {
        try {
          await client.disconnect();
        } catch {}
      }
    } catch {}

    await connectClient();
  }, MANUAL_RECONNECT_DELAY_MS);
}

function resetForcedReconnectCount() {
  forcedReconnectCount = 0;
}

function bindClientEvents(c) {
  c.on('connected', (address, port) => {
    touchIrcActivity('connected');
    resetForcedReconnectCount();
    console.log(`✅ Connected to ${address}:${port}`);
    console.log('✅ Joined channels:', CHANNELS.map(ch => `#${ch}`).join(', '));
  });

  c.on('disconnected', reason => {
    lastDisconnectAt = Date.now();
    console.error('⚠️ Disconnected:', reason);
    scheduleManualReconnect(String(reason || 'disconnected'));
  });

  c.on('reconnect', () => {
    touchIrcActivity('reconnect');
    console.log('♻️ tmi reconnecting...');
  });

  c.on('join', (channel, username, self) => {
    touchIrcActivity('join');
    if (self) {
      console.log(`➡️ Joined ${channel} as ${username}`);
    }
  });

  c.on('part', (channel, username, self) => {
    touchIrcActivity('part');
    if (self) {
      console.log(`⬅️ Parted ${channel} as ${username}`);
    }
  });

  c.on('notice', (channel, msgid, message) => {
    touchIrcActivity('notice');
    console.log(`📣 NOTICE [${normalizeChannel(channel)}] ${msgid || ''} ${message || ''}`);
  });

  c.on('message', async (channel, tags, message, self) => {
    touchIrcActivity('message');
    if (self) return;

    const user = cleanText(tags?.username || '');
    const text = cleanText(message);
    lastMessageAt = Date.now();

    console.log(`[MSG] ${channel} <${user}> ${text}`);

    if (!text.startsWith('!')) return;

    if (text.startsWith('!點歌 ')) {
      const raw = cleanText(text.slice('!點歌 '.length));
      if (!raw) return;

      enqueueTask(async () => {
        const url = buildApiUrl('chat_suggest', {
          user,
          q: raw,
          channel: normalizeChannel(channel),
        });
        await callApiAndReply(channel, user, url);
      });
      return;
    }

    if (text === '!點歌') {
      await safeSay(channel, `@${user} 請輸入歌名，例如：!點歌 我喜歡你`);
      return;
    }

    if (text.startsWith('!新增點歌 ')) {
      if (!isAddSongAllowed(tags)) {
        await safeSay(channel, `@${user} 你沒有權限使用 !新增點歌`);
        return;
      }

      const raw = cleanText(text.slice('!新增點歌 '.length));
      if (!raw) return;

      enqueueTask(async () => {
        const url = buildApiUrl('chat_add', {
          user,
          q: raw,
          channel: normalizeChannel(channel),
        });
        await callApiAndReply(channel, user, url);
      });
      return;
    }

    if (text === '!新增點歌') {
      if (!isAddSongAllowed(tags)) {
        await safeSay(channel, `@${user} 你沒有權限使用 !新增點歌`);
        return;
      }
      await safeSay(channel, `@${user} 請輸入歌名，例如：!新增點歌 青花瓷`);
      return;
    }

    if (text === '!bothealth' || text === '!bot健康') {
      const h = getHealthState();
      await safeSay(
        channel,
        `@${user} bot狀態：ircIdle=${Math.floor(h.ircIdleMs / 1000)}秒 queue=${taskQueue.length} reconnect=${h.forcedReconnectCount}`
      );
      return;
    }

    if (text === '!botreconnect') {
      const username = user.toLowerCase();
      const badges = tags?.badges || {};
      const isBroadcaster = badges?.broadcaster === '1';
      const isMod = tags?.mod === true || badges?.moderator === '1';

      if (!isBroadcaster && !isMod) {
        await safeSay(channel, `@${user} 你沒有權限使用 !botreconnect`);
        return;
      }

      await safeSay(channel, `@${user} 收到，bot 準備重連`);
      scheduleManualReconnect(`manual by ${user}`);
      return;
    }
  });

  c.on('raw_message', () => {
    touchIrcActivity('raw_message');
  });

  c.on('pong', () => {
    touchIrcActivity('pong');
  });

  c.on('error', err => {
    console.error('❌ Twitch client error:', err);
  });
}

/* =========================================================
 * API
 * ========================================================= */
async function fetchWithTimeout(url, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });

    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: cleanText(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callApiAndReply(channel, username, url) {
  try {
    console.log('➡️ API URL =', url);

    const result = await fetchWithTimeout(url, API_TIMEOUT_MS);

    console.log('⬅️ API status =', result.status);
    console.log('⬅️ API text =', result.text);

    if (!result.ok) {
      lastApiErrorAt = Date.now();
      await safeSay(channel, `@${username} 系統錯誤`);
      return;
    }

    if (!result.text) {
      lastApiErrorAt = Date.now();
      await safeSay(channel, `@${username} 系統沒有回應內容`);
      return;
    }

    lastApiSuccessAt = Date.now();
    await safeSay(channel, result.text);
  } catch (err) {
    lastApiErrorAt = Date.now();

    if (err?.name === 'AbortError') {
      console.error('⏰ API timeout');
      await safeSay(channel, `@${username} 系統忙碌中，請稍後再試`);
      return;
    }

    console.error('❌ API error:', err);
    await safeSay(channel, `@${username} 系統錯誤`);
  }
}

/* =========================================================
 * 發送訊息
 * ========================================================= */
async function safeSay(channel, message) {
  if (!client) return;

  cleanupRecentReplies();

  const finalMessage = truncateMessage(message);

  if (hasRecentSameReply(channel, finalMessage)) {
    // 避免 Twitch 30 秒內相同訊息被吃掉
    const alt = truncateMessage(`${finalMessage} .`);
    try {
      await client.say(channel, alt);
      rememberBotReply(channel, alt);
      console.log(`[BOT] ${channel} ${alt}`);
      return;
    } catch (err) {
      console.error('❌ safeSay duplicate fallback error:', err);
      return;
    }
  }

  try {
    await client.say(channel, finalMessage);
    rememberBotReply(channel, finalMessage);
    console.log(`[BOT] ${channel} ${finalMessage}`);
  } catch (err) {
    console.error('❌ safeSay error:', err);
  }
}

/* =========================================================
 * 心跳 / watchdog
 * ========================================================= */
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(() => {
    const h = getHealthState();
    console.log(
      `💓 alive ${new Date().toISOString()} | ircIdle=${Math.floor(h.ircIdleMs / 1000)}s | queue=${taskQueue.length} | processing=${processingQueue} | reconnect=${forcedReconnectCount}`
    );
  }, 60000);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);

  watchdogTimer = setInterval(() => {
    const now = Date.now();
    const ircIdleMs = now - lastIrcActivityAt;
    const queueStuckMs = processingQueue && queueProcessingStartedAt
      ? now - queueProcessingStartedAt
      : 0;

    if (queueStuckMs > QUEUE_STUCK_LIMIT_MS) {
      console.warn(`⚠️ Queue 卡住過久：${Math.floor(queueStuckMs / 1000)} 秒`);
    }

    if (ircIdleMs > IRC_IDLE_LIMIT_MS) {
      console.error(`🚨 IRC ${Math.floor(ircIdleMs / 1000)} 秒無活動，判定可能假死，準備重連`);
      scheduleManualReconnect(`watchdog: irc idle ${ircIdleMs}ms`);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/* =========================================================
 * 關機處理
 * ========================================================= */
async function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 收到 ${signal}，準備關閉...`);

  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (manualReconnectTimer) clearTimeout(manualReconnectTimer);

    if (server) {
      await new Promise(resolve => server.close(resolve));
    }

    if (client) {
      try {
        await client.disconnect();
      } catch {}
    }
  } catch (err) {
    console.error('❌ shutdown error:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', err => {
  console.error('💥 uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', err => {
  console.error('💥 unhandledRejection:', err);
  process.exit(1);
});

/* =========================================================
 * 啟動
 * ========================================================= */
startHealthServer();
startHeartbeat();
startWatchdog();
connectClient().catch(err => {
  console.error('❌ bootstrap error:', err);
  process.exit(1);
});
