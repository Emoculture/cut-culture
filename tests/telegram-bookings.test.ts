import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingsRange, bookingsPage, BOOKINGS_PAGE_SIZE } from '../server/telegram-bookings.js'
import { createTelegramWebhook } from '../api/telegram-webhook.js'
import { todayDependencies } from '../server/telegram-today-adapter.js'
import { updateGuard } from '../server/telegram-update-guard.js'
import { TodayFailure, ownerBotAction } from '../server/telegram-today.js'
import { mainMenu } from '../server/telegram-menu.js'
import type { TodayDependencies, TodayBooking } from '../server/telegram-today.js'
const env = { TELEGRAM_BOT_TOKEN: '12345:FAKE', TELEGRAM_OWNER_CHAT_ID: '12345', TELEGRAM_WEBHOOK_SECRET: 'test_secret', SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'sb_secret_fake', UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'fake_redis' }
const now = Date.parse('2026-11-16T21:05:00Z')
const row = (start = '2026-11-17T07:00:00Z'): TodayBooking => ({ starts_at: start, ends_at: new Date(Date.parse(start) + 3600000).toISOString(), client_name: 'Клиент', barber_name: 'Мастер', service_name: 'Услуга' })
function update(text = '/bookings', id = 5): any {
  return { update_id: id, message: { text, chat: { id: 12345, type: 'private' }, from: { id: 12345, is_bot: false } } }
}
function callback(data = 'bookings:open', id = 5): any {
  return { update_id: id, callback_query: { id: 'test_callback', data, from: { id: 12345, is_bot: false }, message: { chat: { id: 12345, type: 'private' } } } }
}
async function invoke(body: unknown, deps: TodayDependencies, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  const handler = createTelegramWebhook(env, () => ({ claimUpdate: async () => true, ...deps }), () => now)
  let status = 0; let result: unknown
  const res = { setHeader: () => {}, status: (s: number) => { status = s; return res }, json: (value: unknown) => { result = value; return res } }
  await handler({ method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body } as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1])
  return { status, result }
}

