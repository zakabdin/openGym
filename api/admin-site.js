/* The admin site: /admin.
 *
 * A small server-rendered site of its own — not part of the app — for whoever runs the instance:
 * who has signed up, who trains with whom, how much they use it, and the activity log, with
 * disable and delete. It signs in with ADMIN_USERNAME and ADMIN_PASSWORD from the environment
 * and is absent (404) while either is unset, so an instance that never asked for it has no
 * second way in.
 *
 *   - The session is a signed cookie (HttpOnly, SameSite=Strict, Path=/admin) holding an expiry
 *     and a nonce. It is signed under a prefix of its own, so a cookie of the app's can never be
 *     taken for it, and the other way round.
 *   - Every POST carries the CSRF token the page was rendered with (a MAC of the session nonce) in
 *     X-CSRF-Token, and a browser-sent Origin must be the app's own.
 *   - Wrong passwords are counted per address and paused, the way the app's own password
 *     sign-in is (rate-limit.js).
 *   - Pages are shells; the data comes from /admin/api/* as JSON and is put on the page with
 *     textContent, never as markup. The CSP allows one inline script, by nonce.
 *
 * What the actions do (disable, delete) is the app's own — server.js hands them in — so the admin
 * site and the in-app dashboard cannot disagree about what "delete" removes. */
import crypto from 'node:crypto';
import { createBackoff } from './rate-limit.js';

const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'og_admin';

const b64 = buf => Buffer.from(buf).toString('base64url');
const digest = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

