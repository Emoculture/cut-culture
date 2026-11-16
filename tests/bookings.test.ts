import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateEnd, handleBooking, validateInput } from '../server/bookings.js'
import type { BookingRow, Dependencies } from '../server/bookings.js'
const now = Date.parse('2026-11-16T00:00:00Z')
const input = { barber_id: '1', service_id: '2', starts_at: '2026-11-17T07:00:00.000Z', client_name: ' Иван ', client_phone: '8 (999) 123-45-67' }
function fixture() {
  const rows: BookingRow[] = []
  const deps: Dependencies = { origin: 'https://cut.example', now: () => now, limit: async () => true, repository: { barberExists: async () => true, serviceDuration: async () => 60, insert: async row => { rows.push(row); return { error: null } } } }
  const request = { method: 'POST', origin: deps.origin, contentType: 'application/json', ip: '127.0.0.1', body: input }
  return { rows, deps, request }
}
test('normalizes PII and accepts int8 IDs without precision loss', () => {
  assert.equal(validateInput(input).client_phone, '+79991234567')
  assert.equal(validateInput(input).client_name, 'Иван')
  assert.equal(validateInput({ ...input, barber_id: '9223372036854775807' }).barber_id, '9223372036854775807')
})
test('rejects forged fields, unsafe IDs, invalid dates and PII', () => {
  for (const extra of [{ status: 'confirmed' }, { ends_at: input.starts_at }, { barber_id: 9007199254740992 }, { barber_id: '9223372036854775808' }, { client_name: '\nIvan' }, { client_phone: 'bad' }, { starts_at: '2026-02-30T07:00:00Z' }, { starts_at: '2026-11-17T10:00:00' }]) assert.throws(() => validateInput({ ...input, ...extra }))
})
test('calculates UTC end using server duration and Moscow opening hours', () => {
  assert.equal(calculateEnd(input.starts_at, 60, now), '2026-11-17T08:00:00.000Z')
  assert.equal(calculateEnd('2026-11-17T18:00:00Z', 60, now), '2026-11-17T19:00:00.000Z')
  for (const start of ['2026-11-17T06:59:00Z', '2026-11-17T18:01:00Z', '2026-11-15T07:00:00Z', '2027-11-17T07:00:00Z']) assert.throws(() => calculateEnd(start, 60, now))
  for (const duration of [0, -1, 1.5, 721, NaN]) assert.throws(() => calculateEnd(input.starts_at, duration, now))
})
test('201 only after successful insert, sets confirmed and calculates ends_at', async () => {
  const { deps, request, rows } = fixture()
  const result = await handleBooking(request, deps)
  assert.equal(result.status, 201); assert.deepEqual(result.body, { saved: true })
  assert.equal(rows[0].status, 'confirmed'); assert.equal(rows[0].ends_at, '2026-11-17T08:00:00.000Z')
})
test('DB overlap maps to 409; other errors and thrown failures never report success', async () => {
  for (const code of ['23P01', '23503', '42501']) {
    const { deps, request } = fixture(); deps.repository.insert = async () => ({ error: { code } })
    const result = await handleBooking(request, deps); assert.equal(result.status, code === '23P01' ? 409 : 503); assert.ok(!('saved' in result.body))
  }
  const { deps, request } = fixture(); deps.repository.insert = async () => { throw new Error('private DB detail') }
  assert.equal((await handleBooking(request, deps)).status, 503)
})
test('method, origin, content type, body size, rate limit and missing catalog block writes', async () => {
  for (const [patch, status] of [[{ method: 'GET' }, 405], [{ origin: 'https://evil.example' }, 403], [{ contentType: 'text/plain' }, 415], [{ body: { ...input, client_name: 'a'.repeat(5000) } }, 413]] as const) {
    const { deps, request, rows } = fixture(); assert.equal((await handleBooking({ ...request, ...patch }, deps)).status, status); assert.equal(rows.length, 0)
  }
  for (const setting of ['limited', 'redisDown', 'barberMissing', 'serviceMissing', 'invalidDuration'] as const) {
    const { deps, request, rows } = fixture()
    if (setting === 'limited') deps.limit = async () => false
    if (setting === 'redisDown') deps.limit = async () => { throw new Error('unavailable') }
    if (setting === 'barberMissing') deps.repository.barberExists = async () => false
    if (setting === 'serviceMissing') deps.repository.serviceDuration = async () => null
    if (setting === 'invalidDuration') deps.repository.serviceDuration = async () => 0
    assert.equal((await handleBooking(request, deps)).status, setting === 'limited' ? 429 : setting.endsWith('Missing') ? 400 : 503); assert.equal(rows.length, 0)
  }
})
test('concurrent conflicting insert is reported as conflict, not success', async () => {
  const { deps, request } = fixture(); let occupied = false
  deps.repository.insert = async () => { if (occupied) return { error: { code: '23P01' } }; occupied = true; return { error: null } }
  const results = await Promise.all([handleBooking(request, deps), handleBooking(request, deps)])
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409])
})
