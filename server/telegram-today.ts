import { createHash, timingSafeEqual } from 'node:crypto'

// Keep these in sync with the booking system and owner notifications.
export const TODAY_TIME_ZONE = 'Europe/Moscow'
export const TODAY_UTC_OFFSET_MINUTES = 180
export const TODAY_LIMIT = 200
export const webhookCodes = ['WEBHOOK_CONFIG_INVALID', 'TODAY_QUERY_FAILED', 'TODAY_SEND_FAILED', 'TODAY_UNEXPECTED_FAILURE'] as const
export type WebhookCode = typeof webhookCodes[number]
export class TodayFailure extends Error {
  constructor(public readonly code: WebhookCode) { super(code) }
}
export function ownerConfig(env: NodeJS.ProcessEnv) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim()
  const chatId = env.TELEGRAM_OWNER_CHAT_ID?.trim()
  const token = env.TELEGRAM_BOT_TOKEN?.trim()
  // /today is private-chat only. A private chat ID equals its owner's user ID.
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret) || !chatId || !/^[1-9]\d*$/.test(chatId) || !token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new TodayFailure('WEBHOOK_CONFIG_INVALID')
  return { secret, chatId, token }
}
export function secretMatches(actual: unknown, expected: string) {
  if (typeof actual !== 'string') return false
  const hash = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(hash(actual), hash(expected))
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function isOwnerToday(body: unknown, ownerId: string) {
  const update = object(body), message = object(update?.message), chat = object(message?.chat), from = object(message?.from)
  return !!update && Number.isSafeInteger(update.update_id) && !!message && typeof message.text === 'string'
    && /^\/today(?:@[A-Za-z0-9_]+)?\s*$/.test(message.text)
    && chat?.type === 'private' && typeof chat.id === 'number' && Number.isSafeInteger(chat.id) && String(chat.id) === ownerId
    && typeof from?.id === 'number' && Number.isSafeInteger(from.id) && String(from.id) === ownerId && from.is_bot === false
}
export function todayRange(now: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TODAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))
  const part = (type: string) => parts.find(p => p.type === type)!.value
  const date = `${part('year')}-${part('month')}-${part('day')}`
  const start = Date.parse(`${date}T00:00:00Z`) - TODAY_UTC_OFFSET_MINUTES * 60000
  return { start: new Date(start).toISOString(), end: new Date(start + 86400000).toISOString(), label: `${part('day')}.${part('month')}.${part('year')}` }
}
export interface TodayBooking { starts_at: string; client_name: string; barber_name: string; service_name: string }
const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 60)
export function todayMessages(rows: TodayBooking[], label: string, truncated = false) {
  const heading = `Записи на ${label} (Москва)\n`
  if (!rows.length) return [heading + 'На сегодня подтверждённых записей нет.']
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: TODAY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const messages: string[] = []; let message = heading
  for (const row of rows) {
    const line = `${clock.format(new Date(row.starts_at))} · ${clean(row.client_name)} · ${clean(row.service_name)} · ${clean(row.barber_name)}\n`
    if (message.length + line.length > 3500) { messages.push(message); message = heading + '(продолжение)\n' }
    message += line
  }
  if (truncated) message += `Показаны первые ${TODAY_LIMIT} записей; полный список доступен администратору в базе.`
  messages.push(message)
  return messages
}
export interface TodayDependencies {
  load(start: string, end: string): Promise<{ rows: TodayBooking[]; truncated: boolean }>
  send(messages: string[]): Promise<void>
}
export async function processToday(body: unknown, ownerId: string, deps: TodayDependencies, now = Date.now()) {
  if (!isOwnerToday(body, ownerId)) return
  const range = todayRange(now)
  const result = await deps.load(range.start, range.end)
  await deps.send(todayMessages(result.rows, range.label, result.truncated))
}
