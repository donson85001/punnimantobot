(() => {
  'use strict';

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || window.__twitchConnectionWatchdogInstalled) return;
  window.__twitchConnectionWatchdogInstalled = true;

  const CHECK_EVERY_MS = 15000;
  const STALE_AFTER_MS = 75000;
  const sockets = new Set();

  class WatchedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.__watchdogLastActivity = Date.now();
      sockets.add(this);

      const touch = () => { this.__watchdogLastActivity = Date.now(); };
      this.addEventListener('open', touch);
      this.addEventListener('message', touch);
      this.addEventListener('close', () => sockets.delete(this));
    }
  }

  window.WebSocket = WatchedWebSocket;

  setInterval(() => {
    const now = Date.now();
    for (const ws of sockets) {
      if (ws.readyState !== NativeWebSocket.OPEN) continue;
      if (now - ws.__watchdogLastActivity <= STALE_AFTER_MS) continue;

      console.warn('[watchdog] Twitch WebSocket 超過 75 秒沒有任何訊息，強制重連');
      try { ws.close(4000, 'watchdog stale connection'); } catch {}
    }
  }, CHECK_EVERY_MS);
})();
