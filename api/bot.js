// The Telegram bot's side of a conversation: /start, /plan, /today and the rest, answered in the
// person's own language from what openGym already holds. Telegram delivers messages to a webhook
// (POST /api/telegram/webhook, proved by a secret header); this module only decides what to say.
//
// Read-only except a few small things the commands exist for: the language, the day reminder,
// whether the bot may message you, and a weigh-in (/weight 81.4). Nothing here touches workouts or routines.
import crypto from 'node:crypto';
import { LANG_CODES, LANG_NAMES, PACKS, matchLang, tr, telegramCode } from './bot-i18n.js';
import { ABORT } from './store.js';

// The commands, in menu order. `clients` is shown to trainers only (see `menu`) and answered with a polite
// no for everyone else. /last, /progress, /reminders and /notifications still answer when typed; they
// left the menu because /stats and /settings (with buttons) cover them.
export const COMMANDS = ['start', 'help', 'plan', 'today', 'done', 'stats', 'weight', 'clients', 'language', 'settings'];

/** The header Telegram echoes back on every webhook call; derived from the token, so no new secret to keep. */
export const webhookSecret = token => crypto.createHmac('sha256', String(token)).update('opengym-webhook').digest('hex').slice(0, 48);

/** True when `given` is the secret for `token` (constant-time). */
export function secretOk(given, token) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(webhookSecret(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The language to answer in: the one chosen in the app, else the one Telegram says the person uses.
export function pickLang(S, telegramLang) {
  if (S && S.langAuto !== true && typeof S.lang === 'string' && S.lang) return matchLang(S.lang) || 'en';
  return matchLang(telegramLang) || 'en';
}

// "Today" on the person's own clock: { date: 'YYYY-MM-DD', wd: 0..6 (0 = Sunday) }.
function todayIn(tz, now = new Date()) {
  const parts = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now);
  let p;
  try { p = parts(tz || 'UTC'); } catch { p = parts('UTC'); }
  const get = t => p.find(x => x.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) };
}
const dayName = (lang, wd) => new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + wd)));
const shortDate = (lang, d) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
const num = (lang, n) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
const idsOf = v => [].concat(v ?? []).filter(Boolean);

// The routines planned for a date: a one-off change for that date wins over the weekly plan.
function plannedFor(S, date, wd) {
  const ids = S.dayPlan && S.dayPlan[date] !== undefined ? idsOf(S.dayPlan[date]) : idsOf(S.week?.[wd]);
  const routines = list(S.routines);
  return ids.map(id => routines.find(r => r.id === id)).filter(Boolean);
}