export function createAdminSite({ store, secret, username, password, secure, readBody, audit, originOk, limitAddress, actions, instance = 'openGym' }) {
  const enabled = !!(username && password);
  const FAILS = createBackoff({ free: 5, baseMs: 60000, maxMs: 3600000, forgetMs: 86400000 });
  setInterval(() => FAILS.sweep(), 60000).unref();

  const mac = (kind, v) => crypto.createHmac('sha256', secret).update(`admin-site:${kind}:${v}`).digest('base64url');
  const csrfOf = nonce => mac('csrf', nonce);
  const mint = () => {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = `${Date.now() + SESSION_MS}.${nonce}`;
    return `${payload}.${mac('session', payload)}`;
  };
  const cookieOpts = `Path=/admin; HttpOnly; SameSite=Strict;${secure ? ' Secure;' : ''}`;
  const setCookie = tok => `${COOKIE}=${tok}; ${cookieOpts} Max-Age=${SESSION_MS / 1000}`;
  const clearCookie = `${COOKIE}=; ${cookieOpts} Max-Age=0`;

  // → { nonce } for a live session, else null.
  function session(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
      const tok = part.slice(i + 1).trim();
      const j = tok.lastIndexOf('.');
      if (j < 0) return null;
      const payload = tok.slice(0, j);
      try { if (!same(tok.slice(j + 1), mac('session', payload))) return null; } catch { return null; }
      const [exp, nonce] = payload.split('.');
      if (!(+exp > Date.now()) || !nonce) return null;
      return { nonce };
    }
    return null;
  }

  const headers = (type, extra = {}) => ({
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', ...extra
  });
  const send = (res, code, obj, extra) => { res.writeHead(code, headers('application/json', extra)); res.end(JSON.stringify(obj)); };
  const redirect = (res, to, extra) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...extra }); res.end(); };
  const page = (res, name, s) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, headers('text/html; charset=utf-8', {
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    }));
    res.end(layout(name, nonce, s ? csrfOf(s.nonce) : null, instance));
  };
  const who = () => ({ id: 'admin', name: username });

  const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(+v) || d));
  const wanted = id => (typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null);

  async function handle(req, res, url) {
    if (!enabled) { send(res, 404, { error: 'not found' }); return; }
    const path = url.pathname.replace(/\/+$/, '') || '/admin';
    const s = session(req);
    const post = req.method === 'POST';
    const api = path.startsWith('/admin/api/');

    // A browser-sent POST has to come from the app's own origin; the token below is on top of that.
    if (post && !originOk(req)) return send(res, 403, { error: 'cross-origin request refused' });

    if (path === '/admin/api/login' && post) {
      const addr = limitAddress(req);
      const wait = FAILS.retryAfter(addr);
      if (wait) return send(res, 429, { error: 'too many attempts — try again later', retryAfter: wait }, { 'Retry-After': String(wait) });
      const body = await readBody(req);
      const ok = same(typeof body.username === 'string' ? body.username : '', username)
        & same(typeof body.password === 'string' ? body.password : '', password);
      if (!ok) {
        const lock = FAILS.fail(addr);
        audit(req, 'admin.site.login', { ok: false, msg: lock ? 'locked' : 'bad-credentials' });
        return send(res, 401, { error: 'wrong username or password' });
      }
      FAILS.clear(addr);
      audit(req, 'admin.site.login', { user: who() });
      return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(mint()) });
    }
    if (path === '/admin/login' && req.method === 'GET') return s ? redirect(res, '/admin/overview') : page(res, 'login', null);

    // Everything below needs a session.
    if (!s) {
      if (api || post) return send(res, 401, { error: 'not signed in' });
      return redirect(res, '/admin/login');
    }
    if (post && req.headers['x-csrf-token'] !== csrfOf(s.nonce)) return send(res, 403, { error: 'invalid CSRF token' });

    if (path === '/admin/api/logout' && post) {
      audit(req, 'admin.site.logout', { user: who() });
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    }

    if (req.method === 'GET' && !api) {
      if (path === '/admin') return redirect(res, '/admin/overview');
      if (path === '/admin/overview' || path === '/admin/users' || path === '/admin/activity') return page(res, path.slice(7), s);
      if (/^\/admin\/users\/[^/]+$/.test(path)) return page(res, 'user', s);
      return send(res, 404, { error: 'not found' });
    }

    if (path === '/admin/api/overview' && req.method === 'GET') {
      const { rows } = await store.audit.page({ limit: 8 });
      return send(res, 200, { ...(await store.admin.overview()), recent: rows, now: Date.now() });
    }
    if (path === '/admin/api/users' && req.method === 'GET') {
      const q = url.searchParams;
      const role = ['trainer', 'client', 'disabled'].includes(q.get('role')) ? q.get('role') : '';
      const limit = num(q.get('limit'), 20, 1, 50);
      const pageNo = num(q.get('page'), 1, 1, 100000);
      const { items, total } = await store.admin.users({ q: (q.get('q') || '').trim().slice(0, 80), role, page: pageNo, limit });
      return send(res, 200, { items, total, page: pageNo, limit });
    }
    if (path === '/admin/api/user' && req.method === 'GET') {
      const id = wanted(url.searchParams.get('id'));
      const user = id && await store.admin.user(id);
      if (!user) return send(res, 404, { error: 'no such user' });
      return send(res, 200, {
        user, clients: await store.admin.clientsOf(id), workouts: await store.admin.recentWorkouts(id, 20),
        events: (await store.audit.page({ uid: id, limit: 30 })).rows, now: Date.now()
      });
    }
    if (path === '/admin/api/audit' && req.method === 'GET') {
      const q = url.searchParams;
      const limit = num(q.get('limit'), 50, 1, 200);
      const { rows, total } = await store.audit.page({
        cat: /^[a-z]{1,20}$/.test(q.get('cat') || '') ? q.get('cat') : '', before: +q.get('before') || null, limit,
        uid: wanted(q.get('uid'))
      });
      return send(res, 200, { events: rows, total, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
    }
    if (path === '/admin/api/user/disable' && post) {
      const body = await readBody(req);
      const id = wanted(body.id);
      const r = id ? await actions.setDisabled(id, !!body.disabled) : null;
      if (!r) return send(res, 404, { error: 'no such user' });
      audit(req, r.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: who(), target: r });
      return send(res, 200, { ok: true, id: r.id, disabled: r.disabled });
    }
    if (path === '/admin/api/user/delete' && post) {
      const body = await readBody(req);
      const id = wanted(body.id);
      const r = id ? await actions.remove(id) : null;
      if (!r) return send(res, 404, { error: 'no such user' });
      audit(req, 'admin.user.delete', { user: who(), msg: r.name });
      return send(res, 200, { ok: true, id });
    }
    return send(res, 404, { error: 'not found' });
  }

  return { enabled, handle };
}

