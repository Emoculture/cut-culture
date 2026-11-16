export interface BookingInput { barber_id: string; service_id: string; starts_at: string; client_name: string; client_phone: string }
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
}
export class InvalidInput extends Error {}
const invalid = () => { throw new InvalidInput('Некорректные данные записи.') }
function id(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) return invalid()
  return text
}
export function validateInput(body: unknown): BookingInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
  const row = body as Record<string, unknown>
  const allowed = ['barber_id', 'service_id', 'starts_at', 'client_name', 'client_phone']
  if (Object.keys(row).some(key => !allowed.includes(key))) return invalid()
  if (typeof row.client_name !== 'string' || typeof row.client_phone !== 'string') return invalid()
  if (/[\p{Cc}\p{Cf}]/u.test(row.client_name)) return invalid()
  const name = row.client_name.trim().replace(/ +/g, ' ')
  if (name.length < 2 || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) return invalid()
  if (!/^[+\d ()-]{10,30}$/.test(row.client_phone)) return invalid()
  let phone = row.client_phone.replace(/[ ()-]/g, '')
  if (/^8\d{10}$/.test(phone)) phone = '+7' + phone.slice(1)
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) return invalid()
  if (typeof row.starts_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(row.starts_at)) return invalid()
  const start = new Date(row.starts_at)
  if (!Number.isFinite(start.getTime()) || start.toISOString() !== row.starts_at.replace(/:00Z$/, ':00.000Z')) return invalid()
  return { barber_id: id(row.barber_id), service_id: id(row.service_id), starts_at: start.toISOString(), client_name: name, client_phone: phone }
}
export function calculateEnd(startISO: string, duration: number, now: number): string {
  const start = Date.parse(startISO)
  if (!Number.isInteger(duration) || duration <= 0 || duration > 720) throw new Error('Invalid duration in catalog')
  if (start <= now || start > now + 180 * 86400000) throw new InvalidInput('Выберите будущее время в пределах 180 дней.')
  // Moscow has a fixed UTC+03:00 offset. Both comparisons are in salon time.
  const moscow = new Date(start + 3 * 3600000)
  const minutes = moscow.getUTCHours() * 60 + moscow.getUTCMinutes()
  if (minutes < 600 || minutes + duration > 1320) throw new InvalidInput('Рабочие часы: 10:00–22:00 по Москве.')
  return new Date(start + duration * 60000).toISOString()
}
export async function handleBooking(request: { method?: string; origin?: string; contentType?: string; body: unknown; ip: string }, deps: Dependencies) {
  const reply = (status: number, error: string) => ({ status, body: { error } })
  if (request.method !== 'POST') return reply(405, 'Разрешён только POST.')
  if (request.origin !== deps.origin) return reply(403, 'Недопустимый источник запроса.')
  if (request.contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, 'Требуется application/json.')
  try {
    if (!await deps.limit(request.ip)) return reply(429, 'Слишком много попыток. Повторите через 10 минут.')
    if (Buffer.byteLength(JSON.stringify(request.body) ?? '') > 4096) return reply(413, 'Слишком большой запрос.')
    const input = validateInput(request.body)
    const [exists, duration] = await Promise.all([deps.repository.barberExists(input.barber_id), deps.repository.serviceDuration(input.service_id)])
    if (!exists || duration === null) return reply(400, 'Мастер или услуга недоступны.')
    const ends_at = calculateEnd(input.starts_at, duration, (deps.now ?? Date.now)())
    const result = await deps.repository.insert({ ...input, ends_at, status: 'confirmed' })
    if (result.error?.code === '23P01') return reply(409, 'Это время уже занято. Выберите другое.')
    if (result.error) return reply(503, 'Не удалось подтвердить сохранение записи. Не повторяйте запрос автоматически.')
    return { status: 201, body: { saved: true } }
  } catch (error) {
    if (error instanceof InvalidInput) return reply(400, error.message)
    // Do not log request bodies, phone numbers, database errors or secrets.
    return reply(503, 'Сервис временно недоступен. Сохранение записи не подтверждено.')
  }
}
