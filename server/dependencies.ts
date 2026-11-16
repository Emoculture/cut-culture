import { createTelegramNotifier } from './telegram.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import { BookingFailure } from './failures.js'
import type { FailureCode, FailureDetails } from './failures.js'
import type { Dependencies } from './bookings.js'

function required(env: NodeJS.ProcessEnv, name: string, code: FailureCode) {
  const value = env[name]
  if (!value?.trim()) throw new BookingFailure(code)
  return value
}
function httpsURL(value: string, code: FailureCode, originOnly = false) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (originOnly && url.origin !== value)) throw new Error()
  } catch { throw new BookingFailure(code) }
}
function dbFailure(error: { code?: unknown; message?: unknown }, fallback: FailureCode, operation: FailureDetails['operation']): BookingFailure {
  const { code } = error
  const details: FailureDetails = { operation }
  if (code === 'PGRST301' || code === 'PGRST302') return new BookingFailure('SUPABASE_AUTH_FAILED', details)
  if (code === '42501') {
    // Inspect only to classify a fixed category. Never retain or log the message.
    const message = typeof error.message === 'string' ? error.message : ''
    details.permission_scope = /row-level security/i.test(message) ? 'rls'
      : /permission denied for sequence/i.test(message) ? 'sequence'
      : /permission denied for schema/i.test(message) ? 'schema'
      : /permission denied for table/i.test(message) ? 'table' : 'unknown'
    return new BookingFailure('SUPABASE_PERMISSION_DENIED', details)
  }
  if (['PGRST204', 'PGRST205', '42P01', '42703'].includes(String(code))) return new BookingFailure('SUPABASE_SCHEMA_MISMATCH', details)
  if (['23502', '23503', '23505', '23514'].includes(String(code))) return new BookingFailure('SUPABASE_CONSTRAINT_FAILED', details)
  return new BookingFailure(fallback, details)
}
export function createDependencies(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Dependencies {
  const url = required(env, 'SUPABASE_URL', 'CONFIG_SUPABASE_URL_MISSING')
  const key = required(env, 'SUPABASE_SECRET_KEY', 'CONFIG_SUPABASE_SECRET_KEY_MISSING')
  const origin = required(env, 'BOOKING_ALLOWED_ORIGIN', 'CONFIG_ORIGIN_MISSING')
  const redisURL = required(env, 'UPSTASH_REDIS_REST_URL', 'CONFIG_REDIS_URL_MISSING')
  const redisToken = required(env, 'UPSTASH_REDIS_REST_TOKEN', 'CONFIG_REDIS_TOKEN_MISSING')
  httpsURL(url, 'CONFIG_SUPABASE_URL_INVALID')
  httpsURL(origin, 'CONFIG_ORIGIN_INVALID', true)
  httpsURL(redisURL, 'CONFIG_REDIS_URL_INVALID')
  let db: SupabaseClient
  try {
    db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => {
      const headers = new Headers(init?.headers)
      // New API keys are opaque, not JWTs. The installed SDK also adds a Bearer
      // fallback for REST; remove only that duplicate, keeping apikey intact.
      if (key.startsWith('sb_secret_') && headers.get('Authorization') === `Bearer ${key}`) headers.delete('Authorization')
      return fetchImpl(url, { ...init, headers, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) })
    } } })
  } catch { throw new BookingFailure('SUPABASE_CLIENT_INIT_FAILED') }
  return {
    origin,
    notifySaved: createTelegramNotifier(env, async (row, signal) => {
      const [barber, service] = await Promise.all([
        db.from('barbers').select('name').eq('id', row.barber_id).abortSignal(signal).maybeSingle(),
        db.from('services').select('name').eq('id', row.service_id).abortSignal(signal).maybeSingle(),
      ])
      if (barber.error || service.error || !barber.data || !service.data || typeof barber.data.name !== 'string' || typeof service.data.name !== 'string') throw new Error('Notification catalog unavailable')
      return { barber_name: barber.data.name, service_name: service.data.name }
    }, fetchImpl),
    async limit(ip) {
      const hash = createHmac('sha256', redisToken).update(ip).digest('hex')
      let response: Response
      try {
        response = await fetchImpl(redisURL, {
          method: 'POST', headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n", '1', `cut-culture:booking:${hash}`]),
          signal: AbortSignal.timeout(3000),
        })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        throw new BookingFailure(name === 'TimeoutError' || name === 'AbortError' ? 'REDIS_TIMEOUT' : 'REDIS_NETWORK_FAILED')
      }
      if (response.status === 401 || response.status === 403) throw new BookingFailure('REDIS_AUTH_FAILED')
      if (!response.ok) throw new BookingFailure('REDIS_HTTP_FAILED')
      try {
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object') throw new Error()
        const result = value as { result?: unknown; error?: unknown }
        if (result.error || typeof result.result !== 'number' || !Number.isSafeInteger(result.result) || result.result < 1) throw new Error()
        return result.result <= 5
      } catch { throw new BookingFailure('REDIS_RESPONSE_INVALID') }
    },
    repository: {
      async barberExists(id) {
        try {
          const { data, error } = await db.from('barbers').select('id').eq('id', id).maybeSingle()
          if (error) throw dbFailure(error, 'SUPABASE_BARBER_QUERY_FAILED', 'barbers.select')
          return !!data
        } catch (error) { if (error instanceof BookingFailure) throw error; throw new BookingFailure('SUPABASE_BARBER_QUERY_FAILED', { operation: 'barbers.select' }) }
      },
      async serviceDuration(id) {
        try {
          const { data, error } = await db.from('services').select('duration_minutes').eq('id', id).maybeSingle()
          if (error) throw dbFailure(error, 'SUPABASE_SERVICE_QUERY_FAILED', 'services.select')
          return data ? data.duration_minutes as number : null
        } catch (error) { if (error instanceof BookingFailure) throw error; throw new BookingFailure('SUPABASE_SERVICE_QUERY_FAILED', { operation: 'services.select' }) }
      },
      async insert(row) {
        try {
          const { error } = await db.from('bookings').insert(row)
          if (error && error.code !== '23P01') throw dbFailure(error, 'SUPABASE_INSERT_FAILED', 'bookings.insert')
          return { error }
        } catch (error) { if (error instanceof BookingFailure) throw error; throw new BookingFailure('SUPABASE_INSERT_FAILED', { operation: 'bookings.insert' }) }
      },
    },
  }
}