/* ---------- the pages ---------- */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
:root { --bg:#f4f5f7; --card:#fff; --ink:#1c1f26; --mute:#6b7280; --line:#e5e7eb; --brand:#12141c; --accent:#0ea5b7; --bad:#b42318; --ok:#067647; }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1015; --card:#171a22; --ink:#e7e9ee; --mute:#9aa1ae; --line:#272b36; --brand:#0a0b10; --accent:#2dd4e6; --bad:#f97066; --ok:#47cd89; } }
* { box-sizing:border-box; margin:0; padding:0 }
body { font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--ink) }
nav { background:var(--brand); display:flex; align-items:center; gap:4px; padding:0 20px; height:54px; position:sticky; top:0; z-index:2 }
nav .brand { color:#fff; font-weight:700; font-size:17px; margin-right:24px }
nav a, nav button { color:#cfd3dc; text-decoration:none; padding:8px 14px; border-radius:8px; font:inherit; font-weight:500; background:none; border:0; cursor:pointer }
nav a:hover, nav button:hover, nav a.on { background:rgba(255,255,255,.1); color:#fff }
nav .gap { margin-left:auto }
main { max-width:1200px; margin:22px auto; padding:0 16px }
h1 { font-size:20px; margin-bottom:14px }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; overflow-x:auto }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; margin-bottom:16px }
.stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px }
.stat b { display:block; font-size:26px; line-height:1.1 }
.stat span { color:var(--mute); font-size:12px; text-transform:uppercase; letter-spacing:.04em }
.bar { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap }
input, select { padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font:inherit }
input[type=search] { flex:1; min-width:180px }
table { width:100%; border-collapse:collapse }
th { text-align:left; padding:10px 8px; border-bottom:2px solid var(--line); color:var(--mute); font-size:12px; text-transform:uppercase; letter-spacing:.03em; white-space:nowrap }
td { padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:middle }
tr:hover td { background:rgba(127,127,127,.06) }
a { color:var(--accent) }
.badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:12px; font-weight:600; background:rgba(127,127,127,.15) }
.badge.ok { color:var(--ok) } .badge.bad { color:var(--bad) }
.btn { padding:7px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font:inherit; font-weight:500; cursor:pointer }
.btn:hover { border-color:var(--accent) } .btn.danger { color:var(--bad) } .btn.primary { background:var(--accent); color:#04222a; border-color:var(--accent) }
.pager { display:flex; gap:10px; align-items:center; justify-content:center; margin-top:14px; color:var(--mute) }
.mute { color:var(--mute) } .empty { text-align:center; padding:30px; color:var(--mute) }
.kv { display:grid; grid-template-columns:140px 1fr; gap:6px 12px } .kv dt { color:var(--mute) }
.login { max-width:380px; margin:90px auto } .login label { display:block; font-weight:600; font-size:13px; margin:12px 0 4px } .login input { width:100% }
.err { color:var(--bad); margin-top:10px; min-height:20px }
@media (max-width:640px) { nav { padding:0 8px; overflow-x:auto } nav .brand { display:none } }
`;

const JS = `
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v); } for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); return n; };
const csrf = document.querySelector('meta[name=csrf]')?.content || '';
async function api(path, body) {
  const r = await fetch('/admin/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  if (r.status === 401 && !path.startsWith('login')) { location.href = '/admin/login'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || ('HTTP ' + r.status)), { status: r.status, data });
  return data;
}
const ago = (t, now = Date.now()) => { if (!t) return '—'; const s = Math.max(0, (now - t) / 1000); if (s < 90) return 'just now'; if (s < 5400) return Math.round(s / 60) + ' min ago'; if (s < 129600) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; };
const when = t => t ? new Date(t).toLocaleString() : '—';
const day = s => s ? String(s).slice(0, 10) : '—';
const tg = u => u.username ? '@' + u.username : (u.telegramId ? '#' + u.telegramId : '—');
const badge = (text, cls) => el('span', { class: 'badge ' + (cls || '') }, text);
const status = u => u.disabled ? badge('disabled', 'bad') : badge('active', 'ok');
const table = (cols, rows, empty) => rows.length ? el('table', {}, el('thead', {}, el('tr', {}, cols.map(c => el('th', {}, c)))), el('tbody', {}, rows)) : el('div', { class: 'empty' }, empty || 'Nothing here yet.');
const userLink = u => el('a', { href: '/admin/users/' + encodeURIComponent(u.id) }, u.name || u.id);

async function setDisabled(u, disabled, done) {
  if (disabled && !confirm('Disable ' + u.name + '? They are signed out and cannot sign in until you enable them again.')) return;
  try { await api('user/disable', { id: u.id, disabled }); done(); } catch (e) { alert(e.message); }
}
async function removeUser(u, done) {
  if (!confirm('Delete ' + u.name + ' and ALL their workouts, photos and sign-ins? This cannot be undone.')) return;
  if (prompt('Type the name to confirm: ' + u.name) !== u.name) return;
  try { await api('user/delete', { id: u.id }); done(); } catch (e) { alert(e.message); }
}

const pages = {
  async login() {
    const err = $('#err');
    $('#f').addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      try { await api('login', { username: $('#u').value, password: $('#p').value }); location.href = '/admin/overview'; }
      catch (x) { err.textContent = x.status === 429 ? 'Too many attempts — wait a minute.' : x.message; }
    });
  },

  async overview() {
    const d = await api('overview');
    const stat = (n, label) => el('div', { class: 'stat' }, el('b', {}, n), el('span', {}, label));
    $('#app').replaceChildren(
      el('div', { class: 'grid' },
        stat(d.users, 'Users'), stat(d.trainers, 'Trainers'), stat(d.clients, 'Clients'), stat(d.activeWeek, 'Active, 7 days'),
        stat(d.newWeek, 'New, 7 days'), stat(d.workouts, 'Workouts logged'), stat(d.push, 'Push devices'), stat(d.disabled, 'Disabled'),
        stat(d.events24h, 'Events, 24 h'), stat(d.failed24h, 'Failures, 24 h')),
      el('div', { class: 'card' }, el('h1', {}, 'Latest activity'), eventsTable(d.recent), el('p', { class: 'pager' }, el('a', { href: '/admin/activity' }, 'All activity →'))));
  },

  async users() {
    let state = { q: '', role: '', page: 1 };
    const list = el('div'); const pager = el('div', { class: 'pager' });
    const search = el('input', { type: 'search', placeholder: 'Search name, @username, Telegram id…' });
    const role = el('select', {}, [['', 'Everyone'], ['trainer', 'Trainers'], ['client', 'Clients'], ['disabled', 'Disabled']].map(([v, t]) => el('option', { value: v }, t)));
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state = { ...state, q: search.value, page: 1 }; load(); }, 250); });
    role.addEventListener('change', () => { state = { ...state, role: role.value, page: 1 }; load(); });
    $('#app').replaceChildren(el('div', { class: 'card' }, el('div', { class: 'bar' }, search, role), list, pager));
    async function load() {
      const d = await api('users?' + new URLSearchParams({ q: state.q, role: state.role, page: state.page }));
      list.replaceChildren(table(['Name', 'Telegram', 'Role', 'Trainer', 'Workouts', 'Last workout', 'Last sync', 'Joined', 'Status', ''],
        d.items.map(u => el('tr', {},
          el('td', {}, userLink(u)), el('td', {}, tg(u)), el('td', {}, u.role === 'trainer' ? badge('trainer') : '—'),
          el('td', {}, u.trainerName || '—'), el('td', {}, u.workouts), el('td', {}, day(u.lastWorkout)), el('td', {}, ago(u.lastSync, d.now)),
          el('td', {}, day(u.created)), el('td', {}, status(u)),
          el('td', {}, el('button', { class: 'btn', onclick: () => setDisabled(u, !u.disabled, load) }, u.disabled ? 'Enable' : 'Disable')))), 'No users match.'));
      const pages = Math.max(1, Math.ceil(d.total / d.limit));
      pager.replaceChildren(
        el('button', { class: 'btn', ...(d.page <= 1 ? { disabled: '' } : {}), onclick: () => { state.page--; load(); } }, '← Prev'),
        el('span', {}, d.total + ' users · page ' + d.page + ' of ' + pages),
        el('button', { class: 'btn', ...(d.page >= pages ? { disabled: '' } : {}), onclick: () => { state.page++; load(); } }, 'Next →'));
    }
    await load();
  },

  async user() {
    const id = decodeURIComponent(location.pathname.split('/').pop());
    const load = async () => {
      let d; try { d = await api('user?id=' + encodeURIComponent(id)); } catch { $('#app').replaceChildren(el('div', { class: 'card empty' }, 'No such user.')); return; }
      const u = d.user;
      const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
      $('#app').replaceChildren(...[
        el('div', { class: 'card' }, el('h1', {}, u.name, ' ', status(u), u.role === 'trainer' ? [' ', badge('trainer')] : null),
          el('dl', { class: 'kv' }, kv('Telegram', tg(u)), kv('Trainer', u.trainerName || '—'), kv('Joined', when(Date.parse(u.created))),
            kv('Last sync', when(u.lastSync)), kv('Workouts', u.workouts), kv('Last workout', day(u.lastWorkout)),
            kv('Push devices', u.push), kv('Sync revision', u.rev), kv('Id', u.id)),
          el('p', { class: 'bar', style: 'margin-top:16px' },
            el('button', { class: 'btn', onclick: () => setDisabled(u, !u.disabled, load) }, u.disabled ? 'Enable account' : 'Disable account'),
            el('button', { class: 'btn danger', onclick: () => removeUser(u, () => { location.href = '/admin/users'; }) }, 'Delete…'))),
        d.clients.length ? el('div', { class: 'card' }, el('h1', {}, 'Clients (' + d.clients.length + ')'),
          table(['Name', 'Workouts', 'Last workout', 'Last sync', 'Status'], d.clients.map(c => el('tr', {}, el('td', {}, userLink(c)), el('td', {}, c.workouts), el('td', {}, day(c.lastWorkout)), el('td', {}, ago(c.lastSync, d.now)), el('td', {}, status(c)))))) : null,
        el('div', { class: 'card' }, el('h1', {}, 'Recent workouts'),
          table(['Date', 'Workout', 'Exercises', 'Minutes', 'Volume'], d.workouts.map(w => el('tr', {}, el('td', {}, day(w.d)), el('td', {}, w.name || '—'), el('td', {}, w.exercises ?? '—'), el('td', {}, w.minutes ?? '—'), el('td', {}, w.vol ?? '—'))), 'No workouts yet.')),
        el('div', { class: 'card' }, el('h1', {}, 'Activity'), eventsTable(d.events), el('p', { class: 'pager' }, el('a', { href: '/admin/activity' }, 'All activity →')))].filter(Boolean));
    };
    await load();
  },

  async activity() {
    let cat = ''; let before = null;
    const body = el('div'); const more = el('div', { class: 'pager' });
    const filter = el('select', {}, [['', 'Everything'], ['fail', 'Failures'], ['auth', 'Sign-ins'], ['admin', 'Admin'], ['trainer', 'Trainer'], ['workout', 'Workouts']].map(([v, t]) => el('option', { value: v }, t)));
    filter.addEventListener('change', () => { cat = filter.value; before = null; body.replaceChildren(); load(); });
    $('#app').replaceChildren(el('div', { class: 'card' }, el('div', { class: 'bar' }, filter), body, more));
    async function load() {
      const d = await api('audit?' + new URLSearchParams({ cat, ...(before ? { before } : {}) }));
      const t = eventsTable(d.events, !!body.firstChild);
      if (body.firstChild) body.querySelector('tbody').append(...t.querySelectorAll('tbody tr')); else body.replaceChildren(t);
      before = d.nextBefore;
      more.replaceChildren(before ? el('button', { class: 'btn', onclick: load }, 'Older…') : el('span', {}, d.total + ' events'));
    }
    await load();
  }
};

