import tmi from 'tmi.js';
import fetch from 'node-fetch';
import http from 'http';

/* ================= 基本設定 ================= */
const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim();
const OAUTH_TOKEN = (process.env.OAUTH_TOKEN || '').trim();
const API = (process.env.API || '').trim();

const CHANNELS = (process.env.CHANNELS || '')
  .split(',')
  .map(s => s.trim().replace(/^#/, '').toLowerCase())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);

const API_TIMEOUT = 8000;
const MAX_MSG = 300;
const RETRY = 2;

/* ================= 啟動檢查 ================= */
if (!BOT_USERNAME || !OAUTH_TOKEN || !API || !CHANNELS.length) {
  console.error('❌ 環境變數缺少');
  process.exit(1);
}

/* ================= Twitch ================= */
const client = new tmi.Client({
  connection: { reconnect: true, secure: true },
  identity: { username: BOT_USERNAME, password: OAUTH_TOKEN },
  channels: CHANNELS.map(c => `#${c}`),
});

/* ================= 工具 ================= */
function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function short(msg) {
  return msg.length > MAX_MSG ? msg.slice(0, MAX_MSG) + '…' : msg;
}

function isHtml(text) {
  return text.startsWith('<!doctype') || text.startsWith('<html');
}

async function fetchApi(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, text: clean(text) };
  } finally {
    clearTimeout(timer);
  }
}

/* ================= API 呼叫（含 retry） ================= */
async function callApi(url, username) {
  for (let i = 0; i <= RETRY; i++) {
    try {
      const res = await fetchApi(url);

      if (!res.ok) continue;

      if (!res.text) return `@${username} 系統沒有回應`;

      if (isHtml(res.text)) {
        console.error('💥 GAS 回 HTML');
        return `@${username} 系統忙碌中，請再試`;
      }

      if (res.text.length > 300) {
        return `@${username} 系統回應過長，請重試`;
      }

      return res.text;
    } catch (err) {
      if (err.name === 'AbortError') {
        return `@${username} 系統忙碌中`;
      }
    }
  }

  return `@${username} 系統錯誤`;
}

/* ================= 防重複 ================= */
const lastMsg = new Map();

function canSend(channel, msg) {
  const key = channel + msg;
  const now = Date.now();
  if (lastMsg.has(key) && now - lastMsg.get(key) < 30000) {
    return false;
  }
  lastMsg.set(key, now);
  return true;
}

/* ================= 發話 ================= */
async function say(channel, msg) {
  msg = short(msg);

  if (!canSend(channel, msg)) {
    msg += ' .';
  }

  try {
    await client.say(channel, msg);
    console.log('[BOT]', msg);
  } catch (e) {
    console.error('❌ 發話失敗', e);
  }
}

/* ================= Queue ================= */
const queue = [];
let running = false;

function addTask(fn) {
  queue.push(fn);
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;

  while (queue.length) {
    const job = queue.shift();
    try {
      await job();
    } catch (e) {
      console.error('❌ 任務錯誤', e);
    }
  }

  running = false;
}

/* ================= 訊息 ================= */
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;
  const text = clean(message);

  console.log('[MSG]', user, text);

  if (!text.startsWith('!')) return;

  if (text.startsWith('!點歌 ')) {
    const q = clean(text.slice(4));

    addTask(async () => {
      const url = `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(q)}&channel=${channel.replace('#', '')}`;

      const reply = await callApi(url, user);
      await say(channel, reply);
    });
  }

  if (text === '!點歌') {
    await say(channel, `@${user} 請輸入歌名`);
  }
});

/* ================= 健康 ================= */
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT);

/* ================= 啟動 ================= */
client.connect();
console.log('🤖 BOT 啟動完成');
