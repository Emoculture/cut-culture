import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingTickets, processBookingAction } from '../server/telegram-booking-actions.js'
import type { BookingCard, BookingTicket, BookingTickets } from '../server/telegram-booking-actions.js'
import { todayDependencies } from '../server/telegram-today-adapter.js'
import { createTelegramWebhook } from '../api/telegram-webhook.js'
import { TodayFailure } from '../server/telegram-today.js'
import type { TodayDependencies } from '../server/telegram-today.js'
const env = { TELEGRAM_BOT_TOKEN: '12345:FAKE', TELEGRAM_OWNER_CHAT_ID: '12345', TELEGRAM_WEBHOOK_SECRET: 'test_secret', SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'sb_secret_fake', UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'fake' }
const now = Date.parse('2026-11-17T00:00:00Z')
const card: BookingCard = { booking_id: '123', status: 'confirmed', starts_at: '2026-11-17T07:00:00Z', ends_at: '2026-11-17T08:00:00Z', client_name: 'Тестовый клиент', barber_name: 'Мастер', service_name: 'Укладка' }
function fixture() {
  const storage = new Map<string, BookingTicket>(); let counter = 0
  const tickets: BookingTickets = { issue: async ticket => { const token = String(++counter).padStart(22, 'A'); storage.set(token, structuredClone(ticket)); return token }, read: async (token, consume) => { const value = storage.get(token) ?? null; if (consume) storage.delete(token); return value } }
  const sent: { text: string; keyboard: unknown }[] = []; let writes = 0; let state = 'confirmed'
  const deps: TodayDependencies = { tickets, getBooking: async () => ({ ...card, status: state }), cancelBooking: async () => { if (state !== 'confirmed') return 'already_cancelled'; writes++; state = 'cancelled'; return 'cancelled' }, load: async () => ({ rows: [], truncated: false }), send: async (text, keyboard) => { sent.push({ text: text.join('\n'), keyboard }) } }
  return { deps, storage, sent, writes: () => writes, state: () => state }
}
test('card and confirmation use opaque tickets; only explicit confirmation changes a record and refreshes list', async () => {
  const f = fixture(); const view = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'view' })
  await processBookingAction({ command: 'booking', bookingStep: 'view', actionToken: view }, f.deps, now)
  assert.equal(f.writes(), 0)
  for (const value of ['Тестовый клиент', 'Мастер', 'Укладка', '17.11.2026', '10:00–11:00']) assert.ok(f.sent[0].text.includes(value))
  assert.ok(JSON.stringify(f.sent[0].keyboard).includes('❌ Отменить запись'))
  await processBookingAction({ command: 'booking', bookingStep: 'ask', actionToken: view }, f.deps, now)
  assert.equal(f.writes(), 0)
  const buttons = (f.sent.at(-1)!.keyboard as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat()
  assert.ok(buttons.some(b => b.text === '✅ Да, отменить')); assert.ok(buttons.some(b => b.text === '↩️ Нет, назад'))
  assert.ok(buttons.every(b => !b.callback_data.includes('123') && !b.callback_data.includes('клиент')))
  const token = buttons.find(b => b.text === '✅ Да, отменить')!.callback_data.split(':')[2]
  await processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now)
  assert.equal(f.writes(), 1); assert.equal(f.state(), 'cancelled'); assert.match(f.sent.at(-1)!.text, /Запись отменена.*Слот освобождён/)
  assert.match(f.sent.at(-1)!.text, /На ближайшие 7 дней записей нет/)
})
test('No revokes the confirmation ticket; a later old Yes cannot cancel', async () => {
  const f = fixture(); const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
  await processBookingAction({ command: 'booking', bookingStep: 'reject', actionToken: token }, f.deps, now)
  assert.equal(f.writes(), 0); assert.match(f.sent.at(-1)!.text, /Карточка записи/)
  await processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now)
  assert.equal(f.writes(), 0); assert.match(f.sent.at(-1)!.text, /Кнопка устарела/)
})
test('double confirmation and direct confirmation with a view ticket cannot repeat or bypass confirmation', async () => {
  const f = fixture(); const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
  await Promise.all([processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now), processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now)])
  assert.equal(f.writes(), 1)
  const view = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'view' })
  await processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: view }, f.deps, now)
  assert.equal(f.writes(), 1)
})
test('already cancelled, inactive and missing records do not claim new cancellation', async () => {
  for (const outcome of ['already_cancelled', 'not_active', 'not_found'] as const) {
    const f = fixture(); const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
    f.deps.cancelBooking = async () => outcome
    await processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now)
    assert.equal(f.writes(), 0); assert.ok(!f.sent.at(-1)!.text.includes('Слот освобождён'))
  }
  const f = fixture(); f.deps.getBooking = async () => null
  const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'view' })
  await processBookingAction({ command: 'booking', bookingStep: 'view', actionToken: token }, f.deps, now)
  assert.match(f.sent.at(-1)!.text, /Запись не найдена/)
})
test('Supabase failure never reports success; Telegram failure cannot undo a committed cancellation', async () => {
  const f = fixture(); const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
  f.deps.cancelBooking = async () => { throw new Error('PRIVATE') }
  await processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: token }, f.deps, now)
  assert.match(f.sent.at(-1)!.text, /Не удалось подтвердить отмену/); assert.equal(f.writes(), 0)
  const g = fixture(); const next = await g.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
  g.deps.send = async () => { throw new TodayFailure('TODAY_SEND_FAILED') }
  await assert.rejects(processBookingAction({ command: 'booking', bookingStep: 'confirm', actionToken: next }, g.deps, now))
  assert.equal(g.writes(), 1); assert.equal(g.state(), 'cancelled'); assert.equal(g.storage.has(next), false)
})
test('adapter sends only an atomic status UPDATE filtered by id and confirmed, preserves row and distinguishes repeat/missing', async () => {
  for (const outcome of ['cancelled', 'already', 'missing', 'inactive', 'error']) {
    let patches = 0
    const deps = todayDependencies(env, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_OWNER_CHAT_ID }, async (url, init) => {
      const parsed = new URL(String(url)); assert.ok(!parsed.hostname.includes('telegram'))
      if (init?.method === 'PATCH') {
        patches++; assert.deepEqual(JSON.parse(String(init.body)), { status: 'cancelled' }); assert.equal(parsed.searchParams.get('id'), 'eq.123'); assert.equal(parsed.searchParams.get('status'), 'eq.confirmed')
        assert.equal(parsed.searchParams.get('select'), 'id,status')
        if (outcome === 'error') return Response.json({ code: '42501', message: 'PRIVATE' }, { status: 403 })
        return Response.json(outcome === 'cancelled' ? [{ id: 123, status: 'cancelled' }] : [])
      }
      assert.notEqual(init?.method, 'DELETE')
      return Response.json(outcome === 'missing' ? [] : [{ status: outcome === 'already' ? 'cancelled' : 'pending' }])
    })
    if (outcome === 'error') await assert.rejects(deps.cancelBooking!('123'), error => error instanceof TodayFailure && error.code === 'BOT_CANCEL_FAILED' && !error.message.includes('PRIVATE'))
    else assert.equal(await deps.cancelBooking!('123'), { cancelled: 'cancelled', already: 'already_cancelled', missing: 'not_found', inactive: 'not_active' }[outcome])
    assert.equal(patches, 1)
  }
})
test('Redis action tickets are random, owner-bound, expiring and atomically consumed', async () => {
  const values = new Map<string, string>(); const operations: string[] = []
  const redis: typeof fetch = async (_url, init) => {
    const args = JSON.parse(String(init?.body)); operations.push(args[0]); const key = args[1]
    if (args[0] === 'SET') { assert.equal(args[3], 'NX'); assert.equal(args[4], 'EX'); assert.ok([300, 1200].includes(args[5])); values.set(key, args[2]); return Response.json({ result: 'OK' }) }
    const result = values.get(key) ?? null; if (args[0] === 'GETDEL') values.delete(key)
    return Response.json({ result })
  }
  const tickets = bookingTickets(env, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OWNER_CHAT_ID, redis)
  const token = await tickets.issue({ booking_id: '123', page: 1, phase: 'confirm' })
  assert.match(token, /^[A-Za-z0-9_-]{22}$/)
  assert.equal(await bookingTickets(env, env.TELEGRAM_BOT_TOKEN, '999', redis).read(token, false), null)
  assert.equal((await tickets.read(token, true))?.booking_id, '123'); assert.equal(await tickets.read(token, true), null)
  assert.ok(operations.includes('GETDEL'))
})
test('unauthorized cancellation callbacks and invalid webhook secret do not read tickets or update records', async () => {
  let initialized = 0
  const handler = createTelegramWebhook(env, () => { initialized++; throw new Error('must not initialize') })
  for (const scenario of ['sender', 'chat', 'group', 'secret']) {
    const body = { update_id: 5, callback_query: { id: 'callback', data: 'booking:confirm:AAAAAAAAAAAAAAAAAAAAAA', from: { id: scenario === 'sender' ? 999 : 12345, is_bot: false }, message: { chat: { id: scenario === 'chat' ? 999 : 12345, type: scenario === 'group' ? 'group' : 'private' } } } }
    let status = 0; const res = { setHeader: () => {}, status: (s: number) => { status = s; return res }, json: () => res }
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': scenario === 'secret' ? 'wrong' : env.TELEGRAM_WEBHOOK_SECRET }, body } as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1])
    assert.equal(status, scenario === 'secret' ? 403 : 200)
  }
  assert.equal(initialized, 0)
})

