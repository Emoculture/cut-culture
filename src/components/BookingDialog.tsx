import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import type { useCatalog } from '../integrations/catalog'
import { bookingResponseError } from '../integrations/booking-errors'
import { InvalidInput, validateInput } from '../integrations/booking-validation'
import { bookingInterval, SALON_TIME_ZONE } from '../integrations/booking'
export default function BookingDialog({ open, onClose, catalog }: { open: boolean; onClose: () => void; catalog: ReturnType<typeof useCatalog> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [barberId, setBarberId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [sending, setSending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || !interval || !ready) return
    let payload
    try { payload = validateInput({ barber_id: barberId, service_id: serviceId, starts_at: interval.starts_at, client_name: clientName, client_phone: clientPhone }) }
    catch (error) { setError(error instanceof InvalidInput ? error.message : 'Проверьте данные формы.'); return }
    inFlight.current = true; setSending(true); setError('')
    try {
      const response = await fetch('/api/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      })
      const result = await response.json().catch(() => null)
      if (response.status === 201 && result?.saved === true) {
        setSaved(true); setClientName(''); setClientPhone('')
      } else {
        setError(bookingResponseError(response.status, result))
      }
    } catch { setError('Не удалось получить подтверждение. Запись могла сохраниться. Уточните её у салона перед повторной отправкой.') }
    finally { inFlight.current = false; setSending(false) }
  }
  const service = catalog.services.find(s => s.id === serviceId)
  const interval = service ? bookingInterval(date, time, service.duration_minutes) : null
  const ready = !!interval && catalog.barbers.some(b => b.id === barberId)
  useEffect(() => {
    const dialog = ref.current
    if (open && !dialog?.open) dialog?.showModal()
    if (!open && dialog?.open) dialog.close()
  }, [open])
  return <dialog ref={ref} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-labelledby="booking-title">
    <div className="dialog-content"><button className="icon-button dialog-close" aria-label="Закрыть окно" onClick={onClose}><X /></button><span className="eyebrow">СЛЕДУЮЩАЯ ГЛАВА</span><ArrowUpRight size={48} strokeWidth={1}/><h2 id="booking-title">Ваша запись.</h2>
      <p>Выберите услугу и желаемое время. Запись подтверждается после сохранения сервером.</p>
      {saved ? <p role="status">Запись подтверждена и сохранена. Ждём вас в выбранное время!</p> : catalog.loading ? <p role="status">Загружаем мастеров и услуги…</p> : catalog.error ? <div role="alert"><p>{catalog.error}</p><button className="button" onClick={catalog.reload}>Повторить</button></div> : !catalog.services.length || !catalog.barbers.length ? <p>Для записи пока недостаточно услуг или мастеров.</p> : <form className="booking-form" onSubmit={submit}>
        <fieldset disabled={sending} className="booking-fields"><label>Мастер<select required value={barberId} onChange={e => setBarberId(e.target.value)}><option value="">Выберите мастера</option>{catalog.barbers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Услуга<select required value={serviceId} onChange={e => setServiceId(e.target.value)}><option value="">Выберите услугу</option>{catalog.services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.duration_minutes} мин · {s.price.toLocaleString('ru-RU')} ₽</option>)}</select></label>
        <label>Дата<input type="date" required value={date} onChange={e => setDate(e.target.value)}/></label>
        <label>Время (Москва, UTC+03:00)<input type="time" required min="10:00" max="22:00" value={time} onChange={e => setTime(e.target.value)}/></label>
        <label>Ваше имя<input required autoComplete="name" minLength={2} maxLength={100} value={clientName} onChange={e => setClientName(e.target.value)}/></label>
        <label>Телефон<input type="tel" required autoComplete="tel" placeholder="+7 999 123-45-67" minLength={10} maxLength={30} value={clientPhone} onChange={e => setClientPhone(e.target.value)}/></label></fieldset>
        <p>Часовой пояс: {SALON_TIME_ZONE}. Работаем 10:00–22:00.</p>
        <div aria-live="polite">{date && time && service && (interval ? <p>Окончание: {new Intl.DateTimeFormat('ru-RU', { timeZone: SALON_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(interval.ends_at))}. Доступность этого времени ещё не проверена.</p> : <p>Выберите время в пределах 180 дней так, чтобы услуга полностью прошла с 10:00 до 22:00 по Москве.</p>)}</div>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="button" disabled={!ready || sending}>{sending ? 'Сохраняем запись…' : 'Подтвердить запись'}</button>
      </form>}
      <button className="button" onClick={onClose}>Закрыть <ArrowUpRight size={18}/></button>
    </div>
  </dialog>
}
