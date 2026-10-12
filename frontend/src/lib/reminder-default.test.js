import { describe, expect, it } from 'vitest'
import { telegramReminderDefault } from './reminder-default.js'

describe('telegramReminderDefault', () => {
  it('switches the reminder on with the local timezone for a profile that never set one', () => {
    expect(telegramReminderDefault({}, 'Europe/Lisbon')).toEqual({ time: '08:00', on: true, tz: 'Europe/Lisbon' })
    expect(telegramReminderDefault({ reminder: { on: false, time: '18:30', tz: null } }, 'Asia/Baku'))
      .toEqual({ on: true, time: '18:30', tz: 'Asia/Baku' })
  })

  it('does nothing once decided, when a timezone is already stored, or when the zone is unknown', () => {
    expect(telegramReminderDefault({ tgReminderInit: true }, 'UTC')).toBeNull()
    expect(telegramReminderDefault({ reminder: { on: false, tz: 'UTC' } }, 'Europe/Lisbon')).toBeNull()
    expect(telegramReminderDefault({}, '')).toBeNull()
  })
})
