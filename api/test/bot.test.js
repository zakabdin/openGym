/* The bot's commands against a fake store and a fake Telegram: what it says, in which language, and
   what it refuses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, secretOk, webhookSecret, pickLang, COMMANDS } from '../bot.js';
import { PACKS, LANG_CODES, tr } from '../bot-i18n.js';

const TOKEN = '123456:TEST-token';
const URL_ = 'https://gym.example';

function world({ users = [], states = {}, assignments = {} } = {}) {
  const sent = [], calls = [], metaMap = new Map();
  const byId = Object.fromEntries(users.map(u => [u.id, u]));
  const store = {
    users: {
      byTg: async id => users.find(u => u.tg?.id === id) || null,
      clientsOf: async tid => users.filter(u => u.trainerId === tid),
      mutate: async (id, fn) => { const u = byId[id]; if (!u) return null; const out = fn(u); return typeof out === 'symbol' ? out : u; }
    },
    state: {
      get: async uid => states[uid] ?? null,
      update: async (uid, fn) => { const out = await fn(states[uid] ?? null); if (out && out.write) states[uid] = out.write; return out; }
    },
    assignments: { get: async uid => assignments[uid] || [] },
    meta: { get: async k => metaMap.get(k) ?? null, set: async (k, v) => { metaMap.set(k, v); } }
  };
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop(), body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'sendMessage') sent.push(body);
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  const bot = createBot({ store, token: TOKEN, appUrl: URL_, fetchImpl, log: { log() {}, error() {} }, now: () => new Date('2026-10-07T09:00:00Z') });  // a Wednesday
  const say = (text, from = {}, chat = {}) => bot.handleUpdate({ message: { text, chat: { id: from.id ?? 1, type: 'private', ...chat }, from: { id: 1, language_code: 'en', ...from } } });
  return { bot, say, sent, calls, states, users, metaMap };
}
const ana = { id: 'u1', name: 'Ana', tg: { id: 1 } };
const S = (over = {}) => ({
  unit: 'kg', weekStart: 1, langAuto: true, lang: 'en', _rev: 3,
  routines: [{ id: 'a', name: 'Push', ex: [{ id: '1' }, { id: '2' }] }, { id: 'b', name: 'Pull', ex: [{ id: '3' }] }],
  week: { 1: ['a'], 3: ['b'], 5: ['a'] }, dayPlan: {}, workouts: [], bodyweight: [], ...over
});

test('the secret header is checked, in constant time, against one derived from the token', () => {
  assert.equal(secretOk(webhookSecret(TOKEN), TOKEN), true);
  assert.equal(secretOk('nope', TOKEN), false);
  assert.equal(secretOk(undefined, TOKEN), false);
  assert.notEqual(webhookSecret(TOKEN), webhookSecret(TOKEN + 'x'));
});

test('language: the one chosen in the app wins, else Telegram\'s, else English', () => {
  assert.equal(pickLang({ langAuto: false, lang: 'de' }, 'ru'), 'de');
  assert.equal(pickLang({ langAuto: true, lang: 'en' }, 'ru'), 'ru');
  assert.equal(pickLang(null, 'pt-br'), 'pt-BR');
  assert.equal(pickLang(null, 'xx'), 'en');
  assert.equal(pickLang(null, undefined), 'en');
});

test('every language has every message, and every command is described', () => {
  const keys = Object.keys(PACKS.en);
  for (const [lang, pack] of Object.entries(PACKS)) assert.deepEqual(Object.keys(pack).sort(), keys.slice().sort(), lang);
  for (const c of COMMANDS) assert.ok(PACKS.en['cmd_' + c], c);
  assert.ok(LANG_CODES.includes('az'));
});

test('/start tells anyone what the bot does and offers the app, even without a profile', async () => {
  const w = world();
  await w.say('/start');
  const m = w.sent[0];
  assert.match(m.text, /training log/);
  assert.match(m.text, /\/plan – /);
  assert.equal(m.reply_markup.inline_keyboard[0][0].web_app.url, URL_);
});

test('a command that needs a profile says so when there is none', async () => {
  const w = world();
  await w.say('/plan');
  assert.match(w.sent[0].text, /can't find your openGym profile/);
});

test('/plan lists the week from the profile\'s own weekday, marking today', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/plan');
  const t = w.sent[0].text;
  assert.match(t, /Monday: Push/);
  assert.match(t, /▸ Wednesday: Pull/);
  assert.match(t, /Tuesday: Rest/);
  assert.ok(t.indexOf('Monday') < t.indexOf('Sunday'));
});

test('/plan with nothing planned points to the app', async () => {
  const w = world({ users: [ana], states: { u1: S({ week: {}, routines: [] }) } });
  await w.say('/plan');
  assert.match(w.sent[0].text, /No plan yet/);
});

test('/today shows the routines for today, a one-off change beating the week, and a rest day', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/today');
  assert.match(w.sent[0].text, /Pull — 1 exercise$/m);
  w.states.u1 = S({ dayPlan: { '2026-10-07': 'a' }, workouts: [{ d: '2026-10-07' }] });
  await w.say('/today');
  assert.match(w.sent[1].text, /Push — 2 exercises/);
  assert.match(w.sent[1].text, /Done today/);
  w.states.u1 = S({ week: { 1: ['a'] } });
  await w.say('/today');
  assert.match(w.sent[2].text, /Rest day today/);
});

test('/last, /progress and /weight read the history', async () => {
  const states = { u1: S({
    workouts: [
      { d: '2026-10-01', name: 'Old', entries: [] },
      { d: '2026-10-05', name: 'Push', start: 1000, end: 1000 + 45 * 60000, entries: [{}, {}], prs: [{}] }
    ],
    bodyweight: [{ d: '2026-09-20', w: 82 }, { d: '2026-10-06', w: 80.5 }]
  }) };
  const w = world({ users: [ana], states });
  await w.say('/last');
  assert.match(w.sent[0].text, /Push · /);
  assert.match(w.sent[0].text, /2 exercises · 45 min · 1 new record$/);
  await w.say('/progress');
  assert.match(w.sent[1].text, /This week: 1 of 3 planned workouts/);
  assert.match(w.sent[1].text, /2 workouts in total/);
  await w.say('/weight');
  assert.match(w.sent[2].text, /Latest: 80.5 kg/);
  assert.match(w.sent[2].text, /−1.5 kg since/);
});

test('/clients is for trainers and shows where each client stands', async () => {
  const coach = { id: 't1', name: 'Coach', tg: { id: 1 }, role: 'trainer' };
  const kids = [{ id: 'k1', name: 'Kid', trainerId: 't1' }, { id: 'k2', name: 'Kay', trainerId: 't1' }, { id: 'k3', name: 'Kim', trainerId: 't1' }];
  const w = world({
    users: [coach, ...kids], states: { t1: S() },
    assignments: { k1: [{ from: 't1', status: 'pending' }], k2: [{ from: 't1', status: 'accepted' }] }
  });
  await w.say('/clients');
  const t = w.sent[0].text;
  assert.match(t, /Kid — plan waiting/); assert.match(t, /Kay — active/); assert.match(t, /Kim — no plan yet/);
  const w2 = world({ users: [ana], states: { u1: S() } });
  await w2.say('/clients');
  assert.match(w2.sent[0].text, /for trainers/);
});

test('answers in the language of the profile, and Telegram\'s until one is chosen — Azerbaijani included', async () => {
  const w = world({ users: [ana], states: { u1: S({ langAuto: false, lang: 'de' }) } });
  await w.say('/help', { language_code: 'ru' });
  assert.match(w.sent[0].text, /^Befehle:/);
  const w2 = world({ users: [ana], states: { u1: S() } });
  await w2.say('/help', { language_code: 'az' });
  assert.match(w2.sent[0].text, /^Əmrlər:/);
  assert.match(w2.sent[0].text, /Bütün əmrlər/);
});

test('/language saves the choice in the profile, moves its revision and re-labels the menu', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/language az');
  assert.equal(w.states.u1.lang, 'az');
  assert.equal(w.states.u1.langAuto, false);
  assert.equal(w.states.u1._rev, 4);
  assert.deepEqual(w.states.u1.routines.map(r => r.id), ['a', 'b']);   // nothing else touched
  assert.match(w.sent.at(-1).text, /^Dil: Azərbaycanca/);
  const menu = w.calls.find(c => c.method === 'setMyCommands');
  assert.equal(menu.body.scope.type, 'chat');
  assert.equal(menu.body.commands.find(c => c.command === 'plan').description, tr('az', 'cmd_plan'));
});

test('/language needs a language the app speaks, and a profile that has synced once', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/language klingon');
  assert.match(w.sent[0].text, /don't speak that one/);
  assert.equal(w.states.u1.lang, 'en');
  const w2 = world({ users: [ana], states: {} });
  await w2.say('/language de');
  assert.deepEqual(w2.states, {});   // no document is invented
});

test('/reminders switches the day reminder only once the app has set a time zone; /notifications mutes the bot', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/reminders on');
  assert.match(w.sent[0].text, /Set your reminder time once in the app/);
  assert.equal(w.states.u1.reminder, undefined);
  w.states.u1 = S({ reminder: { on: false, time: '07:30', tz: 'Asia/Baku' } });
  await w.say('/reminders on');
  assert.deepEqual(w.states.u1.reminder, { on: true, time: '07:30', tz: 'Asia/Baku' });
  await w.say('/reminders off');
  assert.equal(w.states.u1.reminder.on, false);
  await w.say('/reminders maybe');
  assert.match(w.sent.at(-1).text, /Use \/reminders on or \/reminders off/);
  await w.say('/notifications off');
  assert.equal(ana.tgMute, true);
  await w.say('/notifications on');
  assert.equal(ana.tgMute, undefined);
});

test('groups, bots and plain chatter are not answered with data, and a flood is cut off', async () => {
  const w = world({ users: [ana], states: { u1: S() } });
  await w.say('/plan', {}, { type: 'group' });
  await w.bot.handleUpdate({ message: { text: '/plan', chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: true } } });
  await w.bot.handleUpdate({ callback_query: {} });
  assert.equal(w.sent.length, 0);
  await w.say('hello there');
  assert.match(w.sent[0].text, /didn't understand/);
  for (let i = 0; i < 40; i++) await w.say('/help');
  assert.ok(w.sent.length <= 21);
});

test('setup registers the webhook with its secret, the menu and description in every language — once per change', async () => {
  const w = world();
  assert.equal(await w.bot.setup({ webhookUrl: URL_ + '/api/telegram/webhook' }), true);
  const hook = w.calls.find(c => c.method === 'setWebhook').body;
  assert.equal(hook.url, URL_ + '/api/telegram/webhook');
  assert.equal(hook.secret_token, webhookSecret(TOKEN));
  assert.deepEqual(hook.allowed_updates, ['message']);
  const cmdLangs = w.calls.filter(c => c.method === 'setMyCommands').map(c => c.body.language_code);
  assert.ok(cmdLangs.includes('az') && cmdLangs.includes('pt') && cmdLangs.includes(undefined));
  assert.ok(w.calls.some(c => c.method === 'setMyDescription' && c.body.language_code === 'az'));
  assert.ok(w.calls.every(c => c.method !== 'setMyDescription' || c.body.description.length <= 512));
  assert.ok(w.calls.every(c => c.method !== 'setMyShortDescription' || c.body.short_description.length <= 120));
  const before = w.calls.length;
  assert.equal(await w.bot.setup({ webhookUrl: URL_ + '/api/telegram/webhook' }), false);   // unchanged: nothing sent
  assert.equal(w.calls.length, before);
});
