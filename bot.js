import tmi from 'tmi.js';
import fetch from 'node-fetch';

const CHANNEL = puruniii;
const BOT_USERNAME = puruniiimantobot;
const OAUTH_TOKEN = thpwnsgjo1x7rvd8qpd1wcgdcjxths;
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

client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const user = tags.username;

  try {
    if (message.startsWith('!點歌 ')) {
      const query = message.replace('!點歌 ', '').trim();
      const res = await fetch(`${API}?action=chat_suggest&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`);
      const text = await res.text();
      if (text) client.say(channel, text);
      return;
    }

    if (message.startsWith('!點歌#')) {
      const n = message.replace('!點歌#', '').trim();
      const res = await fetch(`${API}?action=chat_pick&user=${encodeURIComponent(user)}&n=${encodeURIComponent(n)}`);
      const text = await res.text();
      if (text) client.say(channel, text);
      return;
    }

    if (message.startsWith('!新增點歌 ')) {
      const query = message.replace('!新增點歌 ', '').trim();
      const res = await fetch(`${API}?action=chat_add&user=${encodeURIComponent(user)}&q=${encodeURIComponent(query)}`);
      const text = await res.text();
      if (text) client.say(channel, text);
      return;
    }
  } catch (err) {
    console.error(err);
    client.say(channel, `@${user} 系統錯誤`);
  }
});
