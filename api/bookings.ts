import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import { handleBooking } from '../server/bookings.js'
import type { Dependencies } from '../server/bookings.js'

function dependencies(): Dependencies {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, BOOKING_ALLOWED_ORIGIN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !BOOKING_ALLOWED_ORIGIN || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) throw new Error('Missing server configuration')
  if (new URL(BOOKING_ALLOWED_ORIGIN).origin !== BOOKING_ALLOWED_ORIGIN) throw new Error('Invalid origin')
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) } })
  return {
    origin: BOOKING_ALLOWED_ORIGIN,
    async limit(ip) {
      // Shared, atomic fixed window: at most 5 attempts per IP per 10 minutes.
      // HMAC avoids storing raw IP addresses in Redis. Never use an in-memory limit
      // across serverless instances. Failure of Redis fails closed.
      const hash = createHmac('sha256', UPSTASH_REDIS_REST_TOKEN).update(ip).digest('hex')
      const response = await fetch(UPSTASH_REDIS_REST_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n", '1', `cut-culture:booking:${hash}`]),
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error('Rate limiter unavailable')
      const value = await response.json() as { result?: number; error?: string }
      if (value.error || !Number.isInteger(value.result) || value.result! < 1) throw new Error('Rate limiter unavailable')
      return value.result! <= 5
    },
    repository: {
      async barberExists(id) {
        const { data, error } = await db.from('barbers').select('id').eq('id', id).maybeSingle()
        if (error) throw new Error('Catalog unavailable')
        return !!data
      },
      async serviceDuration(id) {
        const { data, error } = await db.from('services').select('duration_minutes').eq('id', id).maybeSingle()
        if (error) throw new Error('Catalog unavailable')
        return data ? data.duration_minutes as number : null
      },
      async insert(row) {
        // No SELECT/returning of bookings or PII. The existing exclusion constraint
        // serializes conflicting confirmed inserts, including concurrent requests.
        const { error } = await db.from('bookings').insert(row)
        return { error }
      },
    },
  }
}
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Разрешён только POST.' }) }
  try {
    // Vercel sets x-forwarded-for at its trusted ingress. Do not deploy this handler
    // behind a proxy that permits clients to supply this header unchanged.
    const forwarded = req.headers['x-forwarded-for']
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim()
    if (!ip) return res.status(503).json({ error: 'Сервис временно недоступен.' })
    const result = await handleBooking({ method: req.method, origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined, contentType: req.headers['content-type'], body: req.body, ip }, dependencies())
    if (result.status === 429) res.setHeader('Retry-After', '600')
    return res.status(result.status).json(result.body)
  } catch {
    return res.status(503).json({ error: 'Сервис временно недоступен. Сохранение записи не подтверждено.' })
  }
}
