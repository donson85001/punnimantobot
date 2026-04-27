import tmi from "tmi.js";
import fetch from "node-fetch";
import http from "http";

const BOT_USERNAME = process.env.BOT_USERNAME;
const OAUTH_TOKEN = process.env.OAUTH_TOKEN;
const API = process.env.API;
const CHANNEL = process.env.CHANNELS;

const PORT = process.env.PORT || 3000;

// ===== 狀態 =====
let client;
let lastMsgAt = Date.now();
let lastPingAt = Date.now();
let reconnecting = false;

// ===== 工具 =====
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// ===== API =====
async function callAPI(url) {
  try {
    const res = await fetch(url);
    const text = (await res.text()).trim();

    if (!res.ok) return "系統忙碌中";
    if (!text) return "系統忙碌中";

    if (text.startsWith("<!doctype") || text.startsWith("<html")) {
      return "系統忙碌中";
    }

    return text.slice(0, 400);
  } catch {
    return "系統忙碌中";
  }
}

// ===== 發話（防 Twitch 擋）=====
let lastSend = "";
async function say(channel, msg) {
  if (!msg) return;

  // 防重複
  if (msg === lastSend) msg += " .";

  lastSend = msg;

  try {
    await client.say(channel, msg);
    log("BOT:", msg);
  } catch (e) {
    log("SEND_FAIL", e.message);
  }
}

// ===== 指令 =====
async function handle(channel, tags, message) {
  const user = tags.username;
  const room = channel.replace("#", "");

  log("CHAT", user, message);

  if (message === "!bot健康") {
    const r = await callAPI(`${API}?action=health`);
    return say(channel, `@${user} bot在線 ${r}`);
  }

  if (message.startsWith("!點歌 ")) {
    const q = message.slice(4).trim();
    const r = await callAPI(`${API}?action=chat_suggest&user=${user}&room=${room}&q=${encodeURIComponent(q)}`);
    return say(channel, r);
  }

  if (message.match(/^!點歌#?\s*\d/)) {
    const n = message.replace(/[^0-9]/g, "");
    const r = await callAPI(`${API}?action=chat_pick&user=${user}&room=${room}&n=${n}`);
    return say(channel, r);
  }
}

// ===== 連線 =====
function startBot() {
  log("START BOT");

  client = new tmi.Client({
    options: { debug: true },
    connection: {
      reconnect: true,
      secure: true,
      maxReconnectAttempts: Infinity
    },
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN
    },
    channels: [CHANNEL]
  });

  client.on("connected", () => {
    log("TWITCH_CONNECTED");
  });

  client.on("message", (channel, tags, msg, self) => {
    if (self) return;

    lastMsgAt = Date.now();
    handle(channel, tags, msg);
  });

  client.on("disconnected", () => {
    log("DISCONNECTED");
    forceReconnect("disconnect");
  });

  client.connect();
}

// ===== 強制重連（核心）=====
async function forceReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;

  log("RECONNECT:", reason);

  try {
    client.removeAllListeners();
    await client.disconnect();
  } catch {}

  await sleep(3000);

  reconnecting = false;
  startBot();
}

// ===== WATCHDOG（最關鍵）=====
setInterval(() => {
  const now = Date.now();

  const noChat = now - lastMsgAt;
  const noPing = now - lastPingAt;

  log("WATCHDOG", `chat=${Math.floor(noChat/1000)}s`);

  // 👉 真正判斷（重點）
  if (noChat > 120000) {
    forceReconnect("chat_dead");
  }

}, 30000);

// ===== 保活（避免 Render 降資源）=====
setInterval(() => {
  try {
    client.ping();
    lastPingAt = Date.now();
  } catch {}
}, 60000);

// ===== HTTP（防睡）=====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT);

// ===== 啟動 =====
startBot();
