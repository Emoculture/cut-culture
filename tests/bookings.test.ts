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

test('503 fallbacks report safe stage codes, never exception messages', async () => {
  for (const stage of ['redis', 'catalog', 'insert', 'duration', 'insertError'] as const) {
    const { deps, request } = fixture(); const events: string[] = []
    deps.reportFailure = code => { events.push(code) }
    const fail = async (): Promise<never> => { throw new Error('PRIVATE token phone name') }
    if (stage === 'redis') deps.limit = fail
    if (stage === 'catalog') deps.repository.barberExists = fail
    if (stage === 'insert') deps.repository.insert = fail
    if (stage === 'duration') deps.repository.serviceDuration = async () => 0
    if (stage === 'insertError') deps.repository.insert = async () => ({ error: { code: 'PRIVATE' } })
    const expected = { redis: 'REDIS_UNEXPECTED_FAILURE', catalog: 'SUPABASE_CATALOG_UNEXPECTED_FAILURE', insert: 'SUPABASE_INSERT_UNEXPECTED_FAILURE', duration: 'SERVICE_DURATION_INVALID', insertError: 'SUPABASE_INSERT_FAILED' }[stage]
    const result = await handleBooking(request, deps)
    assert.equal(result.status, 503); assert.equal('code' in result.body && result.body.code, expected)
    assert.deepEqual(events, [expected]); assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!('saved' in result.body))
  }
})

const testServerEnv = {
  SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'test-server-key',
  BOOKING_ALLOWED_ORIGIN: 'https://cut-culture.vercel.app',
  UPSTASH_REDIS_REST_URL: 'https://test-redis.example', UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
}
test('configuration diagnostics identify missing and invalid fields without values', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const { BookingFailure } = await import('../server/failures.js')
  const missing = { SUPABASE_URL: 'CONFIG_SUPABASE_URL_MISSING', SUPABASE_SECRET_KEY: 'CONFIG_SUPABASE_SECRET_KEY_MISSING', BOOKING_ALLOWED_ORIGIN: 'CONFIG_ORIGIN_MISSING', UPSTASH_REDIS_REST_URL: 'CONFIG_REDIS_URL_MISSING', UPSTASH_REDIS_REST_TOKEN: 'CONFIG_REDIS_TOKEN_MISSING' }
  for (const [key, code] of Object.entries(missing)) {
    assert.throws(() => createDependencies({ ...testServerEnv, [key]: '' }), error => error instanceof BookingFailure && error.code === code)
  }
  for (const [key, code] of [['SUPABASE_URL', 'CONFIG_SUPABASE_URL_INVALID'], ['BOOKING_ALLOWED_ORIGIN', 'CONFIG_ORIGIN_INVALID'], ['UPSTASH_REDIS_REST_URL', 'CONFIG_REDIS_URL_INVALID']]) {
    assert.throws(() => createDependencies({ ...testServerEnv, [key]: 'PRIVATE invalid URL' }), error => error instanceof BookingFailure && error.code === code && !error.message.includes('PRIVATE'))
  }
})

test('Redis HTTP, auth, timeout, network and invalid responses fail closed', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const { BookingFailure } = await import('../server/failures.js')
  const cases: [() => Promise<Response>, string][] = [
    [async () => new Response('PRIVATE', { status: 401 }), 'REDIS_AUTH_FAILED'],
    [async () => new Response('PRIVATE', { status: 403 }), 'REDIS_AUTH_FAILED'],
    [async () => new Response('PRIVATE', { status: 500 }), 'REDIS_HTTP_FAILED'],
    [async () => { throw new DOMException('PRIVATE', 'TimeoutError') }, 'REDIS_TIMEOUT'],
    [async () => { throw new TypeError('PRIVATE') }, 'REDIS_NETWORK_FAILED'],
    [async () => new Response('PRIVATE'), 'REDIS_RESPONSE_INVALID'],
    [async () => Response.json({ error: 'PRIVATE' }), 'REDIS_RESPONSE_INVALID'],
    [async () => Response.json({ result: 0 }), 'REDIS_RESPONSE_INVALID'],
  ]
  for (const [fetchMock, code] of cases) {
    const deps = createDependencies(testServerEnv, fetchMock)
    await assert.rejects(deps.limit('test-ip'), error => error instanceof BookingFailure && error.code === code && !error.message.includes('PRIVATE'))
  }
  assert.equal(await createDependencies(testServerEnv, async () => Response.json({ result: 5 })).limit('test-ip'), true)
  assert.equal(await createDependencies(testServerEnv, async () => Response.json({ result: 6 })).limit('test-ip'), false)
})

