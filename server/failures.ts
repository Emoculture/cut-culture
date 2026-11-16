// Fixed codes only: never use exception messages, response bodies or environment values.
export const failureCodes = [
  'CONFIG_SUPABASE_URL_MISSING', 'CONFIG_SUPABASE_SECRET_KEY_MISSING',
  'CONFIG_ORIGIN_MISSING', 'CONFIG_REDIS_URL_MISSING', 'CONFIG_REDIS_TOKEN_MISSING',
  'CONFIG_SUPABASE_URL_INVALID', 'CONFIG_ORIGIN_INVALID', 'CONFIG_REDIS_URL_INVALID',
  'SUPABASE_CLIENT_INIT_FAILED', 'FORWARDED_IP_MISSING',
  'REDIS_TIMEOUT', 'REDIS_NETWORK_FAILED', 'REDIS_AUTH_FAILED', 'REDIS_HTTP_FAILED', 'REDIS_RESPONSE_INVALID',
  'SUPABASE_BARBER_QUERY_FAILED', 'SUPABASE_SERVICE_QUERY_FAILED', 'SUPABASE_INSERT_FAILED',
  'SUPABASE_AUTH_FAILED', 'SUPABASE_PERMISSION_DENIED', 'SUPABASE_SCHEMA_MISMATCH',
  'SUPABASE_CONSTRAINT_FAILED', 'SERVICE_DURATION_INVALID',
  'REDIS_UNEXPECTED_FAILURE', 'SUPABASE_CATALOG_UNEXPECTED_FAILURE',
  'SUPABASE_INSERT_UNEXPECTED_FAILURE', 'BOOKING_UNEXPECTED_FAILURE', 'HANDLER_UNEXPECTED_FAILURE',
] as const
export type FailureCode = typeof failureCodes[number]
export const operations = ['barbers.select', 'services.select', 'bookings.insert'] as const
export const permissionScopes = ['schema', 'table', 'sequence', 'rls', 'unknown'] as const
export interface FailureDetails { operation: typeof operations[number]; permission_scope?: typeof permissionScopes[number] }
export class BookingFailure extends Error {
  constructor(public readonly code: FailureCode, public readonly details?: FailureDetails) { super(code) }
}
export function failureCode(error: unknown, fallback: FailureCode): FailureCode {
  return error instanceof BookingFailure && failureCodes.includes(error.code) ? error.code : fallback
}
