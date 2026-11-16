// Only allowlisted messages/codes may be shown or logged. Never echo input or DB errors.
export const bookingErrors = {
  INVALID_BODY: 'Не удалось прочитать данные формы. Обновите страницу и попробуйте снова.',
  UNEXPECTED_FIELDS: 'Формат формы устарел. Обновите страницу перед отправкой.',
  INVALID_BARBER_ID: 'Выберите мастера из списка.',
  INVALID_SERVICE_ID: 'Выберите услугу из списка.',
  INVALID_NAME: 'Введите имя длиной от 2 до 100 символов без управляющих символов.',
  INVALID_PHONE: 'Введите телефон: +7 999 123-45-67, 8 999 123-45-67 или международный номер с +.',
  INVALID_STARTS_AT: 'Некорректные дата или время. Выберите их заново.',
  START_IN_PAST: 'Выбранное время уже прошло. Выберите будущее время.',
  START_TOO_FAR: 'Запись доступна не далее чем на 180 дней вперёд.',
  OUTSIDE_WORKING_HOURS: 'Услуга должна полностью пройти с 10:00 до 22:00 по Москве.',
  BARBER_UNAVAILABLE: 'Мастер больше недоступен. Обновите страницу и выберите другого.',
  SERVICE_UNAVAILABLE: 'Услуга больше недоступна. Обновите страницу и выберите другую.',
} as const
export type BookingErrorCode = keyof typeof bookingErrors
export function isBookingErrorCode(code: unknown): code is BookingErrorCode {
  return typeof code === 'string' && Object.hasOwn(bookingErrors, code)
}
export function bookingResponseError(status: number, body: unknown): string {
  const code = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined
  if (status === 400) return isBookingErrorCode(code) ? bookingErrors[code] : 'Проверьте данные формы. Если ошибка повторится, сообщите салону код запроса из ответа API.'
  if (status === 409) return 'Это время уже занято. Выберите другое.'
  if (status === 429) return 'Слишком много попыток. Повторите через 10 минут.'
  return 'Сохранение не подтверждено. Не повторяйте запрос автоматически; уточните запись у салона.'
}
