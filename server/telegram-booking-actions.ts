import { createHmac, randomBytes } from 'node:crypto'
import { TodayFailure, TODAY_TIME_ZONE } from './telegram-today.js'
import type { TodayBooking, TodayDependencies, OwnerBotAction, InlineKeyboard } from './telegram-today.js'
import { sendBookings } from './telegram-bookings.js'
export interface BookingCard extends TodayBooking { booking_id: string; status: string }
export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'not_active' | 'not_found'
export interface BookingTicket { booking_id: string; page: number; phase: 'view' | 'confirm' }
export interface BookingTickets {
  issue(ticket: BookingTicket): Promise<string>
  read(token: string, consume: boolean): Promise<BookingTicket | null>
}
export function validBookingId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
}
export function bookingTickets(env: NodeJS.ProcessEnv, botToken: string, ownerId: string, fetchImpl: typeof fetch = fetch): BookingTickets {
  const owner = createHmac('sha256', botToken).update(ownerId).digest('hex')
  const key = (token: string) => `cut-culture:telegram:action:${owner}:${token}`
  async function redis(command: unknown[]) {
    try {
      const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN
      if (!url || !token || new URL(url).protocol !== 'https:') throw new Error()
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error()
      const body = await response.json() as { result?: unknown; error?: unknown }
      if (!body || body.error || !Object.hasOwn(body, 'result')) throw new Error()
      return body.result
    } catch { throw new TodayFailure('BOT_ACTION_FAILED') }
  }
  return {
    async issue(ticket) {
      if (!validBookingId(ticket.booking_id) || !Number.isInteger(ticket.page) || ticket.page < 0 || ticket.page > 9999 || !['view', 'confirm'].includes(ticket.phase)) throw new TodayFailure('BOT_ACTION_FAILED')
      const token = randomBytes(16).toString('base64url')
      const result = await redis(['SET', key(token), JSON.stringify(ticket), 'NX', 'EX', ticket.phase === 'confirm' ? 300 : 1200])
      if (result !== 'OK') throw new TodayFailure('BOT_ACTION_FAILED')
      return token
    },
    async read(token, consume) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return null
      // GETDEL is atomic across workers and distinct button presses/updates.
      const value = await redis([consume ? 'GETDEL' : 'GET', key(token)])
      if (value === null) return null
      try {
        if (typeof value !== 'string') throw new Error()
        const ticket = JSON.parse(value) as BookingTicket
        if (!validBookingId(ticket.booking_id) || !Number.isInteger(ticket.page) || ticket.page < 0 || ticket.page > 9999 || !['view', 'confirm'].includes(ticket.phase)) throw new Error()
        return ticket
      } catch { throw new TodayFailure('BOT_ACTION_FAILED') }
    },
  }
}
const home: InlineKeyboard = { inline_keyboard: [[{ text: '📋 Все записи', callback_data: 'bookings:open' }, { text: '🏠 Главное меню', callback_data: 'menu:main' }]] }
export async function processBookingAction(action: OwnerBotAction, deps: TodayDependencies, now: number) {
  if (!deps.tickets || !deps.getBooking || !deps.cancelBooking || !action.actionToken) throw new TodayFailure('BOT_ACTION_FAILED')
  const confirm = action.bookingStep === 'confirm'
  const consume = confirm || action.bookingStep === 'reject'
  let ticket = await deps.tickets.read(action.actionToken, consume)
  if (!ticket || ticket.phase !== (consume ? 'confirm' : 'view')) {
    await deps.send(['Кнопка устарела или уже использована. Откройте запись из списка заново.'], home); return
  }
  if (confirm) {
    let outcome: CancelOutcome
    try { outcome = await deps.cancelBooking(ticket.booking_id) }
    catch {
      try { deps.reportCancellationFailure?.() } catch { /* logging must not change the result */ }
      await deps.send(['Не удалось подтвердить отмену. Запись могла измениться: проверьте её карточку перед повторной попыткой.'], home)
      return
    }
    const text = { cancelled: 'Запись отменена. Слот освобождён.', already_cancelled: 'Запись уже отменена.', not_active: 'Запись больше не активна. Отмена не выполнялась.', not_found: 'Запись не найдена. Отмена не выполнялась.' }[outcome]
    // The DB result is authoritative. Failed refresh/send cannot roll it back.
    try { await sendBookings(deps, now, ticket.page, text) }
    catch (error) {
      // Only fall back on data/action lookup errors; never repeat an ambiguous send.
      if (error instanceof TodayFailure && ['TODAY_QUERY_FAILED', 'BOT_ACTION_FAILED'].includes(error.code)) {
        await deps.send([text + '\nНе удалось обновить список. Откройте его заново.'], home); return
      }
      throw error
    }
    return
  }
  let viewToken = action.actionToken
  if (action.bookingStep === 'reject') {
    ticket = { ...ticket, phase: 'view' }
    viewToken = await deps.tickets.issue(ticket)
  }
  const card = await deps.getBooking(ticket.booking_id)
  if (!card) { await deps.send(['Запись не найдена.'], home); return }
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(card.starts_at))
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 100)
  const cardText = ['Карточка записи', `Клиент: ${clean(card.client_name)}`, `Мастер: ${clean(card.barber_name)}`, `Услуга: ${clean(card.service_name)}`, `Дата: ${date}`, `Время: ${clock.format(new Date(card.starts_at))}–${clock.format(new Date(card.ends_at))} (Москва)`].join('\n')
  if (card.status !== 'confirmed') {
    await deps.send([cardText + (card.status === 'cancelled' ? '\nЗапись уже отменена.' : '\nЗапись больше не активна.')], home); return
  }
  if (action.bookingStep === 'ask') {
    const token = await deps.tickets.issue({ ...ticket, phase: 'confirm' })
    await deps.send([cardText + '\nВы уверены, что хотите отменить эту запись?'], { inline_keyboard: [
      [{ text: '✅ Да, отменить', callback_data: `booking:confirm:${token}` }],
      [{ text: '↩️ Нет, назад', callback_data: `booking:reject:${token}` }],
    ] })
    return
  }
  await deps.send([cardText], { inline_keyboard: [[{ text: '❌ Отменить запись', callback_data: `booking:ask:${viewToken}` }], [{ text: '📋 К списку', callback_data: `bookings:page:${ticket.page}` }], [{ text: '🏠 Главное меню', callback_data: 'menu:main' }]] })
}
