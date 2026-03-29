import tmi from 'tmi.js';
import fetch from 'node-fetch';

const CHANNELS = (process.env.CHANNELS || process.env.CHANNEL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BOT_USERNAME = process.env.BOT_USERNAME;
const OAUTH_TOKEN = process.env.OAUTH_TOKEN;
const API = process.env.API;

// 允許使用 !新增點歌 的帳號
const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || 'puruniii,manto__1109,puruniiimantobot')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!CHANNELS.length) {
  throw new Error('缺少 CHANNELS 或 CHANNEL 環境變數');
}
if (!BOT_USERNAME) {
  throw new Error('缺少 BOT_USERNAME 環境變數');
}
if (!OAUTH_TOKEN) {
  throw new Error('缺少 OAUTH_TOKEN 環境變數');
}
if (!API) {
  throw new Error('缺少 API 環境變數');
}

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: BOT_USERNAME,
    password: OAUTH_TOKEN
  },
  channels: CHANNELS
});

client.connect();

client.on('connected', (address, port) => {
  console.log(`Connected to ${address}:${port}`);
  console.log('CHANNELS =', CHANNELS.join(', '));
  console.log('API =', API);
});

/* =========================
   指令排隊：一次只送一筆，減少撞鎖
========================= */

const requestQueue = [];
let isProcessingQueue = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueTask(task) {
  requestQueue.push(task);
  processQueue().catch(err => console.error('Queue error:', err));
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

      await sleep(220);
    }
  } finally {
    isProcessingQueue = false;
  }
}

/* =========================
   避免 Twitch 重複訊息擋住
========================= */

let msgSerial = 1;

function makeVisibleUniqueText(text) {
  const base = String(text || '').trim();
  const serial = `[${msgSerial}]`;
  msgSerial += 1;
  if (msgSerial > 9999) msgSerial = 1;
  return `${base} ${serial}`;
}

/* =========================
   工具
========================= */

function isAllowedAddSongUser(tags) {
  const user = String(tags?.username || '').trim().toLowerCase();
  const isBroadcaster = tags?.badges?.broadcaster === '1';
  return isBroadcaster || ADD_SONG_USERS.includes(user);
}

async function callApi(url) {
  const res = await fetch(url);
  const text = (await res.text()).trim();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return text;
}

async function callApiAndReply(channel, user, url) {
  try {
    const text = await callApi(url);

    if (!text) return;

    client.say(channel, makeVisibleUniqueText(text));
  } catch (err) {
    console.error('API error:', err);
    client.say(channel, makeVisibleUniqueText(`@${user} 系統錯誤`));
  }
}

/* =========================
   啟動自我檢查
========================= */

async function runStartupHealthCheck() {
  try {
    const url = `${API}?action=health`;
    const text = await callApi(url);
    console.log('Health check result =', text);
  } catch (err) {
    console.error('Health check failed:', err);
  }
}

runStartupHealthCheck();

/* =========================
   指令監聽
========================= */

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = String(tags?.username || '').trim();
  const msg = String(message || '').trim();

  if (!user || !msg) return;

  // !點歌 歌名
  if (msg.startsWith('!點歌 ')) {
    const query = msg.replace('!點歌 ', '').trim();
    if (!query) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_suggest` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !點歌# 1
  if (msg.startsWith('!點歌#')) {
    const n = msg.replace('!點歌#', '').trim();
    if (!n) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_pick` +
        `&user=${encodeURIComponent(user)}` +
        `&n=${encodeURIComponent(n)}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !新增點歌 歌名
  if (msg.startsWith('!新增點歌 ')) {
    const query = msg.replace('!新增點歌 ', '').trim();
    if (!query) return;

    if (!isAllowedAddSongUser(tags)) {
      return;
    }

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_add` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
