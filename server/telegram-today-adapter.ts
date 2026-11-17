import { bookingTickets, validBookingId } from './telegram-booking-actions.js'
import { updateGuard } from './telegram-update-guard.js'
import { createClient } from '@supabase/supabase-js'
import { TodayFailure, TODAY_LIMIT } from './telegram-today.js'
import type { TodayDependencies, WebhookCode } from './telegram-today.js'
export function todayDependencies(env: NodeJS.ProcessEnv, config: { token: string; chatId: string }, fetchImpl: typeof fetch = fetch): TodayDependencies {
  const deadline = AbortSignal.timeout(25000)
  // Menu and callback acknowledgement do not initialize Supabase or require reads.
  function database() {
    const url = env.SUPABASE_URL, key = env.SUPABASE_SECRET_KEY
    if (!url || !key) throw new TodayFailure('WEBHOOK_CONFIG_INVALID')
    try { if (new URL(url).protocol !== 'https:') throw new Error() } catch { throw new TodayFailure('WEBHOOK_CONFIG_INVALID') }
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      if (key.startsWith('sb_secret_') && headers.get('Authorization') === `Bearer ${key}`) headers.delete('Authorization')
      return fetchImpl(input, { ...init, headers, signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]) })
    } } })
  }
  async function telegram(method: 'sendMessage' | 'answerCallbackQuery', payload: unknown, code: WebhookCode) {
    try {
      deadline.throwIfAborted()
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]),
      })
      if (!response.ok || (await response.json() as { ok?: unknown }).ok !== true) throw new Error()
    } catch { throw new TodayFailure(code) }
  }
  return {
    tickets: bookingTickets(env, config.token, config.chatId, fetchImpl),
    async getBooking(id) {
      try {
        if (!validBookingId(id)) throw new Error()
        const db = database()
        const { data, error } = await db.from('bookings').select('id,status,starts_at,ends_at,client_name,barber_id,service_id').eq('id', id).maybeSingle()
        if (error) throw new Error()
        if (!data) return null
        const [barber, service] = await Promise.all([db.from('barbers').select('name').eq('id', data.barber_id).maybeSingle(), db.from('services').select('name').eq('id', data.service_id).maybeSingle()])
        if (barber.error || service.error || typeof data.client_name !== 'string' || typeof data.status !== 'string' || !Number.isFinite(Date.parse(data.starts_at)) || !Number.isFinite(Date.parse(data.ends_at))) throw new Error()
        return { booking_id: id, status: data.status, starts_at: data.starts_at, ends_at: data.ends_at, client_name: data.client_name, barber_name: String(barber.data?.name ?? 'Мастер недоступен'), service_name: String(service.data?.name ?? 'Услуга недоступна') }
      } catch { throw new TodayFailure('TODAY_QUERY_FAILED') }
    },
    async cancelBooking(id) {
      try {
        if (!validBookingId(id)) throw new Error()
        const db = database()
        const { data, error } = await db.from('bookings').update({ status: 'cancelled' }).eq('id', id).eq('status', 'confirmed').select('id,status').maybeSingle()
        if (error) throw new Error()
        if (data) { if (data.status !== 'cancelled' || String(data.id) !== id) throw new Error(); return 'cancelled' }
        const current = await db.from('bookings').select('status').eq('id', id).maybeSingle()
        if (current.error) throw new Error()
        return !current.data ? 'not_found' : current.data.status === 'cancelled' ? 'already_cancelled' : 'not_active'
      } catch { throw new TodayFailure('BOT_CANCEL_FAILED') }
    },
    claimUpdate: updateGuard(env, config.token, fetchImpl),
    async load(start, end, pagination) {
      try {
        const db = database()
        // Explicit projection excludes phone numbers. No public booking policies.
        const limit = pagination?.limit ?? TODAY_LIMIT
        if (pagination && (!Number.isSafeInteger(pagination.offset) || pagination.offset < 0 || pagination.offset > 99990 || limit !== 10)) throw new Error()
        let query = db.from('bookings').select('id,starts_at,ends_at,client_name,barber_id,service_id').eq('status', 'confirmed').gte('starts_at', start).lt('starts_at', end).order('starts_at')
        query = pagination ? query.order('id').range(pagination.offset, pagination.offset + limit) : query.limit(limit + 1)
        const { data, error } = await query
        if (error || !data) throw new Error()
        const rows = data.slice(0, limit)
        if (!rows.length) return { rows: [], truncated: false }
        const ids = (field: 'barber_id' | 'service_id') => [...new Set(rows.map(row => {
          if (typeof row[field] === 'number' && !Number.isSafeInteger(row[field])) throw new Error()
          const value = String(row[field]); if (!/^[1-9]\d*$/.test(value)) throw new Error(); return value
        }))]
        const [barbers, services] = await Promise.all([
          db.from('barbers').select('id,name').in('id', ids('barber_id')),
          db.from('services').select('id,name').in('id', ids('service_id')),
        ])
        if (barbers.error || services.error) throw new Error()
        const barberNames = new Map((barbers.data ?? []).map(b => [String(b.id), b.name]))
        const serviceNames = new Map((services.data ?? []).map(s => [String(s.id), s.name]))
        return { rows: rows.map(row => {
          if (typeof row.client_name !== 'string' || !Number.isFinite(Date.parse(row.starts_at)) || !Number.isFinite(Date.parse(row.ends_at)) || Date.parse(row.ends_at) <= Date.parse(row.starts_at)) throw new Error()
          const bookingId = row.id === undefined ? undefined : String(row.id)
          if (pagination && (!validBookingId(bookingId) || (typeof row.id === 'number' && !Number.isSafeInteger(row.id)))) throw new Error()
          return { ...(bookingId ? { booking_id: bookingId } : {}), starts_at: row.starts_at, ends_at: row.ends_at, client_name: row.client_name, barber_name: String(barberNames.get(String(row.barber_id)) ?? 'Мастер недоступен'), service_name: String(serviceNames.get(String(row.service_id)) ?? 'Услуга недоступна') }
        }), truncated: data.length > limit }
      } catch { throw new TodayFailure('TODAY_QUERY_FAILED') }
    },
    async send(messages, keyboard) {
      for (let i = 0; i < messages.length; i++) {
        if (i) await new Promise<void>(resolve => setTimeout(resolve, 1100))
        await telegram('sendMessage', {
          chat_id: config.chatId, text: messages[i], link_preview_options: { is_disabled: true },
          ...(keyboard && i === messages.length - 1 ? { reply_markup: keyboard } : {}),
        }, 'TODAY_SEND_FAILED')
      }
    },
    async acknowledge(callbackId) {
      await telegram('answerCallbackQuery', { callback_query_id: callbackId }, 'BOT_CALLBACK_FAILED')
    },
  }
}
