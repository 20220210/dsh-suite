// 网络优先 + 离线兜底：普通刷新就能拿到最新文件，不用重装
const CACHE = 'dsh-m-137';
const SHELL = ['/m/', '/m/app.js', '/m/style.css', '/m/manifest.webmanifest', '/m/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 推送通知
self.addEventListener('push', (e) => {
  let data = { title: 'DSH', body: '' };
  try { data = e.data.json(); } catch { try { data = { title: 'DSH', body: e.data.text() }; } catch {} }
  const opts = {
    body: data.body || '',
    icon: '/m/icon-192.png',
    badge: '/m/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { sessionId: data.sessionId || null, url: data.sessionId ? '/m/?session=' + encodeURIComponent(data.sessionId) : '/m/' },
  };
  e.waitUntil(self.registration.showNotification(data.title || 'DSH', opts));
});

// 点通知：已开着的窗口直接切会话，否则打开
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const sid = e.notification.data && e.notification.data.sessionId;
  const target = e.notification.data && e.notification.data.url || '/m/';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const alive = list.find((c) => new URL(c.url).origin === location.origin);
    if (alive) {
      alive.postMessage({ type: 'open-session', sessionId: sid });
      try { await alive.focus(); } catch {}
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 认证/接口/登录跳板一律直连，不进缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_dsh/') || url.pathname.startsWith('/m/login')) return;
  if (!url.pathname.startsWith('/m/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
