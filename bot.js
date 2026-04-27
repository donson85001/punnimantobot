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

const ADD_SONG_USERS = (process.env.ADD_SONG_USERS || "")
  .split(",")
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

if (!BOT_USERNAME || !OAUTH_TOKEN || !API || !CHANNELS.length) {
  console.error("BOOT_FAIL missing env");
  process.exit(1);
}

const API_TIMEOUT_MS = 9000;
const SEND_GAP_MS = 900;
let client;
let lastSendAt = 0;

function clean(v) {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function roomOf(channel) {
  return clean(channel).replace(/^#/, "").toLowerCase();
}

function isHtml(t) {
  const s = clean(t).toLowerCase();
  return s.startsWith("<!doctype") || s.startsWith("<html");
}

function buildUrl(action, params = {}) {
  const url = new URL(API);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    const s = clean(v);
    if (s) url.searchParams.set(k, s);
  }
  return url.toString();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function apiGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });

    const text = clean(await res.text());

    console.log("API_STATUS", res.status);
    console.log("API_TEXT", text.slice(0, 300));

    if (!res.ok) return "系統忙碌中，請再試";
    if (!text) return "系統沒有回應";
    if (isHtml(text)) return "系統忙碌中，請再試";
    if (text.startsWith("ERR:")) return "系統忙碌中，請再試";

    return text.slice(0, 450);
  } catch (err) {
    console.error("API_ERROR", err?.name || err);
    return "系統忙碌中，請再試";
  } finally {
    clearTimeout(timer);
  }
}

async function say(channel, msg) {
  const text = clean(msg).slice(0, 450);
  if (!text || !client) return;

  const wait = Math.max(0, SEND_GAP_MS - (Date.now() - lastSendAt));
  if (wait) await sleep(wait);

  try {
    await client.say(channel, text);
    lastSendAt = Date.now();
    console.log("BOT_SAY", channel, text);
  } catch (err) {
    console.error("SAY_FAIL", err?.message || err);
  }
}

function canAddSong(tags) {
  const user = clean(tags?.username).toLowerCase();
  const badges = tags?.badges || {};
  return (
    tags?.mod === true ||
    badges?.broadcaster === "1" ||
    badges?.moderator === "1" ||
    ADD_SONG_USERS.includes(user)
  );
}

async function handleCommand(channel, tags, message) {
  const user = clean(tags?.username);
  const text = clean(message);
  const room = roomOf(channel);

  console.log("MSG", room, user, text);

  if (text === "!bot健康" || text === "!bothealth") {
    const reply = await apiGet(buildUrl("health"));
    await say(channel, `@${user} bot在線 GAS=${reply}`);
    return;
  }

  if (text === "!點歌") {
    await say(channel, `@${user} 用法：!點歌 歌名`);
    return;
  }

  // 支援：!點歌# 1 / !點歌#1 / !點歌 #1 / !點歌 1
  let pick = text.match(/^!點歌#\s*([1-9])$/);
  if (!pick) pick = text.match(/^!點歌\s+#?([1-9])$/);

  if (pick) {
    const url = buildUrl("chat_pick", {
      user,
      room,
      n: pick[1],
    });
    const reply = await apiGet(url);
    await say(channel, reply);
    return;
  }

  if (text.startsWith("!點歌 ")) {
    const q = clean(text.slice("!點歌 ".length));
    if (!q) return;

    const url = buildUrl("chat_suggest", {
      user,
      room,
      q,
    });

    const reply = await apiGet(url);
    await say(channel, reply);
    return;
  }

  if (text === "!新增點歌") {
    await say(channel, `@${user} 用法：!新增點歌 歌名`);
    return;
  }

  if (text.startsWith("!新增點歌 ")) {
    if (!canAddSong(tags)) {
      await say(channel, `@${user} 你沒有權限使用 !新增點歌`);
      return;
    }

    const q = clean(text.slice("!新增點歌 ".length));
    if (!q) return;

    const url = buildUrl("chat_add", {
      user,
      room,
      q,
    });

    const reply = await apiGet(url);
    await say(channel, reply);
  }
}

function startHttp() {
  http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        bot: BOT_USERNAME,
        channels: CHANNELS,
        uptime: Math.floor(process.uptime()),
        time: new Date().toISOString(),
      }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  }).listen(PORT, () => {
    console.log("HTTP_READY", PORT);
  });
}

function startBot() {
  client = new tmi.Client({
    options: { debug: true, messagesLogLevel: "info" },
    connection: {
      reconnect: true,
      secure: true,
      reconnectInterval: 1000,
      maxReconnectInterval: 30000,
    },
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN,
    },
    channels: CHANNELS.map(c => `#${c}`),
  });

  client.on("connected", (addr, port) => {
    console.log("TWITCH_CONNECTED", addr, port);
    console.log("JOINED", CHANNELS.join(","));
  });

  client.on("disconnected", reason => {
    console.error("TWITCH_DISCONNECTED", reason);
  });

  client.on("notice", (channel, msgid, message) => {
    console.log("NOTICE", roomOf(channel), msgid, message);
  });

  client.on("message", async (channel, tags, message, self) => {
    if (self) return;
    const text = clean(message);
    if (!text.startsWith("!")) return;

    try {
      await handleCommand(channel, tags, text);
    } catch (err) {
      console.error("COMMAND_FAIL", err?.stack || err);
      await say(channel, `@${clean(tags?.username)} 系統忙碌中，請再試`);
    }
  });

  client.connect().catch(err => {
    console.error("CONNECT_FAIL", err?.stack || err);
    process.exit(1);
  });
}

process.on("uncaughtException", err => {
  console.error("UNCAUGHT", err?.stack || err);
  process.exit(1);
});

process.on("unhandledRejection", err => {
  console.error("UNHANDLED", err?.stack || err);
  process.exit(1);
});

console.log("BOT_BOOT");
console.log("BOT_USERNAME", BOT_USERNAME);
console.log("CHANNELS", CHANNELS.join(","));
console.log("API_READY", !!API);

startHttp();
startBot();
