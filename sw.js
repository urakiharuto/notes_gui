// 入口の裏方。画面のファイル（app/web・app/core・app/vendor・labkb/ui）を、非公開のリポジトリから
// GitHub の API で取って端末に残し、`./src/…` として配る。公開する場所に置くのは、この入口（index.html と sw.js）だけ。
//
// - トークンはここに残さない。取りに行くときだけ、画面（入口か、開いた画面）から受け取る
// - 取ったものは版ごとに比べ、変わったファイルだけ取り直す。新しい画面は、次に開いたときから使われる
// - 電波が無ければ、残してあるもので開く

const CACHE = 'lab-loader-v3';
const LIST = '__files.json';                    // 残してあるファイルの一覧（パス → GitHub の blob の sha）
const VERSION = '__version.json';               // 端末にある画面の版（枝・木の sha・取った時刻）
const WANT = ['app/web/', 'app/core/', 'app/vendor/', 'labkb/ui/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const SRC = new URL('./src/', self.registration.scope).pathname;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  // 更新を頼む処理が無い旧画面も取り直せるようにする。設定（localStorage）は残す。
  for (const name of await caches.keys()) {
    if (name.startsWith('lab-loader-') && name !== CACHE) await caches.delete(name);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(SRC)) return;
  e.respondWith((async () => {
    let rel = decodeURIComponent(url.pathname.slice(SRC.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const hit = await (await caches.open(CACHE)).match(SRC + rel);
    if (hit) return hit;
    if (e.request.mode === 'navigate') return Response.redirect(self.registration.scope, 302);
    return new Response('この端末にまだありません: ' + rel, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});

self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.t !== 'update') return;
  const port = e.ports[0];
  const say = (/** @type {any} */ x) => { if (port) port.postMessage(x); };
  e.waitUntil(update(m, msg => say({ t: 'progress', msg }))
    .then(changed => say({ t: 'done', changed }))
    .catch(err => say({ t: 'error', status: err.status || 0, message: String(err.message || err) })));
});

let running = null;

/** @param {{token: string, repo: string, ref?: string, api?: string}} m @param {(msg: string) => void} progress */
function update(m, progress) {
  if (!running) running = run(m, progress).finally(() => { running = null; });
  return running;
}

/** @param {{token: string, repo: string, ref?: string, api?: string}} m @param {(msg: string) => void} progress */
async function run(m, progress) {
  const api = (m.api || 'https://api.github.com').replace(/\/$/, '');
  const get = async (/** @type {string} */ p) => {
    const res = await fetch(api + p, { cache: 'no-store', headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${m.token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!res.ok) {
      let message = String(res.status);
      try { message = (await res.json()).message || message; } catch { /* 本文が JSON でない */ }
      throw Object.assign(new Error(message), { status: res.status });
    }
    return res.json();
  };
  const ref = m.ref || (await get(`/repos/${m.repo}`)).default_branch;
  const tree = await get(`/repos/${m.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.truncated) throw new Error('リポジトリが大きすぎて、ファイルの一覧を1回で取れません');
  const cache = await caches.open(CACHE);
  const oldRes = await cache.match(SRC + LIST);
  /** @type {Record<string, string>} */
  const old = oldRes ? await oldRes.json() : {};
  /** @type {Record<string, string>} */
  const now = {};
  for (const e of tree.tree) {
    if (e.type === 'blob' && WANT.some(w => e.path.startsWith(w))) now[e.path] = e.sha;
  }
  if (!now['app/web/index.html']) throw new Error(`${m.repo} に画面のファイル（app/web/）がありません`);
  const todo = Object.keys(now).filter(p => old[p] !== now[p]);
  let n = 0;
  for (const p of todo) {
    progress(`${++n}/${todo.length}`);
    const b = await get(`/repos/${m.repo}/git/blobs/${now[p]}`);
    const bytes = Uint8Array.from(atob(String(b.content).replace(/\s/g, '')), c => c.charCodeAt(0));
    const ext = (p.match(/\.[^./]+$/) || [''])[0];
    await cache.put(SRC + p, new Response(bytes, { headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream' } }));
  }
  for (const p of Object.keys(old)) if (!(p in now)) await cache.delete(SRC + p);
  await cache.put(SRC + LIST, new Response(JSON.stringify(now), { headers: { 'Content-Type': 'application/json' } }));
  // いま端末にある画面の版（設定に出す。更新が届いたかを確かめるため）
  if (todo.length || !(await cache.match(SRC + VERSION))) {
    const v = { ref, tree: String(tree.sha || '').slice(0, 7), at: new Date().toISOString() };
    await cache.put(SRC + VERSION, new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } }));
  }
  return todo.length;
}
