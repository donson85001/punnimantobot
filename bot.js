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

// ===== 排隊機制：一次只送一筆到 GAS =====
const requestQueue = [];
let isProcessingQueue = false;

// ===== 避免 Twitch 吃掉相同訊息 =====
const recentReplyCount = new Map(); // key: 原始文字, value: 次數
const recentReplyTimer = new Map();

function makeVisibleUniqueText(text) {
  const base = String(text || '').trim();
  const count = (recentReplyCount.get(base) || 0) + 1;
  recentReplyCount.set(base, count);

  // 10 秒後把這句的計數清掉，避免數字一直變大
  if (recentReplyTimer.has(base)) {
    clearTimeout(recentReplyTimer.get(base));
  }
  recentReplyTimer.set(
    base,
    setTimeout(() => {
      recentReplyCount.delete(base);
      recentReplyTimer.delete(base);
    }, 10000)
  );

  return `${base}【${count}】`;
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
      await sleep(250);
    }
  } finally {
    isProcessingQueue = false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callApiAndReply(channel, user, url) {
  try {
    const res = await fetch(url);
    const text = (await res.text()).trim();

    if (!text) return;

    // 所有回覆都做成「可見但簡短」的唯一文字
    client.say(channel, makeVisibleUniqueText(text));
  } catch (err) {
    console.error('API error:', err);
    client.say(channel, makeVisibleUniqueText(`@${user} 系統錯誤`));
  }
}

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;
  const msg = String(message || '').trim();

  if (msg.startsWith('!點歌 ')) {
    const query = msg.replace('!點歌 ', '').trim();

    enqueueTask(async () => {
      const url = `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  if (msg.startsWith('!點歌#')) {
    const n = msg.replace('!點歌#', '').trim();

    enqueueTask(async () => {
      const url = `${API}?action=chat_pick&user=${encodeURIComponent(user)}&n=${encodeURIComponent(n)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }

  if (msg.startsWith('!新增點歌 ')) {
    const query = msg.replace('!新增點歌 ', '').trim();
    const isBroadcaster = tags.badges && tags.badges.broadcaster === '1';

    if (!isBroadcaster) return;

    enqueueTask(async () => {
      const url = `${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
