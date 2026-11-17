import { sendBookings } from './telegram-bookings.js'
import { sendSchedule, TodayFailure } from './telegram-today.js'
import type { InlineKeyboard, OwnerBotAction, TodayDependencies } from './telegram-today.js'
export const mainMenu: InlineKeyboard = { inline_keyboard: [[
  { text: '📅 Сегодня', callback_data: 'schedule:today' },
  { text: '📆 Завтра', callback_data: 'schedule:tomorrow' },
], [{ text: '📋 Все записи', callback_data: 'bookings:open' }]] }
export const homeMenu: InlineKeyboard = { inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'menu:main' }]] }
export async function processOwnerAction(action: OwnerBotAction, deps: TodayDependencies, now: number) {
  if (action.callbackId) {
    if (!deps.acknowledge) throw new TodayFailure('BOT_CALLBACK_FAILED')
    // Acknowledge before DB queries so the owner's button stops spinning promptly.
    await deps.acknowledge(action.callbackId)
  }
  if (action.command === 'ignore') return
  if (action.command === 'menu') {
    await deps.send(['Здравствуйте! Это меню владельца CUT CULTURE.\nВыберите период для просмотра подтверждённых записей.'], mainMenu)
    return
  }
  if (action.command === 'bookings') {
    await sendBookings(deps, now, action.page ?? 0)
    return
  }
  await sendSchedule(action.command, deps, now, homeMenu)
}
