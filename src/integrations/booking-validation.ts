import { bookingErrors } from './booking-errors.js'
import type { BookingErrorCode } from './booking-errors.js'
export interface BookingInput { barber_id: string; service_id: string; starts_at: string; client_name: string; client_phone: string }
export class InvalidInput extends Error {
  constructor(public readonly code: BookingErrorCode) { super(bookingErrors[code]) }
}
const invalid = (code: BookingErrorCode): never => { throw new InvalidInput(code) }
function id(value: unknown, code: 'INVALID_BARBER_ID' | 'INVALID_SERVICE_ID'): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) return invalid(code)
  return text
}
export function validateInput(body: unknown): BookingInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('INVALID_BODY')
  const row = body as Record<string, unknown>
  const allowed = ['barber_id', 'service_id', 'starts_at', 'client_name', 'client_phone']
  if (Object.keys(row).some(key => !allowed.includes(key))) return invalid('UNEXPECTED_FIELDS')
  if (typeof row.client_name !== 'string') return invalid('INVALID_NAME')
  if (typeof row.client_phone !== 'string') return invalid('INVALID_PHONE')
  if (/[\p{Cc}\p{Cf}]/u.test(row.client_name)) return invalid('INVALID_NAME')
  const name = row.client_name.trim().replace(/ +/g, ' ')
  if (name.length < 2 || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) return invalid('INVALID_NAME')
  if (row.client_phone.length > 30) return invalid('INVALID_PHONE')
  const formatted = row.client_phone.replace(/\p{Zs}/gu, ' ').replace(/[\u2010-\u2015]/g, '-')
  if (!/^[+\d ()-]{10,30}$/.test(formatted)) return invalid('INVALID_PHONE')
  let phone = formatted.replace(/[ ()-]/g, '')
  if (/^7\d{10}$/.test(phone)) phone = '+' + phone
  if (/^8\d{10}$/.test(phone)) phone = '+7' + phone.slice(1)
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) return invalid('INVALID_PHONE')
  if (typeof row.starts_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(row.starts_at)) return invalid('INVALID_STARTS_AT')
  const start = new Date(row.starts_at)
  if (!Number.isFinite(start.getTime()) || start.toISOString() !== row.starts_at.replace(/:00Z$/, ':00.000Z')) return invalid('INVALID_STARTS_AT')
  return { barber_id: id(row.barber_id, 'INVALID_BARBER_ID'), service_id: id(row.service_id, 'INVALID_SERVICE_ID'), starts_at: start.toISOString(), client_name: name, client_phone: phone }
}