function eventsTable(rows, bare) {
  const t = table(['Time', 'Event', 'Who', 'Detail', ''], rows.map(e => el('tr', {},
    el('td', {}, when(e.ts)), el('td', {}, e.ev), el('td', {}, e.name || '—'), el('td', { class: 'mute' }, [e.msg, e.act, e.tname ? '→ ' + e.tname : null, e.ip].filter(Boolean).join(' · ')),
    el('td', {}, e.ok ? null : badge('failed', 'bad')))), 'No events.');
  return t;
}

document.addEventListener('DOMContentLoaded', () => {
  const name = document.body.dataset.page;
  $('#logout')?.addEventListener('click', async () => { try { await api('logout', {}); } finally { location.href = '/admin/login'; } });
  pages[name]?.().catch(e => { const a = $('#app'); if (a) a.replaceChildren(el('div', { class: 'card empty' }, 'Could not load: ' + e.message)); });
});
`;

function layout(name, nonce, csrf, instance) {
  const nav = csrf ? `<nav><span class="brand">${esc(instance)} admin</span>
    ${[['overview', 'Overview'], ['users', 'Users'], ['activity', 'Activity']].map(([k, t]) => `<a href="/admin/${k}" class="${name === k || (k === 'users' && name === 'user') ? 'on' : ''}">${t}</a>`).join('')}
    <span class="gap"></span><button id="logout" type="button">Sign out</button></nav>` : '';
  const body = name === 'login'
    ? `<div class="login"><div class="card"><h1>${esc(instance)} admin</h1>
        <form id="f"><label for="u">Username</label><input id="u" autocomplete="username" required>
        <label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
        <p class="err" id="err"></p><button class="btn primary" style="width:100%;margin-top:6px">Sign in</button></form></div></div>`
    : `<main id="app"><div class="empty">Loading…</div></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${csrf ? `<meta name="csrf" content="${esc(csrf)}">` : ''}
<title>${esc(instance)} admin</title><style>${CSS}</style></head>
<body data-page="${esc(name)}">${nav}${body}<script nonce="${nonce}">${JS}</script></body></html>`;
}
