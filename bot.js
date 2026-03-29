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

/* =========================
   佇列：一次只送一筆到 GAS
========================= */

const requestQueue = [];
let isProcessingQueue = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueTask(task) {
  requestQueue.push(task);
  processQueue().catch(err => {
    console.error('Queue error:', err);
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
        console.error('Task error detail:', err?.message, err?.stack);
      }

      // 放慢一點，降低 Twitch 連續發話被吃掉的機率
      await sleep(800);
    }
  } finally {
    isProcessingQueue = false;
  }
}

/* =========================
   Twitch 重複訊息避擋
========================= */

let msgSerial = 1;

function makeVisibleUniqueText(text) {
  const base = String(text || '').trim();
  if (!base) return '';

  const serial = `[${msgSerial}]`;
  msgSerial += 1;
  if (msgSerial > 9999) msgSerial = 1;

  return `${base} ${serial}`;
}

/* =========================
   工具
========================= */

function getRoomFromChannel(channel) {
  return String(channel || '').replace(/^#/, '').trim().toLowerCase();
}
function cleanQuery(q) {
  return String(q || '')
    .replace(/[，。！？、,.!?]+$/g, '')
    .trim();
}
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

async function replyToChat(channel, text) {
  const finalText = makeVisibleUniqueText(text);
  if (!finalText) return null;

  try {
    const sayResult = await client.say(channel, finalText);
    console.log('Reply sent =', { channel, finalText, sayResult });
    return sayResult;
  } catch (err1) {
    console.error('Reply send failed (1st):', err1);
    console.error('Reply send failed detail (1st):', err1?.message, err1?.stack);

    await sleep(1200);

    try {
      const retryText = makeVisibleUniqueText(text);
      const sayResult2 = await client.say(channel, retryText);
      console.log('Reply sent retry =', { channel, retryText, sayResult2 });
      return sayResult2;
    } catch (err2) {
      console.error('Reply send failed (2nd):', err2);
      console.error('Reply send failed detail (2nd):', err2?.message, err2?.stack);
      throw err2;
    }
  }
}

async function callApiAndReply(channel, user, url) {
  try {
    console.log('API request =', url);

    const text = await callApi(url);
    console.log('API response =', text);

    if (!text) {
      console.log('API response empty, skip reply');
      return;
    }

    await replyToChat(channel, text);
  } catch (err) {
    console.error('API error:', err);
    console.error('API error detail:', err?.message, err?.stack);

    try {
      await replyToChat(channel, `@${user} 系統錯誤`);
    } catch (sayErr) {
      console.error('Reply fallback error:', sayErr);
      console.error('Reply fallback detail:', sayErr?.message, sayErr?.stack);
    }
  }
}

async function runStartupHealthCheck() {
  try {
    const url = `${API}?action=health`;
    const text = await callApi(url);
    console.log('Health check result =', text);
  } catch (err) {
    console.error('Health check failed:', err);
    console.error('Health check detail:', err?.message, err?.stack);
  }
}

/* =========================
   指令監聽
========================= */

client.on('message', async (channel, tags, message, self) => {
  const user = String(tags?.username || '').trim();
  const msg = String(message || '').trim();
  const room = getRoomFromChannel(channel);

  if (!user || !msg) return;

  console.log('message event =', {
    channel,
    room,
    user,
    msg,
    self
  });

  // 防止 bot 自己送出的回覆再被自己吃到
  if (
    self &&
    !msg.startsWith('!點歌 ') &&
    !msg.startsWith('!點歌#') &&
    !msg.startsWith('!新增點歌 ')
  ) {
    return;
  }

  // !點歌 歌名
    if (msg.startsWith('!點歌 ')) {
    const raw = msg.slice('!點歌 '.length);
    const query = cleanQuery(raw);
    if (!query) return;

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_suggest` +
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

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
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&n=${encodeURIComponent(n)}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }

  // !新增點歌 歌名
  if (msg.startsWith('!新增點歌 ')) {
    const raw = msg.slice('!新增點歌 '.length);
    const query = cleanQuery(raw);
    if (!query) return;

    if (!isAllowedAddSongUser(tags)) {
      console.log('!新增點歌 blocked user =', { room, user });
      return;
    }

    enqueueTask(async () => {
      const url =
        `${API}?action=chat_add` +
        `&room=${encodeURIComponent(room)}` +
        `&user=${encodeURIComponent(user)}` +
        `&q=${encodeURIComponent(query)}`;

      await callApiAndReply(channel, user, url);
    });
    return;
  }
});

/* =========================
   事件 / 除錯
========================= */

client.on('connected', async (address, port) => {
  console.log(`Connected to ${address}:${port}`);
  console.log('CHANNELS =', CHANNELS.join(', '));
  console.log('BOT_USERNAME =', BOT_USERNAME);
  console.log('API =', API);

  await runStartupHealthCheck();
});

client.on('join', (channel, username, self) => {
  console.log('JOIN EVENT =', { channel, username, self });
});

client.on('part', (channel, username, self) => {
  console.log('PART EVENT =', { channel, username, self });
});

client.on('notice', (channel, msgid, message) => {
  console.log('NOTICE EVENT =', { channel, msgid, message });
});

client.on('disconnected', reason => {
  console.error('Disconnected:', reason);
});

client.on('reconnect', () => {
  console.log('Reconnecting...');
});

/* =========================
   啟動
========================= */

client.connect().catch(err => {
  console.error('TMI connect failed:', err);
  process.exit(1);
});
