import { dayRange, TODAY_TIME_ZONE } from './telegram-today.js'
import type { TodayBooking, TodayDependencies, InlineKeyboard } from './telegram-today.js'
export const BOOKINGS_PAGE_SIZE = 10
export function bookingsRange(now: number) {
  const today = dayRange(now, 'today')
  const end = new Date(Date.parse(today.start) + 7 * 86400000).toISOString()
  const last = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(Date.parse(end) - 1))
  return { start: today.start, end, label: `${today.label}–${last}` }
}
const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 60)
export function bookingsPage(rows: TodayBooking[], label: string, page: number, hasNext: boolean): { text: string; keyboard: InlineKeyboard } {
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  let text = rows.length ? `Подтверждённые записи: ${label} (Москва)\nСтраница ${page + 1}\n` : page === 0 ? 'На ближайшие 7 дней записей нет' : 'На этой странице записей нет. Вернитесь назад или откройте список заново.'
  let index = 0
  let lastDate = ''
  for (const row of [...rows].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    const group = date.format(new Date(row.starts_at))
    if (group !== lastDate) { text += `\n📅 ${group}\n`; lastDate = group }
    text += `${++index}. ${time.format(new Date(row.starts_at))}–${time.format(new Date(row.ends_at))} · ${clean(row.client_name)} · ${clean(row.barber_name)} · ${clean(row.service_name)}\n`
  }
  const navigation: InlineKeyboard['inline_keyboard'][number] = []
  if (page > 0) navigation.push({ text: '⬅️ Назад', callback_data: `bookings:page:${page - 1}` })
  if (hasNext && page < 9999) navigation.push({ text: 'Вперёд ➡️', callback_data: `bookings:page:${page + 1}` })
  return { text, keyboard: { inline_keyboard: [...(navigation.length ? [navigation] : []), [{ text: '🏠 Главное меню', callback_data: 'menu:main' }]] } }
}
export async function sendBookings(deps: TodayDependencies, now: number, page = 0, notice?: string) {
  const range = bookingsRange(now)
  const result = await deps.load(range.start, range.end, { offset: page * BOOKINGS_PAGE_SIZE, limit: BOOKINGS_PAGE_SIZE })
  const response = bookingsPage(result.rows, range.label, page, result.truncated)
  const choices = deps.tickets ? await Promise.all(result.rows.map(async (row, index) => {
    if (!row.booking_id) return []
    const token = await deps.tickets!.issue({ booking_id: row.booking_id, page, phase: 'view' })
    return [{ text: `Открыть запись ${index + 1}`, callback_data: `booking:view:${token}` }]
  })) : []
  response.keyboard.inline_keyboard.unshift(...choices.filter(row => row.length))
  await deps.send([(notice ? notice + '\n\n' : '') + response.text], response.keyboard)
}
