import { useEffect, useRef } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
export default function BookingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (open && !dialog?.open) dialog?.showModal()
    if (!open && dialog?.open) dialog.close()
  }, [open])
  return <dialog ref={ref} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-labelledby="booking-title">
    <div className="dialog-content"><button className="icon-button dialog-close" aria-label="Закрыть окно" onClick={onClose}><X /></button><span className="eyebrow">СЛЕДУЮЩАЯ ГЛАВА</span><ArrowUpRight size={48} strokeWidth={1}/><h2 id="booking-title">Скоро<br/>на связи.</h2><p>Онлайн-запись скоро появится. Сейчас это демонстрационный сайт: мы не принимаем и не сохраняем записи.</p><button className="button" onClick={onClose}>Всё понятно <ArrowUpRight size={18}/></button></div>
  </dialog>
}
