// Inside Telegram the day reminder starts switched on: the bot is the only place a Mini App person is
// reminded, and they can mute it with /reminders off or in Settings. It is decided once per profile
// (`tgReminderInit`), so turning it off later sticks. A profile that already has a reminder timezone has
// chosen for itself and is left as it is. Returns the new reminder block, or null when nothing changes.
export function telegramReminderDefault(S, tz, base = { time: '08:00' }) {
  if (!tz || S.tgReminderInit) return null
  if (S.reminder?.tz) return null
  return { ...base, ...(S.reminder || {}), on: true, tz }
}
