import tmi from 'tmi.js';
import fetch from 'node-fetch';

const CHANNEL = process.env.CHANNEL;
const BOT_USERNAME = process.env.BOT_USERNAME;
const OAUTH_TOKEN = process.env.OAUTH_TOKEN;
const API = process.env.API;

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: BOT_USERNAME,
    password: OAUTH_TOKEN
  },
  channels: [CHANNEL]
});

client.connect();

client.on('connected', (address, port) => {
  console.log(`Connected to ${address}:${port}`);
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

      // 稍微停一下，避免太密集撞 GAS / Twitch
      await sleep(220);
    }
  } finally {
    isProcessingQueue = false;
  }
}

// ===== 可愛顏文字：避免 Twitch 擋重複訊息 =====
let emoIndex = 0;

const cuteFaces = [
  '(๑•̀ㅂ•́)و✧',
  '(｡•̀ᴗ-)✧',
  '(≧▽≦)',
  '(๑˃̵ᴗ˂̵)و',
  '(｡•ㅅ•｡)♡',
  '(づ｡◕‿‿◕｡)づ',
  '(๑>◡<๑)',
  '(｡♥‿♥｡)',
  '(๑´ڡ`๑)',
  '(≧ω≦)'
];

function makeVisibleUniqueText(text) {
  const base = String(text || '').trim();
  const face = cuteFaces[emoIndex % cuteFaces.length];
  emoIndex += 1;
  return `${base} ${face}`;
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
      const url = `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !點歌# 1
  if (msg.startsWith('!點歌#')) {
    const n = msg.replace('!點歌#', '').trim();

    enqueueTask(async () => {
      const url = `${API}?action=chat_pick&user=${encodeURIComponent(user)}&n=${encodeURIComponent(n)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !新增點歌 歌名（只限主播）
  if (msg.startsWith('!新增點歌 ')) {
    const query = msg.replace('!新增點歌 ', '').trim();
    const isBroadcaster = tags.badges && tags.badges.broadcaster === '1';

    if (!isBroadcaster) {
      return;
    }

    enqueueTask(async () => {
      const url = `${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
