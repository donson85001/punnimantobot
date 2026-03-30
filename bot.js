import tmi from 'tmi.js';

const CHANNELS = (process.env.CHANNELS || process.env.CHANNEL || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const BOT_USERNAME = String(process.env.BOT_USERNAME || '').trim();
const OAUTH_TOKEN = String(process.env.OAUTH_TOKEN || '').trim();
const API = String(process.env.API || '').trim();

const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || 'puruniii,manto__1109,puruniiimantobot')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!CHANNELS.length) throw new Error('缺少 CHANNELS');
if (!BOT_USERNAME) throw new Error('缺少 BOT_USERNAME');
if (!OAUTH_TOKEN) throw new Error('缺少 OAUTH_TOKEN');
if (!API) throw new Error('缺少 API');

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: BOT_USERNAME,
    password: OAUTH_TOKEN
  },
  channels: CHANNELS
});

/* =========================
   工具
========================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRoom(channel) {
  return channel.replace('#', '');
}

function cleanQuery(q) {
  return String(q || '')
    .replace(/[，。！？、,.!?]+$/g, '')
    .trim();
}

function isAllowedAddSongUser(tags) {
  const user = String(tags?.username || '').toLowerCase();
  const isBroadcaster = tags?.badges?.broadcaster === '1';
  return isBroadcaster || ADD_SONG_USERS.includes(user);
}

/* =========================
   API 呼叫
========================= */

async function callApi(url) {
  const res = await fetch(url);
  const text = (await res.text()).trim();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return text;
}

async function safeReply(channel, text) {
  if (!text) return;

  try {
    await client.say(channel, text);
    console.log('Reply:', text);
  } catch (e) {
    console.log('Retry reply...');
    await sleep(1200);
    try {
      await client.say(channel, text);
    } catch (err) {
      console.error('Reply failed:', err);
    }
  }
}

/* =========================
   排隊（防撞鎖）
========================= */

const queue = [];
let busy = false;

function pushTask(fn) {
  queue.push(fn);
  runQueue();
}

async function runQueue() {
  if (busy) return;
  busy = true;

  while (queue.length) {
    const task = queue.shift();
    try {
      await task();
    } catch (e) {
      console.error('Task error:', e);
    }
    await sleep(800);
  }

  busy = false;
}

/* =========================
   主邏輯
========================= */

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;
  const msg = message.trim();
  const room = getRoom(channel);

  console.log('MSG:', { channel, user, msg });

  // !點歌
  if (msg.startsWith('!點歌 ')) {
    const raw = msg.slice(4);
    const query = cleanQuery(raw);
    if (!query) return;

    pushTask(async () => {
      const url =
        `${API}?action=chat_suggest` +
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

      const res = await callApi(url);
      await safeReply(channel, res);
    });

    return;
  }

  // !點歌#
  if (msg.startsWith('!點歌#')) {
    const n = msg.replace('!點歌#', '').trim();
    if (!n) return;

    pushTask(async () => {
      const url =
        `${API}?action=chat_pick` +
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&n=${encodeURIComponent(n)}`;

      const res = await callApi(url);
      await safeReply(channel, res);
    });

    return;
  }

  // !新增點歌
  if (msg.startsWith('!新增點歌 ')) {
    const raw = msg.slice(6);
    const query = cleanQuery(raw);
    if (!query) return;

    if (!isAllowedAddSongUser(tags)) {
      console.log('Blocked add:', user);
      return;
    }

    pushTask(async () => {
      const url =
        `${API}?action=chat_add` +
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

      const res = await callApi(url);
      await safeReply(channel, res);
    });

    return;
  }
});

/* =========================
   事件
========================= */

client.on('connected', (addr, port) => {
  console.log(`Connected ${addr}:${port}`);
  console.log('Channels:', CHANNELS);
});

client.connect();
