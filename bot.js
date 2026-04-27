import tmi from "tmi.js";
import fetch from "node-fetch";
import http from "http";

const BOT_USERNAME = (process.env.BOT_USERNAME || "").trim();
const OAUTH_TOKEN = (process.env.OAUTH_TOKEN || "").trim();
const API = (process.env.API || "").trim();
const PORT = Number(process.env.PORT || 3000);

const CHANNELS = (process.env.CHANNELS || process.env.CHANNEL || "")
  .split(",")
  .map(x => x.trim().replace(/^#/, "").toLowerCase())
  .filter(Boolean);

if (!BOT_USERNAME || !OAUTH_TOKEN || !API || !CHANNELS.length) {
  console.error("BOOT_FAIL missing env");
  process.exit(1);
}

let client = null;
let reconnecting = false;
let lastMsgAt = Date.now();
let lastSendAt = 0;
let lastSend = "";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function clean(v) {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHtml(text) {
  const s = clean(text).toLowerCase();
  return s.startsWith("<!doctype") || s.startsWith("<html");
}

async function callAPI(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal
    });

    const text = clean(await res.text());

    log("API_STATUS", res.status);
    log("API_TEXT", text.slice(0, 250));

    if (!res.ok) return "系統忙碌中，請再試";
    if (!text) return "系統忙碌中，請再試";
    if (isHtml(text)) return "系統忙碌中，請再試";
    if (text.startsWith("ERR:")) return "系統忙碌中，請再試";

    return text.slice(0, 430);
  } catch (err) {
    log("API_ERROR", err?.message || err);
    return "系統忙碌中，請再試";
  } finally {
    clearTimeout(timer);
  }
}

async function say(channel, msg) {
  if (!client) return;

  let text = clean(msg).slice(0, 430);
  if (!text) return;

  if (text === lastSend) {
    text += " .";
  }

  const wait = Math.max(0, 900 - (Date.now() - lastSendAt));
  if (wait) await sleep(wait);

  try {
    await client.say(channel, text);
    lastSend = text;
    lastSendAt = Date.now();
    log("BOT_SAY", channel, text);
  } catch (err) {
    log("SAY_FAIL", err?.message || err);
  }
}

async function handle(channel, tags, message) {
  const user = clean(tags?.username || "chat");
  const room = channel.replace(/^#/, "").toLowerCase();
  const text = clean(message);

  log("CHAT_IN", room, user, text);

  if (text === "!bot健康" || text === "!bothealth") {
    const r = await callAPI(`${API}?action=health`);
    await say(channel, `@${user} bot在線 GAS=${r}`);
    return;
  }

  let pick = text.match(/^!點歌#\s*([1-9])$/);
  if (!pick) pick = text.match(/^!點歌\s+#?([1-9])$/);

  if (pick) {
    const r = await callAPI(
      `${API}?action=chat_pick&user=${encodeURIComponent(user)}&room=${encodeURIComponent(room)}&n=${encodeURIComponent(pick[1])}`
    );
    await say(channel, r);
    return;
  }

  if (text === "!點歌") {
    await say(channel, `@${user} 用法：!點歌 歌名`);
    return;
  }

  if (text.startsWith("!點歌 ")) {
    const q = clean(text.slice("!點歌 ".length));
    if (!q) return;

    const r = await callAPI(
      `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&room=${encodeURIComponent(room)}&q=${encodeURIComponent(q)}`
    );
    await say(channel, r);
    return;
  }
}

function createClient() {
  return new tmi.Client({
    options: {
      debug: true,
      messagesLogLevel: "info"
    },
    connection: {
      reconnect: true,
      secure: true,
      maxReconnectAttempts: Infinity,
      reconnectInterval: 1000,
      maxReconnectInterval: 30000
    },
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN
    },
    channels: CHANNELS.map(c => `#${c}`)
  });
}

async function forceReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;

  log("FORCE_RECONNECT", reason);

  try {
    if (client) {
      client.removeAllListeners();
      try {
        await client.disconnect();
      } catch (err) {
        log("DISCONNECT_IGNORE", err?.message || err);
      }
    }
  } catch (err) {
    log("RECONNECT_CLEANUP_ERROR", err?.message || err);
  }

  await sleep(3000);

  reconnecting = false;
  startBot();
}

function startBot() {
  log("BOT_BOOT");
  log("BOT_USERNAME", BOT_USERNAME);
  log("CHANNELS", CHANNELS.join(","));
  log("API_READY", Boolean(API));

  client = createClient();

  client.on("connected", (addr, port) => {
    lastMsgAt = Date.now();
    log("TWITCH_CONNECTED", addr, port);
    log("JOINED", CHANNELS.join(","));
  });

  client.on("join", (channel, username, self) => {
    if (self) log("SELF_JOIN", channel, username);
  });

  client.on("message", async (channel, tags, message, self) => {
    if (self) return;

    lastMsgAt = Date.now();

    try {
      await handle(channel, tags, message);
    } catch (err) {
      log("HANDLE_ERROR", err?.stack || err);
      await say(channel, `@${clean(tags?.username)} 系統忙碌中，請再試`);
    }
  });

  client.on("notice", (channel, msgid, message) => {
    log("NOTICE", channel, msgid, message);
  });

  client.on("disconnected", reason => {
    log("TWITCH_DISCONNECTED", reason);
    forceReconnect("disconnected");
  });

  client.on("error", err => {
    log("TWITCH_ERROR", err?.message || err);
  });

  client.connect().catch(err => {
    log("CONNECT_FAIL", err?.message || err);
    forceReconnect("connect_fail");
  });
}

setInterval(() => {
  const idle = Date.now() - lastMsgAt;
  log("WATCHDOG", `chat=${Math.floor(idle / 1000)}s`);

  if (idle > 5 * 60 * 1000) {
    forceReconnect(`chat_dead_${Math.floor(idle / 1000)}s`);
  }
}, 60 * 1000);

setInterval(() => {
  if (!client) return;

  Promise.resolve()
    .then(() => client.ping())
    .then(() => log("PING_OK"))
    .catch(err => {
      log("PING_FAIL", err?.message || err);
      forceReconnect("ping_fail");
    });
}, 60 * 1000);

http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      bot: BOT_USERNAME,
      channels: CHANNELS,
      chatIdleSec: Math.floor((Date.now() - lastMsgAt) / 1000),
      uptimeSec: Math.floor(process.uptime()),
      time: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => {
  log("HTTP_READY", PORT);
});

process.on("unhandledRejection", err => {
  log("UNHANDLED_REJECTION_CAUGHT", err?.message || err);
});

process.on("uncaughtException", err => {
  log("UNCAUGHT_EXCEPTION_CAUGHT", err?.stack || err);
});

startBot();
