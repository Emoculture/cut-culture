import { failureCodes } from './failures.js'
import type { FailureCode } from './failures.js'
import { isBookingErrorCode } from '../src/integrations/booking-errors.js'
import type { BookingErrorCode } from '../src/integrations/booking-errors.js'
export function logBookingRejection(code: BookingErrorCode, requestId: string) {
  // No body, field values, IP, timestamps of appointments, headers or Error objects.
  // requestId is a server-generated UUID, never an incoming user value.
  if (!isBookingErrorCode(code) || !/^[0-9a-f-]{36}$/.test(requestId)) return
  console.warn(JSON.stringify({ event: 'booking_rejected', status: 400, code, request_id: requestId }))
}

export function logBookingFailure(code: FailureCode, requestId: string) {
  if (!failureCodes.includes(code) || !/^[0-9a-f-]{36}$/.test(requestId)) return
  console.error(JSON.stringify({ event: 'booking_failed', status: 503, code, request_id: requestId }))
}