test('seven calendar days use Moscow midnight across month, year and leap-day boundaries', () => {
  for (const [date, start, end] of [
    ['2026-11-16T21:05:00Z', '2026-11-16T21:00:00.000Z', '2026-11-23T21:00:00.000Z'],
    ['2026-01-29T12:00:00Z', '2026-01-28T21:00:00.000Z', '2026-02-04T21:00:00.000Z'],
    ['2026-12-29T21:01:00Z', '2026-12-29T21:00:00.000Z', '2027-01-05T21:00:00.000Z'],
    ['2028-02-27T12:00:00Z', '2028-02-26T21:00:00.000Z', '2028-03-04T21:00:00.000Z'],
  ]) {
    const range = bookingsRange(Date.parse(date)); assert.equal(range.start, start); assert.equal(range.end, end)
    assert.equal(Date.parse(range.end) - Date.parse(range.start), 7 * 86400000)
  }
})
test('list button and command route to paginated weekly read, with callback acknowledged first', async () => {
  assert.ok(mainMenu.inline_keyboard.flat().some(b => b.text === '📋 Все записи' && b.callback_data === 'bookings:open'))
  for (const body of [update(), update('/bookings@CutBot'), callback(), callback('bookings:page:2')]) {
    const events: string[] = []; let keyboard: unknown
    const result = await invoke(body, {
      claimUpdate: async () => { events.push('claim'); return true },
      acknowledge: async () => { events.push('ack') },
      load: async (start, end, page) => {
        events.push('read'); assert.equal(start, '2026-11-16T21:00:00.000Z'); assert.equal(end, '2026-11-23T21:00:00.000Z')
        assert.deepEqual(page, { offset: body.callback_query?.data === 'bookings:page:2' ? 20 : 0, limit: 10 })
        return { rows: [row()], truncated: true }
      },
      send: async (_text, markup) => { events.push('send'); keyboard = markup },
    })
    assert.equal(result.status, 200); assert.deepEqual(events, body.callback_query ? ['claim', 'ack', 'read', 'send'] : ['claim', 'read', 'send'])
    assert.ok(JSON.stringify(keyboard).includes('🏠 Главное меню'))
  }
})
test('weekly response groups and sorts dates and start times without mutating rows', () => {
  const rows = [row('2026-11-18T08:00:00Z'), row('2026-11-17T09:00:00Z'), row('2026-11-17T07:00:00Z')]
  const result = bookingsPage(rows, bookingsRange(now).label, 0, false)
  assert.ok(result.text.indexOf('17.11.2026') < result.text.lastIndexOf('18.11.2026'))
  assert.ok(result.text.indexOf('10:00–11:00') < result.text.indexOf('12:00–13:00'))
  assert.equal(result.text.split('📅 17.11.2026').length - 1, 1)
  for (const name of ['Клиент', 'Мастер', 'Услуга']) assert.ok(result.text.includes(name))
  assert.equal(rows[0].starts_at, '2026-11-18T08:00:00Z')
})
test('empty list and first/middle/last page navigation fit Telegram and contain no PII in callbacks', () => {
  const empty = bookingsPage([], 'test', 0, false); assert.equal(empty.text, 'На ближайшие 7 дней записей нет')
  const rows = Array.from({ length: BOOKINGS_PAGE_SIZE }, (_, i) => ({ ...row(`2026-11-${17 + i % 7}T07:00:00Z`), client_name: 'К'.repeat(100), barber_name: 'М'.repeat(100), service_name: 'У'.repeat(100) }))
  for (const [page, next] of [[0, true], [1, true], [2, false]] as const) {
    const result = bookingsPage(rows, bookingsRange(now).label, page, next)
    assert.ok(result.text.length < 4096)
    const buttons = result.keyboard.inline_keyboard.flat()
    assert.equal(buttons.some(b => b.text === '⬅️ Назад'), page > 0)
    assert.equal(buttons.some(b => b.text === 'Вперёд ➡️'), next)
    assert.ok(buttons.every(b => /^(bookings:page:\d+|menu:main)$/.test(b.callback_data) && Buffer.byteLength(b.callback_data) <= 64))
  }
  assert.match(bookingsPage([], 'test', 3, false).text, /Вернитесь назад/)
})
test('Supabase page uses confirmed filter, stable ordering, offset and one lookahead row', async () => {
  const deps = todayDependencies(env, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_OWNER_CHAT_ID }, async url => {
    const parsed = new URL(String(url))
    if (parsed.pathname.endsWith('/bookings')) {
      assert.equal(parsed.searchParams.get('status'), 'eq.confirmed')
      assert.equal(parsed.searchParams.get('order'), 'starts_at.asc,id.asc')
      assert.equal(parsed.searchParams.get('offset'), '10'); assert.equal(parsed.searchParams.get('limit'), '11')
      assert.deepEqual(parsed.searchParams.getAll('starts_at'), ['gte.2026-11-16T21:00:00.000Z', 'lt.2026-11-23T21:00:00.000Z'])
      assert.ok(!parsed.searchParams.get('select')!.includes('phone'))
      return Response.json(Array.from({ length: 11 }, () => ({ ...row(), barber_id: 1, service_id: 2 })))
    }
    return Response.json([{ id: parsed.pathname.endsWith('/barbers') ? 1 : 2, name: 'Название из базы' }])
  })
  const result = await deps.load(bookingsRange(now).start, bookingsRange(now).end, { offset: 10, limit: 10 })
  assert.equal(result.rows.length, 10); assert.equal(result.truncated, true)
})
test('unauthorized weekly commands/buttons and wrong secret never claim updates or read/send data', async () => {
  const deps: TodayDependencies = { claimUpdate: async () => { assert.fail('no claim') }, load: async () => { assert.fail('no read') }, send: async () => { assert.fail('no send') }, acknowledge: async () => { assert.fail('no ack') } }
  for (const base of [update(), callback()]) {
    for (const scenario of ['sender', 'chat', 'group']) {
      const body = structuredClone(base); const actor = body.callback_query ?? body.message; const message = body.callback_query?.message ?? body.message
      if (scenario === 'sender') actor.from.id = 999
      if (scenario === 'chat') message.chat.id = 999
      if (scenario === 'group') message.chat.type = 'group'
      assert.equal((await invoke(body, deps)).status, 200)
    }
  }
  assert.equal((await invoke(callback(), deps, 'wrong')).status, 403)
  for (const value of ['bookings:page:-1', 'bookings:page:10000', 'bookings:page:1:PRIVATE']) assert.equal(ownerBotAction(callback(value), env.TELEGRAM_OWNER_CHAT_ID)?.command, 'ignore')
})
test('atomic Redis claim works across instances and retains failed attempts to prevent duplicate sends', async t => {
  const stored = new Set<string>(); const commands: unknown[][] = []
  const redis: typeof fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body)); commands.push(command)
    assert.deepEqual([command[0], ...command.slice(2)], ['SET', 'claimed', 'NX', 'EX', 604800])
    assert.match(command[1], /^cut-culture:telegram:update:[a-f0-9]{64}$/)
    const exists = stored.has(command[1]); stored.add(command[1]); return Response.json({ result: exists ? null : 'OK' })
  }
  let sends = 0; let acks = 0; let loads = 0
  const deps = (): TodayDependencies => ({ claimUpdate: updateGuard(env, env.TELEGRAM_BOT_TOKEN, redis), acknowledge: async () => { acks++ }, load: async () => { loads++; return { rows: [], truncated: false } }, send: async () => { sends++ } })
  const responses = await Promise.all([invoke(callback(), deps()), invoke(callback(), deps()), invoke(callback(), deps())])
  assert.ok(responses.every(r => r.status === 200)); assert.equal(sends, 1); assert.equal(acks, 1); assert.equal(loads, 1)
  t.mock.method(console, 'error', () => {})
  const fail = deps(); fail.send = async () => { sends++; throw new Error('PRIVATE ambiguous send') }
  assert.equal((await invoke(update('/bookings', 99), fail)).status, 503)
  const before = sends
  assert.equal((await invoke(update('/bookings', 99), deps())).status, 200); assert.equal(sends, before)
  assert.equal((await invoke(update('/bookings', 100), deps())).status, 200); assert.equal(sends, before + 1)
})
test('Redis failures fail closed without data access or leaking upstream errors', async t => {
  t.mock.method(console, 'error', () => {})
  for (const mock of [async () => { throw new Error('PRIVATE token') }, async () => new Response('PRIVATE', { status: 401 }), async () => Response.json({ error: 'PRIVATE' }), async () => Response.json({ result: 'bad' })]) {
    const deps: TodayDependencies = { claimUpdate: updateGuard(env, env.TELEGRAM_BOT_TOKEN, mock), load: async () => { assert.fail('no query') }, send: async () => { assert.fail('no send') } }
    assert.equal((await invoke(update(), deps)).status, 503)
    await assert.rejects(deps.claimUpdate!(5), error => error instanceof TodayFailure && error.code === 'BOT_DEDUP_FAILED' && !error.message.includes('PRIVATE'))
  }
})

test('webhook fails closed if update guard is absent', async t => {
  t.mock.method(console, 'error', () => {})
  const result = await invoke(update(), { claimUpdate: undefined, load: async () => { assert.fail('no read without guard') }, send: async () => { assert.fail('no send without guard') } })
  assert.equal(result.status, 503)
})
