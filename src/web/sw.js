/* Bolloon 手机端 Service Worker — app-shell 缓存, 让 iPhone 可"添加到主屏幕"独立运行
 *
 * 2026-09-14 修: 原来是 cache-first + 固定缓存名 (bolloon-mobile-v1) →
 *   一旦装上, 之后每次升级 APK / 重新部署站点, WebView 里跑的仍是**旧的 mobile.js/mobile-core.js**,
 *   表现为「改了 UI 手机上没变化」「升级后还是老界面」。
 * 现在: 代码类资源 (html/js/css/json) 一律 **network-first** (拿不到网才回退缓存),
 *   缓存名带版本号, activate 时清掉所有旧缓存; 图标等静态资源仍 cache-first。
 */
const CACHE = 'bolloon-mobile-v1.1';
const SHELL = [
  './mobile.html',
  './mobile.css',
  './mobile.js',
  './mobile-core.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/favicon-192x192.png',
  './icons/favicon-512x512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 代码类资源: 必须联网拿最新的 (离线才回退缓存); 图标/manifest 之类可以 cache-first
const CODE_EXT = /\.(?:html|js|mjs|css|json|webmanifest)$/i;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  // 跨域 / API / 实时通道不缓存 (registry fetch、WebSocket 等)
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;

  if (CODE_EXT.test(url.pathname) || req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./mobile.html'))),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./mobile.html'))),
  );
});
