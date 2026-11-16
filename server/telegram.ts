import type { BookingRow } from './bookings.js'

export const notificationCodes = [
  'TELEGRAM_CONFIG_MISSING', 'TELEGRAM_CONFIG_INVALID', 'TELEGRAM_CATALOG_FAILED',
  'TELEGRAM_TIMEOUT', 'TELEGRAM_NETWORK_FAILED', 'TELEGRAM_HTTP_FAILED',
  'TELEGRAM_RESPONSE_INVALID', 'TELEGRAM_REJECTED', 'TELEGRAM_UNEXPECTED_FAILURE',
] as const
export type NotificationCode = typeof notificationCodes[number]
export class NotificationFailure extends Error {
  constructor(public readonly code: NotificationCode) { super(code) }
}
export interface NotificationNames { barber_name: string; service_name: string }
type LookupNames = (row: BookingRow, signal: AbortSignal) => Promise<NotificationNames>
const plainName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200)
export function notificationText(row: BookingRow, names: NotificationNames): string {
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(row.starts_at))
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return [
    'Новая подтверждённая запись — CUT CULTURE',
    `Клиент: ${row.client_name}`,
    `Услуга: ${plainName(names.service_name)}`,
    `Мастер: ${plainName(names.barber_name)}`,
    `Дата: ${date}`,
    `Время: ${time.format(new Date(row.starts_at))}–${time.format(new Date(row.ends_at))} (Москва, UTC+03:00)`,
    `Телефон: ${row.client_phone}`,
  ].join('\n')
}
export function createTelegramNotifier(env: NodeJS.ProcessEnv, lookupNames: LookupNames, fetchImpl: typeof fetch = fetch) {
  return async (row: BookingRow): Promise<void> => {
    const token = env.TELEGRAM_BOT_TOKEN?.trim()
    const chatId = env.TELEGRAM_OWNER_CHAT_ID?.trim()
    if (!token || !chatId) throw new NotificationFailure('TELEGRAM_CONFIG_MISSING')
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) throw new NotificationFailure('TELEGRAM_CONFIG_INVALID')
    // One deadline for lookup + send. Awaited before returning from Vercel so that
    // the process is not frozen mid-send. No automatic retries/duplicate messages.
    const signal = AbortSignal.timeout(4000)
    let names: NotificationNames
    try {
      names = await lookupNames(row, signal)
      if (!names.barber_name?.trim() || !names.service_name?.trim()) throw new Error()
    } catch {
      throw new NotificationFailure(signal.aborted ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_CATALOG_FAILED')
    }
    let response: Response
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: notificationText(row, names), link_preview_options: { is_disabled: true } }),
        signal, redirect: 'error',
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      throw new NotificationFailure(signal.aborted || name === 'TimeoutError' || name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK_FAILED')
    }
    if (!response.ok) throw new NotificationFailure('TELEGRAM_HTTP_FAILED')
    let body: unknown
    try { body = await response.json() } catch { throw new NotificationFailure(signal.aborted ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_RESPONSE_INVALID') }
    if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') throw new NotificationFailure('TELEGRAM_RESPONSE_INVALID')
    if ((body as { ok: boolean }).ok !== true) throw new NotificationFailure('TELEGRAM_REJECTED')
    // Telegram response contains PII; do not retain, return to client or log it.
  }
}
