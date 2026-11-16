export interface Service { number: string; name: string; description: string; duration: string; price: string }
export interface Barber { name: string; role: string; image: string; specialty: string }
// Контракт будущей интеграции. Отправки данных и хранения записей сейчас нет.
export interface BookingIntent { serviceId?: string; barberId?: string }