test('real Supabase adapter maps query/write failures and preserves overlap handling', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const { BookingFailure } = await import('../server/failures.js')
  const row: BookingRow = { ...input, ends_at: '2026-11-17T08:00:00Z', status: 'confirmed' }
  for (const [operation, expected] of [['barberExists', 'SUPABASE_BARBER_QUERY_FAILED'], ['serviceDuration', 'SUPABASE_SERVICE_QUERY_FAILED'], ['insert', 'SUPABASE_INSERT_FAILED']] as const) {
    const deps = createDependencies(testServerEnv, async () => Response.json({ code: 'PRIVATE', message: 'PRIVATE', details: 'PRIVATE' }, { status: 500 }))
    const call = operation === 'insert' ? deps.repository.insert(row) : deps.repository[operation]('1')
    await assert.rejects(call, error => error instanceof BookingFailure && error.code === expected && !error.message.includes('PRIVATE'))
  }
  for (const [code, expected] of [['PGRST301', 'SUPABASE_AUTH_FAILED'], ['42501', 'SUPABASE_PERMISSION_DENIED'], ['PGRST204', 'SUPABASE_SCHEMA_MISMATCH'], ['42P01', 'SUPABASE_SCHEMA_MISMATCH'], ['23503', 'SUPABASE_CONSTRAINT_FAILED'], ['23514', 'SUPABASE_CONSTRAINT_FAILED']]) {
    const deps = createDependencies(testServerEnv, async () => Response.json({ code, message: 'PRIVATE' }, { status: 403 }))
    await assert.rejects(deps.repository.insert(row), error => error instanceof BookingFailure && error.code === expected)
  }
  const deps = createDependencies(testServerEnv, async () => Response.json({ code: '23P01', message: 'PRIVATE' }, { status: 409 }))
  assert.equal((await deps.repository.insert(row)).error?.code, '23P01')
})

test('Vercel handler logs exactly one safe 503 event with matching X-Request-ID', async t => {
  const { createBookingHandler } = await import('../api/bookings.js')
  const { BookingFailure } = await import('../server/failures.js')
  const logs: string[] = []; t.mock.method(console, 'error', (message: string) => { logs.push(message) })
  const { deps } = fixture()
  for (const scenario of ['config', 'missingIP', 'redis', 'insert', 'unexpected'] as const) {
    logs.length = 0; const headers: Record<string, unknown> = {}; let status = 0; let body: unknown
    const failingDeps = { ...deps, limit: async () => { throw new BookingFailure('REDIS_TIMEOUT') } }
    const handler = createBookingHandler(() => {
      if (scenario === 'config') throw new BookingFailure('CONFIG_REDIS_TOKEN_MISSING')
      if (scenario === 'unexpected') throw new Error('PRIVATE raw exception')
      if (scenario === 'redis') return failingDeps
      return { ...deps, repository: { ...deps.repository, insert: async () => ({ error: { code: 'PRIVATE' } }) } }
    })
    const req = { method: 'POST', headers: { origin: deps.origin, 'content-type': 'application/json', ...(scenario === 'missingIP' ? {} : { 'x-forwarded-for': 'PRIVATE-IP' }) }, body: { ...input, client_name: 'PRIVATE-NAME' } }
    const res = { setHeader: (key: string, value: unknown) => { headers[key] = value }, status: (value: number) => { status = value; return res }, json: (value: unknown) => { body = value; return res } }
    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1])
    assert.equal(status, 503); assert.equal(logs.length, 1)
    const code = { config: 'CONFIG_REDIS_TOKEN_MISSING', missingIP: 'FORWARDED_IP_MISSING', redis: 'REDIS_TIMEOUT', insert: 'SUPABASE_INSERT_FAILED', unexpected: 'HANDLER_UNEXPECTED_FAILURE' }[scenario]
    assert.deepEqual(JSON.parse(logs[0]), { event: 'booking_failed', status: 503, code, request_id: headers['X-Request-ID'] })
    assert.ok(!JSON.stringify({ logs, body }).includes('PRIVATE'))
    assert.equal((body as { code: string }).code, code)
  }
})

