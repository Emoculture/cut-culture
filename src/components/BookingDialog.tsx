import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import type { useCatalog } from '../integrations/catalog'
import { bookingInterval, SALON_TIME_ZONE } from '../integrations/booking'
export default function BookingDialog({ open, onClose, catalog }: { open: boolean; onClose: () => void; catalog: ReturnType<typeof useCatalog> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [barberId, setBarberId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
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
      <p>Выберите желаемое время. Онлайн-запись пока недоступна: данные не отправляются и запись не создаётся.</p>
      {catalog.loading ? <p role="status">Загружаем мастеров и услуги…</p> : catalog.error ? <div role="alert"><p>{catalog.error}</p><button className="button" onClick={catalog.reload}>Повторить</button></div> : !catalog.services.length || !catalog.barbers.length ? <p>Для записи пока недостаточно услуг или мастеров.</p> : <form className="booking-form" onSubmit={e => e.preventDefault()}>
        <label>Мастер<select required value={barberId} onChange={e => setBarberId(e.target.value)}><option value="">Выберите мастера</option>{catalog.barbers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Услуга<select required value={serviceId} onChange={e => setServiceId(e.target.value)}><option value="">Выберите услугу</option>{catalog.services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.duration_minutes} мин · {s.price.toLocaleString('ru-RU')} ₽</option>)}</select></label>
        <label>Дата<input type="date" required value={date} onChange={e => setDate(e.target.value)}/></label>
        <label>Время (Москва, UTC+03:00)<input type="time" required min="10:00" max="22:00" value={time} onChange={e => setTime(e.target.value)}/></label>
        <p>Часовой пояс: {SALON_TIME_ZONE}. Работаем 10:00–22:00.</p>
        <div aria-live="polite">{date && time && service && (interval ? <p>Окончание: {new Intl.DateTimeFormat('ru-RU', { timeZone: SALON_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(interval.ends_at))}. Доступность этого времени ещё не проверена.</p> : <p>Выберите будущее время так, чтобы услуга завершилась до 22:00.</p>)}</div>
        {ready && <p>Выбор подготовлен. Для подтверждения требуется подключить безопасный сервер записи.</p>}
        <button type="submit" className="button" disabled>Онлайн-запись скоро появится</button>
      </form>}
      <button className="button" onClick={onClose}>Закрыть <ArrowUpRight size={18}/></button>
    </div>
  </dialog>
}
