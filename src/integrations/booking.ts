// Salon time is Europe/Moscow (UTC+03:00), regardless of the visitor's timezone.
export const SALON_TIME_ZONE = 'Europe/Moscow'
export function bookingInterval(date: string, time: string, duration: number, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !Number.isInteger(duration) || duration <= 0) return null
  const start = new Date(`${date}T${time}:00+03:00`)
  if (!Number.isFinite(start.getTime()) || start.getTime() <= now) return null
  const local = new Date(start.getTime() + 3 * 3600000).toISOString()
  if (local.slice(0, 10) !== date || local.slice(11, 16) !== time) return null
  const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  if (minutes < 600 || minutes + duration > 1320) return null
  return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + duration * 60000).toISOString() }
}
