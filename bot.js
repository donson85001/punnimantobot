let saySeq = 0;

function makeUniqueChatText(text) {
  saySeq += 1;

  // 用零寬字元，畫面看不出來，但字串不同
  const invisibleMarks = [
    '\u200B', // zero width space
    '\u200C', // zero width non-joiner
    '\u200D', // zero width joiner
    '\u2060'  // word joiner
  ];

  const mark = invisibleMarks[saySeq % invisibleMarks.length];
  const repeat = 1 + (saySeq % 3);

  return text + mark.repeat(repeat);
}
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
let busySeq = 0;

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
      await sleep(180);
    }
  } finally {
    isProcessingQueue = false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 讓重複訊息不要被 Twitch 吃掉 =====
function makeUniqueBusyMessage(text) {
  busySeq += 1;

  // 用很短的變化尾巴，讓每次訊息不同
  const suffixes = ['·1', '·2', '·3', '·4', '·5', '·6', '·7', '·8', '·9', '·0'];
  return `${text} ${suffixes[busySeq % suffixes.length]}`;
}

async function callApiAndReply(channel, user, url) {
  try {
    const res = await fetch(url);
    const text = (await res.text()).trim();

    if (!text) return;

    // 所有訊息都做成唯一，避免 Twitch 吃重複
    client.say(channel, makeUniqueChatText(text));
  } catch (err) {
    console.error('API error:', err);
    client.say(channel, makeUniqueChatText(`@${user} 系統錯誤`));
  }
}

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

    if (!isBroadcaster) return;

    enqueueTask(async () => {
      const url = `${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`;
      await callApiAndReply(channel, user, url);
    });
    return;
  }
});
