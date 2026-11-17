import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomUUID } from 'node:crypto'
import { TodayFailure, webhookCodes, ownerConfig, secretMatches, ownerBotAction } from '../server/telegram-today.js'
import { processOwnerAction } from '../server/telegram-menu.js'
import type { TodayDependencies } from '../server/telegram-today.js'
import { todayDependencies } from '../server/telegram-today-adapter.js'
export function createTelegramWebhook(env: NodeJS.ProcessEnv = process.env, makeDependencies: (config: { token: string; chatId: string }) => TodayDependencies = config => todayDependencies(env, config), now = Date.now) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    const requestId = randomUUID()
    res.setHeader('X-Request-ID', requestId); res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false }) }
    try {
      const config = ownerConfig(env)
      if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], config.secret)) return res.status(403).json({ ok: false })
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ ok: false })
      if (Buffer.byteLength(JSON.stringify(req.body) ?? '') > 32768) return res.status(413).json({ ok: false })
      // Authenticate sender AND destination before initializing DB or sending data.
      const action = ownerBotAction(req.body, config.chatId)
      if (!action) return res.status(200).json({ ok: true })
      const deps = makeDependencies(config)
      const updateId = (req.body as { update_id: number }).update_id
      if (!deps.claimUpdate) throw new TodayFailure('BOT_DEDUP_FAILED')
      if (!await deps.claimUpdate(updateId)) return res.status(200).json({ ok: true })
      await processOwnerAction(action, deps, now())
      return res.status(200).json({ ok: true })
    } catch (error) {
      const code = error instanceof TodayFailure && webhookCodes.includes(error.code) ? error.code : 'TODAY_UNEXPECTED_FAILURE'
      console.error(JSON.stringify({ event: 'telegram_webhook_failed', code, request_id: requestId }))
      return res.status(503).json({ ok: false })
    }
  }
}
export default createTelegramWebhook()
