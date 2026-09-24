// 維護規則：CACHE_NAME 必須與 TodoMaster.html 的 APP_VERSION 一致（例如 APP_VERSION = 'v6.3.3' → 'todomaster-v6.3.3'）。
const CACHE_NAME = 'todomaster-v6.3.3';
const CACHE_PREFIX = 'todomaster-';   // 快取儲存空間是「整個網域」共用，只能動自己前綴的快取，不可碰同網域其他專案
const REPO = '/todomaster';
const HTML_URL = `${REPO}/TodoMaster.html`;
const CRITICAL = [HTML_URL, `${REPO}/manifest.json`];      // 缺一就無法離線運作：任一個失敗則安裝失敗
const OPTIONAL = [`${REPO}/icons/icon-192.png`, `${REPO}/icons/icon-512.png`];   // 圖示抓不到不該讓整個 Service Worker 裝不起來
const ASSETS = [...CRITICAL, ...OPTIONAL];
const NETWORK_TIMEOUT_MS = 4000;      // 網路太慢時先用快取，背景仍會更新快取

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:'reload' 略過瀏覽器 HTTP 快取。GitHub Pages 對所有檔案送 max-age=600，
    // 不加的話，10 分鐘內安裝新版會把「舊版」HTML 存進新快取，之後永遠讀到舊版。
    const fresh = url => new Request(url, { cache: 'reload' });
    await cache.addAll(CRITICAL.map(fresh));
    await Promise.all(OPTIONAL.map(url => cache.add(fresh(url)).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME);
    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();
    // 版本更新（有舊快取）時，讓已開啟的頁面自動改用新版重新載入；全新安裝不需要
    if (stale.length) {
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach(c => c.navigate(c.url).catch(() => {}));
    }
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // api.github.com（雲端同步）等跨來源請求交給瀏覽器，不經過 Service Worker
  if (url.pathname === HTML_URL) event.respondWith(htmlNetworkFirst(event));
  else if (ASSETS.includes(url.pathname)) event.respondWith(cacheFirst(req));
});

// HTML：網路優先。線上時永遠是最新版；離線、逾時或伺服器錯誤才用快取
async function htmlNetworkFirst(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(HTML_URL);
  let saved = Promise.resolve();
  // no-cache：每次向伺服器驗證（沒變動只回 304，很輕量），不會被 10 分鐘的 HTTP 快取騙到舊版
  const network = fetch(HTML_URL, { cache: 'no-cache' }).then(res => {
    if (res.ok) saved = cache.put(HTML_URL, res.clone()).catch(() => {});
    return res;
  });
  event.waitUntil(network.then(() => saved, () => {}));   // 即使已先回應快取，也讓 Service Worker 活到快取更新完
  if (!cached) return network;                            // 沒有快取（首次）只能等網路
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  const res = await Promise.race([network.catch(() => null), timeout]);
  return res && res.ok ? res : cached;
}

// 圖示與 manifest：很少變動，快取優先
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(req)) || fetch(req);
}
