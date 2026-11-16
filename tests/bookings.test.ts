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

test('common Russian phone formats and pasted spaces/dashes normalize identically', () => {
  for (const phone of ['79991234567', '8 (999) 123-45-67', '+7\u00a0999\u202f123–45–67', ' +7 999 123-45-67 ']) {
    assert.equal(validateInput({ ...input, client_phone: phone }).client_phone, '+79991234567')
  }
  for (const phone of ['+7\n9991234567', '+7<script>9991234567', '9991234567', '++79991234567']) assert.throws(() => validateInput({ ...input, client_phone: phone }))
})

test('every application 400 has a specific safe code and blocks database writes', async () => {
  const cases: [unknown, string][] = [
    [null, 'INVALID_BODY'], [[input], 'INVALID_BODY'], [JSON.stringify(input), 'INVALID_BODY'],
    [{ ...input, status: 'confirmed' }, 'UNEXPECTED_FIELDS'],
    [{ ...input, barber_id: '' }, 'INVALID_BARBER_ID'], [{ ...input, service_id: 1.5 }, 'INVALID_SERVICE_ID'],
    [{ ...input, client_name: ' ' }, 'INVALID_NAME'], [{ ...input, client_phone: 'bad' }, 'INVALID_PHONE'],
    [{ ...input, starts_at: '2026-11-17T10:00:00+03:00' }, 'INVALID_STARTS_AT'],
    [{ ...input, starts_at: '2026-11-15T07:00:00Z' }, 'START_IN_PAST'],
    [{ ...input, starts_at: '2027-11-17T07:00:00Z' }, 'START_TOO_FAR'],
    [{ ...input, starts_at: '2026-11-17T18:30:00Z' }, 'OUTSIDE_WORKING_HOURS'],
  ]
  for (const [body, code] of cases) {
    const { deps, request, rows } = fixture(); const events: string[] = []
    deps.reportInvalid = value => { events.push(value) }
    const result = await handleBooking({ ...request, body }, deps)
    assert.equal(result.status, 400); assert.equal('code' in result.body && result.body.code, code)
    assert.deepEqual(events, [code]); assert.equal(rows.length, 0)
  }
  for (const missing of ['barber', 'service']) {
    const { deps, request, rows } = fixture(); const events: string[] = []
    deps.reportInvalid = code => { events.push(code) }
    if (missing === 'barber') deps.repository.barberExists = async () => false
    else deps.repository.serviceDuration = async () => null
    const result = await handleBooking(request, deps)
    const code = missing === 'barber' ? 'BARBER_UNAVAILABLE' : 'SERVICE_UNAVAILABLE'
    assert.equal(result.status, 400); assert.equal('code' in result.body && result.body.code, code); assert.deepEqual(events, [code]); assert.equal(rows.length, 0)
  }
})

test('actual client payload shape passes server checks in visitor timezones', async () => {
  const { bookingInterval } = await import('../src/integrations/booking.js')
  const oldTZ = process.env.TZ
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone
      const interval = bookingInterval('2026-11-17', '10:00', 60, now)
      assert.ok(interval); assert.equal(interval.starts_at, '2026-11-17T07:00:00.000Z')
      // Selects always return strings, even when catalog IDs are int8 numbers.
      const payload = validateInput({ ...input, barber_id: String(1), service_id: String(2), starts_at: interval.starts_at })
      assert.deepEqual(Object.keys(payload).sort(), ['barber_id', 'service_id', 'starts_at', 'client_name', 'client_phone'].sort())
      const { deps, request, rows } = fixture()
      assert.equal((await handleBooking({ ...request, body: payload }, deps)).status, 201)
      assert.equal(rows[0].ends_at, interval.ends_at)
    }
  } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ }
  assert.equal(bookingInterval('2027-11-17', '10:00', 60, now), null)
  assert.equal(bookingInterval('2026-11-17', '21:30', 60, now), null)
  assert.equal(bookingInterval('2026-11-17', '09:59', 60, now), null)
  assert.ok(bookingInterval('2026-11-17', '21:00', 60, now))
})

test('diagnostic logs contain only fixed event, code, status and generated request ID', async t => {
  const { logBookingRejection } = await import('../server/diagnostics.js')
  const logs: string[] = []
  t.mock.method(console, 'warn', (message: string) => { logs.push(message) })
  const { deps, request } = fixture()
  const requestId = '01234567-89ab-4def-8123-456789abcdef'
  deps.reportInvalid = code => logBookingRejection(code, requestId)
  const result = await handleBooking({ ...request, body: { ...input, client_phone: 'private invalid phone', client_name: 'Private Client' } }, deps)
  assert.equal(result.status, 400)
  assert.deepEqual(logs.map(value => JSON.parse(value)), [{ event: 'booking_rejected', status: 400, code: 'INVALID_PHONE', request_id: requestId }])
  assert.ok(!JSON.stringify(result.body).includes('Private'))
})

test('UI uses allowlisted specific errors and never echoes untrusted server text', async () => {
  const { bookingResponseError, bookingErrors } = await import('../src/integrations/booking-errors.js')
  assert.equal(bookingResponseError(400, { code: 'INVALID_PHONE', error: 'private details' }), bookingErrors.INVALID_PHONE)
  assert.equal(bookingResponseError(400, { code: 'START_TOO_FAR' }), bookingErrors.START_TOO_FAR)
  for (const body of [null, { code: '__proto__', error: 'private details' }, { error: 'private details' }]) {
    assert.ok(!bookingResponseError(400, body).includes('private details'))
  }
  assert.ok(!bookingResponseError(503, { code: 'INVALID_PHONE' }).includes('Запись подтверждена'))
})
