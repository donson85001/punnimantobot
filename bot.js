import tmi from 'tmi.js';
import fetch from 'node-fetch';

/* =========================================================
 * 環境變數
 * ========================================================= */
const BOT_USERNAME = String(process.env.BOT_USERNAME || '').trim();
const OAUTH_TOKEN = String(process.env.OAUTH_TOKEN || '').trim();
const API = String(process.env.API || '').trim();

const CHANNELS = (process.env.CHANNELS || process.env.CHANNEL || '')
  .split(',')
  .map(s => s.trim().replace(/^#/, '').toLowerCase())
  .filter(Boolean);

const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/* =========================================================
 * 啟動檢查
 * ========================================================= */
function requireEnv() {
  const missing = [];

  if (!BOT_USERNAME) missing.push('BOT_USERNAME');
  if (!OAUTH_TOKEN) missing.push('OAUTH_TOKEN');
  if (!API) missing.push('API');
  if (CHANNELS.length === 0) missing.push('CHANNELS');

  if (missing.length > 0) {
    console.error('❌ 缺少必要環境變數:', missing.join(', '));
    process.exit(1);
  }

  if (!OAUTH_TOKEN.startsWith('oauth:')) {
    console.warn('⚠️ OAUTH_TOKEN 看起來沒有 oauth: 前綴，請確認 Railway 設定是否正確');
  }
}

requireEnv();

console.log('==================================================');
console.log('🤖 BOT STARTING');
console.log('BOT_USERNAME =', BOT_USERNAME);
console.log('API =', API);
console.log('CHANNELS =', CHANNELS.join(', '));
console.log('ADD_SONG_USERS =', ADD_SONG_USERS.join(', ') || '(none)');
console.log('==================================================');

/* =========================================================
 * 基本工具
 * ========================================================= */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeChannel(channel) {
  return String(channel || '').replace(/^#/, '').toLowerCase();
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function safeEncode(value) {
  return encodeURIComponent(String(value ?? ''));
}

/* =========================================================
 * Twitch Client
 * ========================================================= */
let client = null;
let isConnecting = false;
let manualReconnectTimer = null;
let heartbeatTimer = null;

function createClient() {
  return new tmi.Client({
    options: {
      debug: true,
      skipUpdatingEmotesets: true,
    },
    connection: {
      reconnect: true,
      secure: true,
    },
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN,
    },
    channels: CHANNELS,
  });
}

async function connectClient() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (client) {
      try {
        client.removeAllListeners();
      } catch {}
    }

    client = createClient();
    bindClientEvents(client);

    await client.connect();
  } catch (err) {
    console.error('❌ Twitch connect error:', err);
    scheduleManualReconnect('initial connect failed');
  } finally {
    isConnecting = false;
  }
}

function scheduleManualReconnect(reason = '') {
  if (manualReconnectTimer) return;

  console.log(`🔄 準備手動重連... ${reason ? `(${reason})` : ''}`);

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
  }, 5000);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(() => {
    console.log(`💓 alive ${new Date().toISOString()}`);
  }, 60000);
}

function bindClientEvents(c) {
  c.on('connected', (address, port) => {
    console.log(`✅ Connected to ${address}:${port}`);
    console.log('✅ Joined channels:', CHANNELS.join(', '));
  });

  c.on('disconnected', reason => {
    console.error('⚠️ Disconnected:', reason);
    scheduleManualReconnect(String(reason || 'disconnected'));
  });

  c.on('reconnect', () => {
    console.log('♻️ tmi reconnecting...');
  });

  c.on('join', (channel, username, self) => {
    if (self) {
      console.log(`➡️ Joined #${normalizeChannel(channel)} as ${username}`);
    }
  });

  c.on('notice', (channel, msgid, message) => {
    console.log(`📢 NOTICE [${normalizeChannel(channel)}] ${msgid || ''} ${message || ''}`);
  });

  c.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const user = cleanText(tags?.username || '');
    const msg = cleanText(message || '');

    if (!user || !msg) return;

    console.log(`[MSG] ${channel} <${user}> ${msg}`);

    await handleChatMessage(channel, tags, msg);
  });
}

startHeartbeat();
connectClient();

/* =========================================================
 * 發話保護
 * ========================================================= */