export function createBot({ store, token, appUrl = '', fetchImpl = fetch, log = console, now = () => new Date() }) {
  const hasButton = /^https:\/\//.test(appUrl);
  const call = async (method, body) => {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { log.error?.('telegram', method, r.status, j?.description || ''); return null; }
      return j.result;
    } catch (e) { log.error?.('telegram', method, e.message); return null; }
  };
  // `pdf: 'plan' | 'today'` adds a PDF button: it opens the app on a screen that makes the PDF and
  // drops it into this chat (the PDF needs the exercise catalogue, so it is made in the app).
  // Under every reply with buttons: one tap to the next thing, in place of typing a command.
  const navRow = lang => [
    { text: '📅 ' + tr(lang, 'today'), callback_data: 'c:today' },
    { text: '📊 ' + tr(lang, 'cmd_stats'), callback_data: 'c:stats' },
    { text: '⚙️ ' + tr(lang, 'cmd_settings'), callback_data: 'c:settings' }
  ];
  const send = (chatId, text, { button, pdf, done, toggles, lang = 'en' } = {}) => call('sendMessage', {
    chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true,
    // `done`: the one button of /done — it opens the app on a screen that logs today's workout (minutes optional).
    ...(done !== undefined && hasButton ? { reply_markup: { inline_keyboard: [[
      { text: '✅ ' + tr(lang, 'doneButton'), web_app: { url: `${appUrl}/#/done${done ? '/' + done : ''}` } }
    ], navRow(lang)] } } : {}),
    ...(button && hasButton ? { reply_markup: { inline_keyboard: [[
      { text: tr(lang, 'openApp'), web_app: { url: appUrl } },
      ...(pdf ? [{ text: '📄 PDF', web_app: { url: `${appUrl}/#/pdf/${pdf}` } }] : [])
    ], ...(pdf === 'today' ? [[{ text: '✅ ' + tr(lang, 'doneButton'), callback_data: 'c:done' }]] : []), navRow(lang)] } } : {}),
    // /settings: one button per switch, answered in place (no URL, so it works without https too).
    ...(toggles ? { reply_markup: { inline_keyboard: toggles.map(([text, data]) => [{ text, callback_data: data }]) } } : {})
  });

  const commandList = (lang, withClients = false) => COMMANDS
    .filter(c => withClients || c !== 'clients')
    .map(c => `/${c} – ${tr(lang, 'cmd_' + c)}`).join('\n');

  // ---- the commands: each returns { text, button? } ----------------------------------------------
  const handlers = {
    async start({ lang, user }) {
      return { text: `${tr(lang, 'intro')}\n\n${commandList(lang, user?.role === 'trainer')}\n\n${tr(lang, 'tapButton')}`, button: true };
    },
    async help({ lang, user }) { return { text: `${tr(lang, 'commands')}:\n${commandList(lang, user?.role === 'trainer')}`, button: true }; },

    async plan({ lang, S }) {
      const ws = Number.isInteger(S.weekStart) ? S.weekStart : 1;
      const t = todayIn(S.reminder?.tz, now());
      const routines = list(S.routines);
      const rows = [];
      for (let i = 0; i < 7; i++) {
        const wd = (ws + i) % 7;
        const names = idsOf(S.week?.[wd]).map(id => routines.find(r => r.id === id)?.name).filter(Boolean);
        rows.push(`${wd === t.wd ? '▸ ' : '   '}${dayName(lang, wd)}: ${names.length ? names.join(' + ') : tr(lang, 'rest')}`);
      }
      const any = routines.length && Object.values(S.week || {}).some(v => idsOf(v).length);
      return { text: any ? `${tr(lang, 'week')}\n\n${rows.join('\n')}` : tr(lang, 'noPlan'), button: true, pdf: any ? 'plan' : undefined };
    },

    async today({ lang, S }) {
      const t = todayIn(S.reminder?.tz, now());
      const routines = plannedFor(S, t.date, t.wd);
      const done = list(S.workouts).some(w => w.d === t.date);
      if (!routines.length) return { text: `${tr(lang, 'today')} · ${dayName(lang, t.wd)}\n${tr(lang, 'restDay')}`, button: true };
      const lines = routines.map(r => `• ${r.name} — ${tr(lang, 'exercisesN', list(r.ex).length)}`);
      return { text: `${tr(lang, 'today')} · ${dayName(lang, t.wd)}\n${lines.join('\n')}${done ? '\n\n' + tr(lang, 'doneToday') : ''}`, button: true, pdf: 'today' };
    },

    // Logs nothing itself: the app does it on the button (it owns how a finished workout is filed — weights,
    // records), so the bot only checks there is something to log and offers the button.
    async done({ lang, S, arg }) {
      const t = todayIn(S.reminder?.tz, now());
      const routines = plannedFor(S, t.date, t.wd);
      if (!routines.length) return { text: `${tr(lang, 'today')} · ${dayName(lang, t.wd)}\n${tr(lang, 'restDay')}`, button: true };
      if (list(S.workouts).some(w => w.d === t.date)) return { text: tr(lang, 'alreadyDone'), button: true };
      const mins = /^\d{1,3}$/.test(arg) ? Number(arg) : 0;
      return { text: tr(lang, 'doneAsk', routines.map(r => r.name).join(' + ')), done: mins >= 1 && mins <= 600 ? mins : 0 };
    },

    async last({ lang, S }) {
      const w = list(S.workouts).slice(-1)[0];
      if (!w) return { text: tr(lang, 'noWorkouts'), button: true };
      const mins = w.start && w.end && w.end > w.start ? Math.round((w.end - w.start) / 60000) : 0;
      const bits = [tr(lang, 'exercisesN', list(w.entries).length)];
      if (mins > 0 && mins < 600) bits.push(tr(lang, 'minutes', mins));
      if (Array.isArray(w.prs) && w.prs.length) bits.push(tr(lang, 'prs', w.prs.length));
      return { text: `${tr(lang, 'last')}\n${w.name || ''} · ${w.d ? shortDate(lang, w.d) : ''}\n${bits.join(' · ')}`, button: true };
    },

    async progress({ lang, S }) {
      const ws = Number.isInteger(S.weekStart) ? S.weekStart : 1;
      const t = todayIn(S.reminder?.tz, now());
      const since = new Date(t.date + 'T12:00:00Z');
      since.setUTCDate(since.getUTCDate() - ((t.wd - ws + 7) % 7));
      const from = since.toISOString().slice(0, 10);
      const workouts = list(S.workouts);
      const done = workouts.filter(w => w.d >= from && w.d <= t.date).length;
      const planned = Object.values(S.week || {}).filter(v => idsOf(v).length).length;
      const head = planned ? tr(lang, 'thisWeek', done, planned) : tr(lang, 'thisWeekFree', done);
      return { text: `${head}\n${tr(lang, 'total', workouts.length)}`, button: true };
    },

    // /last, /progress and /weight in one message.
    async stats(ctx) {
      const parts = [await handlers.last(ctx), await handlers.progress(ctx), await handlers.weight({ ...ctx, arg: '' })];
      return { text: parts.map(p => p.text).join('\n\n'), button: true };
    },

    // The one thing the bot writes besides settings: `/weight 81.4` files a weigh-in for today, the way
    // the app's own "Log" button does (one entry per day, a second one replaces the first).
    async weight({ lang, S, user, arg }) {
      const logged = /^\d{1,3}(?:[.,]\d{1,2})?$/.test(arg) ? Number(arg.replace(',', '.')) : 0;
      if (logged >= 20 && logged <= 700) {
        const d = todayIn(S.reminder?.tz, now()).date;
        const out = await setState(user.id, doc => {
          const rows = list(doc.bodyweight).filter(b => b.d !== d);
          rows.push({ d, w: logged, t: Date.now() });
          rows.sort((a, b) => (a.d < b.d ? -1 : 1));
          return { ...doc, bodyweight: rows };
        });
        if (!out) return { text: tr(lang, 'notLinked'), button: true };
        return { text: tr(lang, 'weightLatest', `${num(lang, logged)} ${S.unit || 'kg'}`, shortDate(lang, d)), button: true };
      }
      const rows = list(S.bodyweight).filter(b => b.d && Number.isFinite(+b.w)).sort((a, b) => (a.d < b.d ? -1 : 1));
      if (!rows.length) return { text: tr(lang, 'weightNone'), button: true };
      const last = rows[rows.length - 1];
      const unit = S.unit || 'kg';
      let text = tr(lang, 'weightLatest', `${num(lang, +last.w)} ${unit}`, shortDate(lang, last.d));
      const cutoff = new Date(last.d + 'T12:00:00Z'); cutoff.setUTCDate(cutoff.getUTCDate() - 30);
      const base = rows.find(b => b !== last && b.d >= cutoff.toISOString().slice(0, 10));
      if (base) {
        const diff = +last.w - +base.w;
        text += `\n${tr(lang, 'weightChange', `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${num(lang, Math.abs(diff))} ${unit}`, shortDate(lang, base.d))}`;
      }
      return { text, button: true };
    },

    async clients({ lang, user }) {
      if (user.role !== 'trainer') return { text: tr(lang, 'trainersOnly') };
      const mine = await store.users.clientsOf(user.id);
      if (!mine.length) return { text: tr(lang, 'clientsNone'), button: true };
      const lines = [];
      for (const c of mine.slice(0, 40)) {
        const sent = (await store.assignments.get(c.id)).filter(a => a.from === user.id);
        const chip = sent.some(a => a.status === 'pending') ? 'chipWaiting' : sent.some(a => a.status === 'accepted') ? 'chipActive' : 'chipNone';
        lines.push(`• ${c.name} — ${tr(lang, chip)}`);
      }
      return { text: `${tr(lang, 'clients')}\n${lines.join('\n')}`, button: true };
    },

    async language({ lang, user, arg, chatId }) {
      const available = LANG_CODES.map(c => `${c} – ${LANG_NAMES[c]}`).join('\n');
      if (!arg) return { text: `${tr(lang, 'langPick')}\n${available}` };
      const code = matchLang(arg);
      if (!code || code === 'de-CH') return { text: `${tr(lang, 'langBad')}\n${available}` };
      const out = await setState(user.id, doc => ({ ...doc, lang: code, langAuto: false }));
      if (!out) return { text: tr(lang, 'notLinked'), button: true };
      // The command menu follows the language that was just chosen, for this chat.
      call('setMyCommands', { commands: menu(code, user.role === 'trainer'), scope: { type: 'chat', chat_id: chatId } });
      return { text: tr(code, 'langSet', LANG_NAMES[code]), lang: code };
    },

    async reminders({ lang, user, arg, S }) {
      const want = String(arg || '').toLowerCase();
      if (want !== 'on' && want !== 'off') return { text: tr(lang, 'usageOnOff', '/reminders') };
      // A reminder is owed at a time on the person's own clock, which only the app knows.
      if (want === 'on' && !S.reminder?.tz) return { text: tr(lang, 'remindersSetup'), button: true };
      const out = await setState(user.id, doc => ({ ...doc, reminder: { ...(doc.reminder || {}), on: want === 'on' } }));
      if (!out) return { text: tr(lang, 'notLinked'), button: true };
      return { text: tr(lang, want === 'on' ? 'remindersOn' : 'remindersOff') };
    },

    // The two switches in one place: a message with a button for each, answered by flipping it.
    async settings({ lang, user, S, arg }) {
      if (arg === 'reminders' || arg === 'notifications') {
        const fresh = (await store.state.get(user.id)) || S;
        const flip = arg === 'reminders'
          ? (fresh.reminder?.on ? 'off' : 'on') : (user.tgMute ? 'on' : 'off');
        const out = await handlers[arg]({ lang, user, S: fresh, arg: flip });
        if (arg === 'reminders' && out.button) return out;   // no reminder time yet: the app has to set it
        if (arg === 'notifications') user = { ...user, tgMute: flip === 'off' };
        S = (await store.state.get(user.id)) || S;
      }
      const remOn = !!S.reminder?.on, muted = !!user.tgMute;
      return {
        text: `${tr(lang, remOn ? 'remindersOn' : 'remindersOff')}\n${tr(lang, muted ? 'notifOff' : 'notifOn')}`,
        toggles: [
          [(remOn ? '🔔 ' : '🔕 ') + tr(lang, 'cmd_reminders'), 'c:settings:reminders'],
          [(muted ? '🔕 ' : '🔔 ') + tr(lang, 'cmd_notifications'), 'c:settings:notifications']
        ]
      };
    },

    async notifications({ lang, user, arg }) {
      const want = String(arg || '').toLowerCase();
      if (want !== 'on' && want !== 'off') return { text: tr(lang, 'usageOnOff', '/notifications') };
      await store.users.mutate(user.id, u => { if (want === 'off') u.tgMute = true; else if (u.tgMute) delete u.tgMute; else return ABORT; });
      return { text: tr(lang, want === 'on' ? 'notifOn' : 'notifOff') };
    }
  };

  // A settings change goes into the profile's own document the way a sync from the app would: under
  // the profile's lock, with the revision moved on so every device pulls it. A profile that has
  // never synced has no document to change, and none is invented here.
  async function setState(uid, change) {
    const r = await store.state.update(uid, cur => {
      if (!cur || typeof cur !== 'object') return null;
      return { write: { ...change(cur), _rev: (+cur._rev || 0) + 1 } };
    });
    return r && r.write ? r.write : null;
  }

  // Commands that work without a profile.
  const OPEN = new Set(['start', 'help', 'language']);
  const hits = new Map();   // chat id → recent message times, to keep one chat from flooding the bot
  const tooFast = chatId => {
    const t = Date.now(), recent = (hits.get(chatId) || []).filter(x => t - x < 60000);
    recent.push(t); hits.set(chatId, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < 60000)) hits.delete(k);
    return recent.length > 20;
  };

  // `clients` is for trainers: the default menu leaves it out, and a trainer's own chat gets the full one.
  const menu = (lang, trainer = false) => COMMANDS.filter(c => trainer || c !== 'clients')
    .map(c => ({ command: c, description: tr(lang, 'cmd_' + c).slice(0, 256) }));

  // One command for one person, from a typed message or a button under an earlier reply.
  async function run(chatId, from, name, argText = '') {
    const user = await store.users.byTg(from.id);
    const S = user ? await store.state.get(user.id) : null;
    let lang = pickLang(S, from.language_code || user?.tg?.lang);
    if (!Object.hasOwn(handlers, name)) return void send(chatId, tr(lang, 'unknown'), { lang });
    if (!OPEN.has(name) && (!user || user.disabled || !S)) return void send(chatId, tr(lang, 'notLinked'), { button: true, lang });
    const out = await handlers[name]({ lang, user, S: S || {}, arg: String(argText).trim().split(/\s+/)[0] || '', chatId });
    if (out?.lang) lang = out.lang;
    // A trainer's menu shows /clients; everyone else's does not. Set when they say hello.
    if (user?.role === 'trainer' && (name === 'start' || name === 'help')) call('setMyCommands', { commands: menu(lang, true), scope: { type: 'chat', chat_id: chatId } });
    await send(chatId, out.text, { button: out.button, pdf: out.pdf, done: out.done, toggles: out.toggles, lang });
  }

  /** One Telegram update: a private-chat text message, or a tap on one of the buttons we put under a reply. */
  async function handleUpdate(update) {
    const q = update?.callback_query;
    if (q && q.from && !q.from.is_bot && q.message?.chat?.type === 'private' && typeof q.data === 'string') {
      call('answerCallbackQuery', { callback_query_id: q.id });   // stops the button's spinner
      const [, name, arg] = /^c:([a-z]+)(?::([a-z]+))?$/.exec(q.data) || [];
      if (!name || !Object.hasOwn(handlers, name) || tooFast(q.message.chat.id)) return;
      return run(q.message.chat.id, q.from, name, arg || '');
    }
    const m = update?.message;
    if (!m || m.chat?.type !== 'private' || !m.from || m.from.is_bot || typeof m.text !== 'string') return;
    const chatId = m.chat.id;
    if (tooFast(chatId)) return;
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(m.text.trim());
    if (!cmd) return run(chatId, m.from, '');
    return run(chatId, m.from, cmd[1].toLowerCase(), cmd[2] || '');
  }

  /**
   * Tell Telegram about the webhook, the command menu in every language, and the bot's description
   * (what a person reads before pressing Start). Safe to repeat; `signature` skips it when nothing
   * has changed since the last run.
   */
  async function setup({ webhookUrl }) {
    const signature = crypto.createHash('sha256').update(JSON.stringify([webhookUrl, appUrl, PACKS])).digest('hex');
    if (store.meta && (await store.meta.get('bot_setup')) === signature) return false;
    const langs = ['en', ...LANG_CODES.filter(c => c !== 'en')];
    const ok = [];
    for (const lang of langs) {
      const code = lang === 'en' ? undefined : telegramCode(lang);
      const extra = code ? { language_code: code } : {};
      ok.push(await call('setMyCommands', { commands: menu(lang), ...extra }));
      ok.push(await call('setMyDescription', { description: tr(lang, 'description').slice(0, 512), ...extra }));
      ok.push(await call('setMyShortDescription', { short_description: tr(lang, 'shortDescription').slice(0, 120), ...extra }));
    }
    if (hasButton) ok.push(await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'openGym', web_app: { url: appUrl } } }));
    ok.push(await call('setWebhook', { url: webhookUrl, secret_token: webhookSecret(token), allowed_updates: ['message', 'callback_query'], max_connections: 10 }));
    const all = ok.every(Boolean);
    if (all && store.meta) await store.meta.set('bot_setup', signature);
    log.log?.('bot setup', all ? 'done' : 'incomplete');
    return all;
  }

  return { handleUpdate, setup, pickLang };
}
