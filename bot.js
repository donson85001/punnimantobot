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

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;
  const msg = String(message || '').trim();

  try {
    // !點歌 歌名
    if (msg.startsWith('!點歌 ')) {
      const query = msg.replace('!點歌 ', '').trim();
      const res = await fetch(
        `${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`
      );
      const text = await res.text();

      if (text) client.say(channel, text);
      return;
    }

    // !點歌# 1
    if (msg.startsWith('!點歌#')) {
      const n = msg.replace('!點歌#', '').trim();
      const res = await fetch(
        `${API}?action=chat_pick&user=${encodeURIComponent(user)}&n=${encodeURIComponent(n)}`
      );
      const text = await res.text();

      if (text) client.say(channel, text);
      return;
    }

    // !新增點歌 歌名（只限主播）
    if (msg.startsWith('!新增點歌 ')) {
      const query = msg.replace('!新增點歌 ', '').trim();

      const isBroadcaster =
        tags.badges &&
        tags.badges.broadcaster === '1';

      if (!isBroadcaster) {
        return;
      }

      const res = await fetch(
        `${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`
      );
      const text = await res.text();

      if (text) client.say(channel, text);
      return;
    }
  } catch (err) {
    console.error('Bot message handler error:', err);
    client.say(channel, `@${user} 系統錯誤`);
  }
});
