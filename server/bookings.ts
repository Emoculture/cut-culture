import { BookingFailure, failureCode } from './failures.js'
import type { FailureCode } from './failures.js'
import { InvalidInput, validateInput } from '../src/integrations/booking-validation.js'
import type { BookingInput } from '../src/integrations/booking-validation.js'
import type { BookingErrorCode } from '../src/integrations/booking-errors.js'
export { InvalidInput, validateInput } from '../src/integrations/booking-validation.js'
export interface BookingRow extends BookingInput { ends_at: string; status: 'confirmed' }
export interface Repository {
  barberExists(id: string): Promise<boolean>
  serviceDuration(id: string): Promise<number | null>
  insert(row: BookingRow): Promise<{ error: { code?: string } | null }>
}
export interface Dependencies {
  origin: string
  limit(ip: string): Promise<boolean>
  repository: Repository
  now?: () => number
  reportFailure?: (code: FailureCode) => void
  reportInvalid?: (code: BookingErrorCode) => void
}
export function calculateEnd(startISO: string, duration: number, now: number): string {
  const start = Date.parse(startISO)
  if (!Number.isInteger(duration) || duration <= 0 || duration > 720) throw new BookingFailure('SERVICE_DURATION_INVALID')
  if (start <= now) throw new InvalidInput('START_IN_PAST')
  if (start > now + 180 * 86400000) throw new InvalidInput('START_TOO_FAR')
  // Moscow has a fixed UTC+03:00 offset. Both comparisons are in salon time.
  const moscow = new Date(start + 3 * 3600000)
  const minutes = moscow.getUTCHours() * 60 + moscow.getUTCMinutes()
  if (minutes < 600 || minutes + duration > 1320) throw new InvalidInput('OUTSIDE_WORKING_HOURS')
  return new Date(start + duration * 60000).toISOString()
}
export async function handleBooking(request: { method?: string; origin?: string; contentType?: string; body: unknown; ip: string }, deps: Dependencies) {
  const reply = (status: number, error: string) => ({ status, body: { error } })
  if (request.method !== 'POST') return reply(405, 'Разрешён только POST.')
  if (request.origin !== deps.origin) return reply(403, 'Недопустимый источник запроса.')
  if (request.contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, 'Требуется application/json.')
  let fallback: FailureCode = 'REDIS_UNEXPECTED_FAILURE'
  try {
    if (!await deps.limit(request.ip)) return reply(429, 'Слишком много попыток. Повторите через 10 минут.')
    fallback = 'BOOKING_UNEXPECTED_FAILURE'
    if (Buffer.byteLength(JSON.stringify(request.body) ?? '') > 4096) return reply(413, 'Слишком большой запрос.')
    const input = validateInput(request.body)
    fallback = 'SUPABASE_CATALOG_UNEXPECTED_FAILURE'
    const [exists, duration] = await Promise.all([deps.repository.barberExists(input.barber_id), deps.repository.serviceDuration(input.service_id)])
    if (!exists) throw new InvalidInput('BARBER_UNAVAILABLE')
    if (duration === null) throw new InvalidInput('SERVICE_UNAVAILABLE')
    const ends_at = calculateEnd(input.starts_at, duration, (deps.now ?? Date.now)())
    fallback = 'SUPABASE_INSERT_UNEXPECTED_FAILURE'
    const result = await deps.repository.insert({ ...input, ends_at, status: 'confirmed' })
    if (result.error?.code === '23P01') return reply(409, 'Это время уже занято. Выберите другое.')
    if (result.error) throw new BookingFailure('SUPABASE_INSERT_FAILED')
    return { status: 201, body: { saved: true } }
  } catch (error) {
    if (error instanceof InvalidInput) {
      deps.reportInvalid?.(error.code)
      return { status: 400, body: { error: error.message, code: error.code } }
    }
    const code = failureCode(error, fallback)
    deps.reportFailure?.(code)
    return { status: 503, body: { error: 'Сервис временно недоступен. Сохранение записи не подтверждено.', code } }
  }
}
