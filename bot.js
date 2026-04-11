import tmi from 'tmi.js';
import fetch from 'node-fetch';

// ===== 環境變數 ====:contentReference[oaicite:0]{index=0} || '').trim();
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

if (!BOT_USERNAME || !OAUTH_TOKEN || !API || CHANNELS.length === 0) {
  console.error('❌ 缺少必要環境變數');
  console.error('BOT_USERNAME =', BOT_USERNAME ? 'OK' : 'MISSING');
  console.error('OAUTH_TOKEN =', OAUTH_TOKEN ? 'OK' : 'MISSING');
  console.error('API =', API ? 'OK' : 'MISSING');
  console.error('CHANNELS =', CHANNELS.length ? CHANNELS.join(', ') : 'MISSING');
  process.exit(1);
}

console.log('===== BOT STARTING =====');
console.log('BOT_USERNAME =', BOT_USERNAME);
console.log('API =', API);
console.log('CHANNELS =', CHANNELS.join(', '));
console.log('ADD_SONG_USERS =', ADD_SONG_USERS.join(', ') || '(none)');

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: BOT_USERNAME,
    password: OAUTH_TOKEN,
  },
  channels: CHANNELS,
  connection: {
    reconnect: true,
    secure: true,
  },
});

client.connect().catch(err => {
  console.error('❌ Twitch 連線失敗:', err);
  process.exit(1);
});

client.on('connected', (address, port) => {
  console.log(`✅ Connected to ${address}:${port}`);
  console.log('✅ Joined channels:', CHANNELS.join(', '));
});

client.on('disconnected', reason => {
  console.error('⚠️ Disconnected:', reason);
});

client.on('reconnect', () => {
  console.log('♻️ Reconnecting...');
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 指令排隊：一次只打一筆 API，避免撞鎖 =====
const requestQueue = [];
let isProcessingQueue = false;

function enqueueTask(task) {
  requestQueue.push(task);
  processQueue().catch(err => {
    console.error('Queue processing error:', err);
  });
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (requestQueue.length > 0) {
      const task = requestQueue.shift();
      if (!task) continue;

      try {
        await task();
      } catch (err) {
        console.error('Task error:', err);
      }

      await sleep(250);
    }
  } finally {
    isProcessingQueue = false;
  }
}

// ===== 權限判斷 =====
function isAddSongAllowed(tags) {
  const badges = tags.badges || {};
  const username = String(tags.username || '').toLowerCase();
  const isBroadcaster = badges.broadcaster === '1';
  const isMod = !!tags.mod;
  const isWhitelisted = ADD_SONG_USERS.includes(username);

  return isBroadcaster || isMod || isWhitelisted;
}

// ===== 聊天室發話（防空字串 / 防炸）=====
async function safeSay(channel, text) {
  const msg = String(text || '').trim();
  if (!msg) return;

  try {
    await client.say(channel, msg);
  } catch (err) {
    console.error('client.say error:', err);
  }
}

// ===== 呼叫 GAS 並回聊天室 =====
async function callApiAndReply(channel, user, url) {
  try {
    console.log('➡️ API URL =', url);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    const text = String(await res.text()).trim();
    console.log('⬅️ GAS status =', res.status);
    console.log('⬅️ GAS response =', text);

    if (!res.ok) {
      await safeSay(channel, `@${user} 系統錯誤`);
      return;
    }

    if (!text) {
      console.log('GAS response empty, skip chat reply.');
      return;
    }

    await safeSay(channel, text);
  } catch (err) {
    console.error('API error:', err);
    await safeSay(channel, `@${user} 系統錯誤`);
  }
}

// ===== 監聽聊天室 =====
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = String(tags.username || '').trim();
  const msg = String(message || '').trim();

  if (!user || !msg) return;

  console.log(`[MSG] ${channel} <${user}> ${msg}`);

  // !點歌 歌名
  if (msg.startsWith('!點歌 ')) {
    const query = msg.slice('!點歌 '.length).trim();
    if (!query) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_suggest` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}` +
        `&channel=${encodeURIComponent(channel.replace('#', ''))}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !點歌# 1
  if (msg.startsWith('!點歌#')) {
    const n = msg.slice('!點歌#'.length).trim();
    if (!n) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_pick` +
        `&user=${encodeURIComponent(user)}` +
        `&n=${encodeURIComponent(n)}` +
        `&channel=${encodeURIComponent(channel.replace('#', ''))}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !新增點歌 歌名
  if (msg.startsWith('!新增點歌 ')) {
    const query = msg.slice('!新增點歌 '.length).trim();
    if (!query) return;

    if (!isAddSongAllowed(tags)) {
      return;
    }

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_add` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}` +
        `&channel=${encodeURIComponent(channel.replace('#', ''))}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
