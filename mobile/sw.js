// 网络优先 + 离线兜底：普通刷新就能拿到最新文件，不用重装
const CACHE = 'dsh-m-91';
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
