import { createHmac } from 'node:crypto'
import { TodayFailure } from './telegram-today.js'
export function updateGuard(env: NodeJS.ProcessEnv, botToken: string, fetchImpl: typeof fetch = fetch) {
  return async (updateId: number): Promise<boolean> => {
    try {
      const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN
      if (!url || !token || new URL(url).protocol !== 'https:' || !Number.isSafeInteger(updateId) || updateId < 0) throw new Error()
      const key = createHmac('sha256', botToken).update(String(updateId)).digest('hex')
      // Claim before any Telegram side effect, shared across serverless instances.
      // Retain on failure too: a timed-out send may already have been accepted.
      const response = await fetchImpl(url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', `cut-culture:telegram:update:${key}`, 'claimed', 'NX', 'EX', 604800]),
        signal: AbortSignal.timeout(3000), redirect: 'error',
      })
      if (!response.ok) throw new Error()
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') throw new Error()
      const value = body as { result?: unknown; error?: unknown }
      if (value.error || (value.result !== 'OK' && value.result !== null)) throw new Error()
      return value.result === 'OK'
    } catch { throw new TodayFailure('BOT_DEDUP_FAILED') }
  }
}