test('weekly list creates selectable opaque actions and expired buttons cannot mutate records', async () => {
  const { sendBookings } = await import('../server/telegram-bookings.js')
  const f = fixture(); f.deps.load = async () => ({ rows: [card], truncated: false })
  await sendBookings(f.deps, now)
  const buttons = (f.sent[0].keyboard as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat()
  const selection = buttons.find(b => b.text === 'Открыть запись 1')!
  assert.match(selection.callback_data, /^booking:view:[A-Za-z0-9_-]{22}$/)
  assert.ok(!selection.callback_data.includes(card.client_name))
  f.storage.clear()
  await processBookingAction({ command: 'booking', bookingStep: 'view', actionToken: selection.callback_data.split(':')[2] }, f.deps, now)
  assert.match(f.sent.at(-1)!.text, /Кнопка устарела/); assert.equal(f.writes(), 0)
})

test('duplicate Telegram update acknowledges and cancels at most once', async () => {
  const f = fixture(); const token = await f.deps.tickets!.issue({ booking_id: '123', page: 0, phase: 'confirm' })
  const claimed = new Set<number>(); let acks = 0
  f.deps.claimUpdate = async id => { if (claimed.has(id)) return false; claimed.add(id); return true }
  f.deps.acknowledge = async () => { acks++ }
  const handler = createTelegramWebhook(env, () => f.deps, () => now)
  const body = { update_id: 10, callback_query: { id: 'callback', data: `booking:confirm:${token}`, from: { id: 12345, is_bot: false }, message: { chat: { id: 12345, type: 'private' } } } }
  async function request() {
    let status = 0; const res = { setHeader: () => {}, status: (s: number) => { status = s; return res }, json: () => res }
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }, body } as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1])
    return status
  }
  assert.deepEqual(await Promise.all([request(), request()]), [200, 200])
  assert.equal(acks, 1); assert.equal(f.writes(), 1)
})
