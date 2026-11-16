import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createDependencies } from '../server/dependencies.js'
import { failureCode } from '../server/failures.js'
import { logBookingFailure, logBookingRejection } from '../server/diagnostics.js'
import { randomUUID } from 'node:crypto'
import type { Dependencies } from '../server/bookings.js'
import { handleBooking } from '../server/bookings.js'

export function createBookingHandler(makeDependencies: () => Dependencies = () => createDependencies(process.env)) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    const requestId = randomUUID()
    res.setHeader('X-Request-ID', requestId)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Разрешён только POST.' }) }
    try {
      // Vercel sets x-forwarded-for at its trusted ingress. Do not deploy this handler
      // behind a proxy that permits clients to supply this header unchanged.
      const forwarded = req.headers['x-forwarded-for']
      const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim()
      if (!ip) {
        logBookingFailure('FORWARDED_IP_MISSING', requestId)
        return res.status(503).json({ error: 'Сервис временно недоступен.', code: 'FORWARDED_IP_MISSING' })
      }
      const result = await handleBooking({ method: req.method, origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined, contentType: req.headers['content-type'], body: req.body, ip }, { ...makeDependencies(), reportInvalid: code => logBookingRejection(code, requestId), reportFailure: code => logBookingFailure(code, requestId) })
      if (result.status === 429) res.setHeader('Retry-After', '600')
      return res.status(result.status).json(result.body)
    } catch (error) {
      const code = failureCode(error, 'HANDLER_UNEXPECTED_FAILURE')
      logBookingFailure(code, requestId)
      return res.status(503).json({ error: 'Сервис временно недоступен. Сохранение записи не подтверждено.', code })
    }
  }
}
export default createBookingHandler()
