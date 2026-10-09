/* Telegram Mini App sign-in.
 *
 * Telegram hands the Mini App `initData`, a query string whose `hash` is an HMAC-SHA256 over the
 * other fields, keyed with HMAC("WebAppData", bot token). Checking it proves the fields came from
 * Telegram for *our* bot, so `user.id` can stand in for a passkey. Nothing here talks to the
 * network or to db.json; the routes, the account lookup and the audit are server.js's.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
import crypto from 'node:crypto';

// initData is signed once, when the Mini App opens. A day is long enough for a session that was
// left open overnight and short enough that a leaked string stops being a login.
export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;

const safeEq = (a, b) => {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// → { id, name, username, lang, startParam, authDate } or null when the string is not genuine.
export function verifyInitData(initData, botToken, now = Date.now(), maxAgeSec = INIT_DATA_MAX_AGE_SEC) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const mac = crypto.createHmac('sha256', key).update(check).digest('hex');
  if (!safeEq(mac, hash.toLowerCase())) return null;

  const authDate = +params.get('auth_date');
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const age = now / 1000 - authDate;
  if (age > maxAgeSec || age < -300) return null;      // stale, or from a clock far in the future

  let u;
  try { u = JSON.parse(params.get('user') || ''); } catch { return null; }
  if (!u || !Number.isSafeInteger(u.id) || u.id <= 0 || u.is_bot) return null;
  const name = [u.first_name, u.last_name].filter(x => typeof x === 'string' && x).join(' ').trim()
    || (typeof u.username === 'string' ? u.username : '') || 'Athlete';
  return {
    id: u.id,
    name: name.slice(0, 60),
    username: typeof u.username === 'string' ? u.username : null,
    lang: typeof u.language_code === 'string' ? u.language_code.slice(0, 8) : null,
    startParam: (params.get('start_param') || '').slice(0, 64),
    authDate
  };
}

// Best effort: a person who never pressed Start in the bot cannot be messaged, and that is not an
// error worth failing a request over.
export async function sendTelegramMessage(botToken, chatId, textBody, fetchImpl = fetch) {
  if (!botToken || !chatId) return false;
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(textBody).slice(0, 1000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    return r.ok;
  } catch { return false; }
}

// A file into one chat (sendDocument). Like the messages above, best effort: false when Telegram says no
// (the person never pressed Start, or blocked the bot).
export async function sendTelegramDocument(botToken, chatId, bytes, filename, caption = '', fetchImpl = fetch) {
  if (!botToken || !chatId || !bytes?.length) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    form.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30000)
    });
    return r.ok;
  } catch { return false; }
}
