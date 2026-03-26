import tmi from 'tmi.js';
import fetch from 'node-fetch';

// ===== 環境變數 =====
const BOT_USERNAME = process.env.BOT_USERNAME;
const OAUTH_TOKEN = process.env.OAUTH_TOKEN;
const API = process.env.API;

// 支援多頻道：Railway 設 CHANNELS=channel1,channel2
const CHANNELS = (process.env.CHANNELS || process.env.CHANNEL || '')
  .split(',')
  .map(s => s.trim().replace(/^#/, '').toLowerCase())
  .filter(Boolean);

// 可使用 !新增點歌 的白名單帳號
// Railway 可設：ADD_SONG_USERS=donson85001,another_user
const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!BOT_USERNAME || !OAUTH_TOKEN || !API || CHANNELS.length === 0) {
  throw new Error('缺少必要環境變數：BOT_USERNAME / OAUTH_TOKEN / API / CHANNELS');
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
  console.log('Joined channels:', CHANNELS.join(', '));
});

// ===== 指令排隊：一次只送一筆到 GAS，減少撞鎖 =====
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


// ===== 權限判斷 =====
function isAddSongAllowed(tags) {
  const badges = tags.badges || {};
  const username = String(tags.username || '').toLowerCase();

  const isBroadcaster = badges.broadcaster === '1';
  const isMod = !!tags.mod;
  const isWhitelisted = ADD_SONG_USERS.includes(username);

  return isBroadcaster || isMod || isWhitelisted;
}

// ===== 呼叫 GAS 並回聊天室 =====
async function callApiAndReply(channel, user, url) {
  try {
    const res = await fetch(url);
    const text = (await res.text()).trim();

    if (!text) return;

    client.say(channel, makeVisibleUniqueText(text));
  } catch (err) {
    console.error('API error:', err);
    client.say(channel, makeVisibleUniqueText(`@${user} 系統錯誤`));
  }
}

// ===== 監聽聊天室 =====
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;
  const msg = String(message || '').trim();

  // !點歌 歌名
  if (msg.startsWith('!點歌 ')) {
    const query = msg.replace('!點歌 ', '').trim();

    enqueueTask(async () => {
      const url = `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}&channel=${encodeURIComponent(channel.replace('#', ''))}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !點歌# 1
  if (msg.startsWith('!點歌#')) {
    const n = msg.replace('!點歌#', '').trim();

    enqueueTask(async () => {
      const url = `${API}?action=chat_pick&user=${encodeURIComponent(user)}&n=${encodeURIComponent(n)}&channel=${encodeURIComponent(channel.replace('#', ''))}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !新增點歌 歌名（主播 / mod / 白名單）
  if (msg.startsWith('!新增點歌 ')) {
    const query = msg.replace('!新增點歌 ', '').trim();

    if (!isAddSongAllowed(tags)) {
      return;
    }

    enqueueTask(async () => {
      const url = `${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}&channel=${encodeURIComponent(channel.replace('#', ''))}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
