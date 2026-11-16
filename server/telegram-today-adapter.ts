import { createClient } from '@supabase/supabase-js'
import { TodayFailure, TODAY_LIMIT } from './telegram-today.js'
import type { TodayDependencies } from './telegram-today.js'
export function todayDependencies(env: NodeJS.ProcessEnv, config: { token: string; chatId: string }, fetchImpl: typeof fetch = fetch): TodayDependencies {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new TodayFailure('WEBHOOK_CONFIG_INVALID')
  try { if (new URL(url).protocol !== 'https:') throw new Error() } catch { throw new TodayFailure('WEBHOOK_CONFIG_INVALID') }
  const deadline = AbortSignal.timeout(25000)
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => {
    const headers = new Headers(init?.headers)
    if (key.startsWith('sb_secret_') && headers.get('Authorization') === `Bearer ${key}`) headers.delete('Authorization')
    return fetchImpl(input, { ...init, headers, signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]) })
  } } })
  return {
    async load(start, end) {
      try {
        // Explicit projection excludes phone numbers. No public booking policies.
        const { data, error } = await db.from('bookings').select('starts_at,client_name,barber_id,service_id').eq('status', 'confirmed').gte('starts_at', start).lt('starts_at', end).order('starts_at').limit(TODAY_LIMIT + 1)
        if (error || !data) throw new Error()
        const rows = data.slice(0, TODAY_LIMIT)
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
          if (typeof row.client_name !== 'string' || !Number.isFinite(Date.parse(row.starts_at))) throw new Error()
          return { starts_at: row.starts_at, client_name: row.client_name, barber_name: String(barberNames.get(String(row.barber_id)) ?? 'Мастер недоступен'), service_name: String(serviceNames.get(String(row.service_id)) ?? 'Услуга недоступна') }
        }), truncated: data.length > TODAY_LIMIT }
      } catch { throw new TodayFailure('TODAY_QUERY_FAILED') }
    },
    async send(messages) {
      try {
        for (let i = 0; i < messages.length; i++) {
          if (i) await new Promise<void>(resolve => setTimeout(resolve, 1100))
          deadline.throwIfAborted()
          const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.chatId, text: messages[i], link_preview_options: { is_disabled: true } }),
            signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]),
          })
          if (!response.ok || (await response.json() as { ok?: unknown }).ok !== true) throw new Error()
        }
      } catch { throw new TodayFailure('TODAY_SEND_FAILED') }
    },
  }
}