test('new secret API key is sent only as apikey for both catalog reads and booking insert', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const key = 'sb_secret_fake_test_value'
  const observed: { operation: string; hasBearer: boolean; hasApiKey: boolean }[] = []
  const deps = createDependencies({ ...testServerEnv, SUPABASE_SECRET_KEY: key }, async (url, init) => {
    const headers = new Headers(init?.headers)
    observed.push({ operation: new URL(String(url)).pathname, hasBearer: headers.has('Authorization'), hasApiKey: headers.get('apikey') === key })
    return init?.method === 'POST' ? new Response(null, { status: 201 }) : Response.json([])
  })
  await deps.repository.barberExists('1'); await deps.repository.serviceDuration('2')
  await deps.repository.insert({ ...input, ends_at: '2026-11-17T08:00:00Z', status: 'confirmed' })
  assert.equal(observed.length, 3)
  assert.deepEqual(observed.map(row => row.operation), ['/rest/v1/barbers', '/rest/v1/services', '/rest/v1/bookings'])
  assert.ok(observed.every(row => row.hasApiKey && !row.hasBearer))
})

test('legacy key Bearer behavior is preserved', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const legacyKey = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake-signature'
  const deps = createDependencies({ ...testServerEnv, SUPABASE_SECRET_KEY: legacyKey }, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${legacyKey}`)
    assert.equal(new Headers(init?.headers).get('apikey'), legacyKey)
    return Response.json([])
  })
  await deps.repository.barberExists('1')
})

test('42501 retains exact operation and safe scope without storing raw database text', async t => {
  const { createDependencies } = await import('../server/dependencies.js')
  const { BookingFailure } = await import('../server/failures.js')
  const { logBookingFailure } = await import('../server/diagnostics.js')
  const logs: string[] = []; t.mock.method(console, 'error', (value: string) => { logs.push(value) })
  for (const operation of ['barbers.select', 'services.select', 'bookings.insert'] as const) {
    for (const [message, scope] of [['permission denied for schema PRIVATE', 'schema'], ['permission denied for table PRIVATE', 'table'], ['permission denied for sequence PRIVATE', 'sequence'], ['new row violates row-level security policy for table PRIVATE', 'rls'], ['PRIVATE unknown issue', 'unknown']]) {
      const deps = createDependencies(testServerEnv, async () => Response.json({ code: '42501', message, details: 'PRIVATE' }, { status: 403 }))
      const call = operation === 'bookings.insert' ? deps.repository.insert({ ...input, ends_at: '2026-11-17T08:00:00Z', status: 'confirmed' }) : operation === 'barbers.select' ? deps.repository.barberExists('1') : deps.repository.serviceDuration('2')
      await assert.rejects(call, error => {
        assert.ok(error instanceof BookingFailure); assert.equal(error.code, 'SUPABASE_PERMISSION_DENIED')
        assert.deepEqual(error.details, { operation, permission_scope: scope })
        logBookingFailure(error.code, '01234567-89ab-4def-8123-456789abcdef', error.details)
        assert.ok(!JSON.stringify(error).includes('PRIVATE')); return true
      })
    }
  }
  assert.equal(logs.length, 15); assert.ok(!logs.join('').includes('PRIVATE'))
  assert.equal(JSON.parse(logs[0]).operation, 'barbers.select')
})

test('installed SDK completes protected server flow with new key and preserves Redis authorization', async () => {
  const { createDependencies } = await import('../server/dependencies.js')
  const key = 'sb_secret_fake_protected_transport'
  let inserted = false; let redisChecked = false
  const deps = createDependencies({ ...testServerEnv, SUPABASE_SECRET_KEY: key }, async (url, init) => {
    const headers = new Headers(init?.headers)
    if (String(url) === testServerEnv.UPSTASH_REDIS_REST_URL) {
      assert.equal(headers.get('Authorization'), `Bearer ${testServerEnv.UPSTASH_REDIS_REST_TOKEN}`)
      redisChecked = true; return Response.json({ result: 1 })
    }
    // Simulated authenticated gateway: a missing apikey or the opaque key in
    // Authorization is rejected. No real Supabase requests or records are used.
    assert.equal(headers.get('apikey'), key); assert.equal(headers.has('Authorization'), false)
    const path = new URL(String(url)).pathname
    if (path.endsWith('/barbers')) return Response.json([{ id: 1 }])
    if (path.endsWith('/services')) return Response.json([{ duration_minutes: 60 }])
    assert.equal(path, '/rest/v1/bookings'); assert.equal(init?.method, 'POST')
    const row = JSON.parse(String(init?.body)); assert.equal(row.status, 'confirmed')
    assert.equal(row.ends_at, '2026-11-17T08:00:00.000Z')
    assert.equal(headers.get('Prefer')?.includes('return=representation') ?? false, false)
    inserted = true; return new Response(null, { status: 201 })
  })
  deps.now = () => now
  const { request } = fixture(); request.origin = testServerEnv.BOOKING_ALLOWED_ORIGIN
  const response = await handleBooking(request, deps)
  assert.equal(response.status, 201); assert.ok(redisChecked); assert.ok(inserted)
})