let lastSentText = '';
let lastSentAt = 0;

async function safeSay(channel, text) {
  const msg = cleanText(text);
  if (!msg) return;

  const now = Date.now();

  // 避免太短時間發完全相同內容，被 Twitch 擋掉
  let finalMsg = msg;
  if (msg === lastSentText && now - lastSentAt < 31000) {
    finalMsg = `${msg} `;
  }

  try {
    await client.say(channel, finalMsg);
    lastSentText = msg;
    lastSentAt = now;
    console.log(`[BOT] ${channel} ${finalMsg}`);
  } catch (err) {
    console.error('❌ client.say error:', err);
  }
}

/* =========================================================
 * 指令排隊
 * ========================================================= */
const taskQueue = [];
let processingQueue = false;

function enqueueTask(task) {
  taskQueue.push(task);
  processQueue().catch(err => {
    console.error('❌ processQueue error:', err);
  });
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (taskQueue.length > 0) {
      const task = taskQueue.shift();
      if (!task) continue;

      try {
        await task();
      } catch (err) {
        console.error('❌ task error:', err);
      }

      // 稍微錯開，降低 GAS 被連打打爆
      await sleep(250);
    }
  } finally {
    processingQueue = false;
  }
}

/* =========================================================
 * 權限判斷
 * ========================================================= */
function isAddSongAllowed(tags) {
  const username = cleanText(tags?.username || '').toLowerCase();
  const badges = tags?.badges || {};
  const isBroadcaster = badges.broadcaster === '1';
  const isMod = Boolean(tags?.mod);
  const isWhitelisted = ADD_SONG_USERS.includes(username);

  return isBroadcaster || isMod || isWhitelisted;
}

/* =========================================================
 * API 呼叫
 * ========================================================= */
async function fetchWithTimeout(url, timeoutMs = 8000) {
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

    const result = await fetchWithTimeout(url, 8000);

    console.log('⬅️ API status =', result.status);
    console.log('⬅️ API text =', result.text);

    if (!result.ok) {
      await safeSay(channel, `@${username} 系統錯誤`);
      return;
    }

    if (!result.text) {
      console.log('ℹ️ API 回傳空字串，略過聊天室回覆');
      return;
    }

    await safeSay(channel, result.text);
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.error('❌ API timeout');
      await safeSay(channel, `@${username} 系統忙碌中，請稍後再試`);
      return;
    }

    console.error('❌ API error:', err);
    await safeSay(channel, `@${username} 系統錯誤`);
  }
}

/* =========================================================
 * 指令處理
 * ========================================================= */
async function handleChatMessage(channel, tags, message) {
  const user = cleanText(tags?.username || '');
  const plainChannel = normalizeChannel(channel);

  // !點歌 歌名
  if (message.startsWith('!點歌 ')) {
    const query = cleanText(message.slice('!點歌 '.length));
    if (!query) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_suggest` +
        `&user=${safeEncode(user)}` +
        `&q=${safeEncode(query)}` +
        `&channel=${safeEncode(plainChannel)}`;

      await callApiAndReply(channel, user, url);
    });

    return;
  }

  // !點歌# 1
  if (message.startsWith('!點歌#')) {
    const n = cleanText(message.slice('!點歌#'.length));
    if (!n) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_pick` +
        `&user=${safeEncode(user)}` +
        `&n=${safeEncode(n)}` +
        `&channel=${safeEncode(plainChannel)}`;

      await callApiAndReply(channel, user, url);
    });

    return;
  }

  // !新增點歌 歌名
  if (message.startsWith('!新增點歌 ')) {
    const query = cleanText(message.slice('!新增點歌 '.length));
    if (!query) return;

    if (!isAddSongAllowed(tags)) {
      return;
    }

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_add` +
        `&user=${safeEncode(user)}` +
        `&q=${safeEncode(query)}` +
        `&channel=${safeEncode(plainChannel)}`;

      await callApiAndReply(channel, user, url);
    });

    return;
  }
}

/* =========================================================
 * 未捕捉錯誤保護
 * ========================================================= */
process.on('unhandledRejection', err => {
  console.error('❌ unhandledRejection:', err);
});

process.on('uncaughtException', err => {
  console.error('❌ uncaughtException:', err);
});
