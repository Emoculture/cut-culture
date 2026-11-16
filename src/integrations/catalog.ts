import { useEffect, useState } from 'react'
import { supabase } from './supabase'
export interface CatalogService { id: string; name: string; description: string; duration_minutes: number; price: number }
export interface CatalogBarber { id: string; name: string; role: string; specialty: string; image: string }
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Invalid catalog')
  return value.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid row')
    return row as Record<string, unknown>
  })
}
function required(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string' || !row[key]) throw new Error(`Invalid ${key}`)
  return row[key] as string
}
function identifier(row: Record<string, unknown>): string {
  const id = row.id
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id)
  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) return id
  throw new Error('Invalid or unsafe id')
}
function optional(row: Record<string, unknown>, key: string): string { return typeof row[key] === 'string' ? row[key] as string : '' }
export function parseServices(value: unknown): CatalogService[] {
  return records(value).map(row => {
    if (!Number.isInteger(row.duration_minutes) || Number(row.duration_minutes) <= 0 || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price < 0) throw new Error('Invalid service duration or price')
    return { id: identifier(row), name: required(row, 'name'), description: optional(row, 'description'), duration_minutes: row.duration_minutes as number, price: row.price }
  })
}
export function parseBarbers(value: unknown): CatalogBarber[] {
  return records(value).map(row => ({ id: identifier(row), name: required(row, 'name'), role: optional(row, 'role'), specialty: optional(row, 'specialty'), image: optional(row, 'image') || 'master-1' }))
}
export function useCatalog() {
  const [services, setServices] = useState<CatalogService[]>([])
  const [barbers, setBarbers] = useState<CatalogBarber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    async function load() {
      try {
        if (!supabase) throw new Error('missing configuration')
        const [s, b] = await Promise.all([
          supabase.from('services').select('id,name,description,duration_minutes,price').order('name').abortSignal(controller.signal),
          supabase.from('barbers').select('id,name,role,specialty,image').order('name').abortSignal(controller.signal),
        ])
        if (s.error || b.error) throw new Error('Catalog unavailable')
        const nextServices = parseServices(s.data), nextBarbers = parseBarbers(b.data)
        if (active) { setServices(nextServices); setBarbers(nextBarbers) }
      } catch {
        if (active) setError(supabase ? 'Не удалось загрузить услуги и мастеров. Попробуйте ещё раз.' : 'Каталог пока не подключён. Настройте подключение Supabase.')
      } finally { if (active) setLoading(false) }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    void load()
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])
  return { services, barbers, loading, error, reload: () => retry(value => value + 1) }
}
