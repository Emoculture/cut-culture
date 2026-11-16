import type { Barber, Service } from '../types'
export const services: Service[] = [
  { number: '01', name: 'Мужская стрижка', description: 'Форма, которая работает на тебя. Мытьё и укладка включены.', duration: '60 мин', price: '2 500 ₽' },
  { number: '02', name: 'Стрижка машинкой', description: 'Минимум длины. Максимум характера.', duration: '30 мин', price: '1 500 ₽' },
  { number: '03', name: 'Борода и усы', description: 'Чёткие линии, правильная форма и уход.', duration: '40 мин', price: '1 500 ₽' },
  { number: '04', name: 'Стрижка + борода', description: 'Полный образ. Всё внимание — деталям.', duration: '90 мин', price: '3 500 ₽' },
]
export const barbers: Barber[] = [
  { name: 'Александр', role: 'ТОП-БАРБЕР', specialty: 'Классика. Текстура. Точность.', image: 'master-1' },
  { name: 'Марк', role: 'БАРБЕР', specialty: 'Фейды и смелые формы.', image: 'master-2' },
  { name: 'Даниил', role: 'БАРБЕР', specialty: 'Современный взгляд на классику.', image: 'master-3' },
]
export const imageUrl = (id: string, _width = 900) => `/images/${id}.jpg`
export const gallery = ['gallery-1', 'gallery-2', 'gallery-3', 'gallery-4']
