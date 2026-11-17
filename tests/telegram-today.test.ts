import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTelegramWebhook } from '../api/telegram-webhook.js'
import { todayRange, todayMessages, secretMatches, TODAY_LIMIT } from '../server/telegram-today.js'
import { todayDependencies } from '../server/telegram-today-adapter.js'
import type { TodayDependencies } from '../server/telegram-today.js'
const env = { TELEGRAM_BOT_TOKEN: '123456:FAKE_TEST', TELEGRAM_OWNER_CHAT_ID: '12345', TELEGRAM_WEBHOOK_SECRET: 'fake_test_secret', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fake_test' }
const update = () => ({ update_id: 1, message: { text: '/today', chat: { id: 12345, type: 'private' }, from: { id: 12345, is_bot: false } } })
function request(body: unknown = update(), secret: unknown = env.TELEGRAM_WEBHOOK_SECRET) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body }
}
async function invoke(req: unknown, deps: TodayDependencies, config = env) {
  const headers: Record<string, unknown> = {}; let status = 0; let body: unknown; let initialized = 0
  const handler = createTelegramWebhook(config, () => { initialized++; return deps }, () => Date.parse('2026-11-16T21:05:00Z'))
  const res = { setHeader: (key: string, value: unknown) => { headers[key] = value }, status: (value: number) => { status = value; return res }, json: (value: unknown) => { body = value; return res } }
  await handler(req as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1])
  return { status, body, headers, initialized }
}
test('/today sends confirmed server data in Moscow time only to authorized private owner', async () => {
  let sent: string[] = []
  const result = await invoke(request(), {
    async load(start, end) {
      assert.equal(start, '2026-11-16T21:00:00.000Z'); assert.equal(end, '2026-11-17T21:00:00.000Z')
      return { rows: [{ starts_at: '2026-11-17T07:00:00Z', ends_at: '2026-11-17T08:00:00Z', client_name: 'Тестовый клиент', barber_name: 'Мастер', service_name: 'Укладка' }], truncated: false }
    }, async send(messages) { sent = messages },
  })
  assert.equal(result.status, 200); assert.equal(result.initialized, 1)
  for (const value of ['17.11.2026', '10:00', 'Тестовый клиент', 'Мастер', 'Укладка']) assert.ok(sent[0].includes(value))
  assert.deepEqual(result.body, { ok: true })
})
test('/today with empty schedule reports no confirmed bookings', async () => {
  let text = ''
  const result = await invoke(request(), { load: async () => ({ rows: [], truncated: false }), send: async messages => { text = messages.join('') } })
  assert.equal(result.status, 200); assert.match(text, /подтверждённых записей нет/)
})
test('wrong webhook secret is rejected before DB initialization or sending', async () => {
  const deps: TodayDependencies = { load: async () => { assert.fail('unauthorized DB access') }, send: async () => { assert.fail('unauthorized send') } }
  for (const secret of ['incorrect', undefined, [env.TELEGRAM_WEBHOOK_SECRET]]) {
    const req = request(); req.headers['x-telegram-bot-api-secret-token'] = secret as string
    const result = await invoke(req, deps)
    assert.equal(result.status, 403); assert.equal(result.initialized, 0)
  }
  assert.equal(secretMatches(env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_WEBHOOK_SECRET), true)
})
test('wrong sender, chat, group, bot, edited update and other commands cannot read customer data', async () => {
  const bodies: unknown[] = []
  let body = update(); body.message.from.id = 999; bodies.push(body)
  body = update(); body.message.chat.id = 999; bodies.push(body)
  body = update(); body.message.chat.type = 'group'; bodies.push(body)
  body = update(); body.message.from.is_bot = true; bodies.push(body)
  body = update(); body.message.text = '/help'; bodies.push(body)
  body = update(); body.message.text = '/today tomorrow'; bodies.push(body)
  bodies.push({ update_id: 1, edited_message: update().message }, null, { update_id: 1 })
  const deps: TodayDependencies = { load: async () => { assert.fail('unauthorized DB access') }, send: async () => { assert.fail('unauthorized send') } }
  for (const value of bodies) {
    const result = await invoke(request(value), deps)
    assert.equal(result.status, 200); assert.equal(result.initialized, 0); assert.deepEqual(result.body, { ok: true })
  }
})
test('Moscow day bounds handle midnight, year and leap-day boundaries', () => {
  assert.equal(todayRange(Date.parse('2026-11-16T20:59:59Z')).label, '16.11.2026')
  assert.equal(todayRange(Date.parse('2026-11-16T21:00:00Z')).label, '17.11.2026')
  assert.deepEqual(todayRange(Date.parse('2026-12-31T21:00:00Z')), { start: '2026-12-31T21:00:00.000Z', end: '2027-01-01T21:00:00.000Z', label: '01.01.2027' })
  assert.equal(todayRange(Date.parse('2028-02-28T21:00:00Z')).label, '29.02.2028')
})
test('long schedule splits into Telegram-safe plain-text messages with explicit truncation notice', () => {
  const rows = Array.from({ length: TODAY_LIMIT }, () => ({ starts_at: '2026-11-17T07:00:00Z', ends_at: '2026-11-17T08:00:00Z', client_name: 'К'.repeat(100), barber_name: '<b>Мастер</b>'.repeat(20), service_name: 'Услуга'.repeat(50) }))
  const messages = todayMessages(rows, '17.11.2026', true)
  assert.ok(messages.length > 1); assert.ok(messages.every(text => text.length < 4096))
  assert.match(messages.at(-1)!, /Показаны первые 200/)
  assert.equal(messages.join('').split('10:00').length - 1, TODAY_LIMIT)
})
test('Supabase query filters confirmed bookings to half-open day and never selects phones', async () => {
  let bookingsRead = false; let sent = false
  const deps = todayDependencies(env, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_OWNER_CHAT_ID }, async (url, init) => {
    const parsed = new URL(String(url))
    if (parsed.hostname === 'api.telegram.org') {
      const message = JSON.parse(String(init?.body)); assert.equal(message.chat_id, env.TELEGRAM_OWNER_CHAT_ID)
      assert.equal(message.parse_mode, undefined); sent = true; return Response.json({ ok: true })
    }
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    assert.equal(new Headers(init?.headers).get('apikey'), env.SUPABASE_SECRET_KEY)
    if (parsed.pathname.endsWith('bookings')) {
      bookingsRead = true
      assert.equal(parsed.searchParams.get('select'), 'starts_at,ends_at,client_name,barber_id,service_id')
      assert.equal(parsed.searchParams.get('status'), 'eq.confirmed')
      assert.deepEqual(parsed.searchParams.getAll('starts_at'), ['gte.2026-11-16T21:00:00.000Z', 'lt.2026-11-17T21:00:00.000Z'])
      assert.equal(parsed.searchParams.get('order'), 'starts_at.asc')
      return Response.json([{ starts_at: '2026-11-17T07:00:00Z', ends_at: '2026-11-17T08:00:00Z', client_name: 'Клиент', barber_id: 1, service_id: 2 }])
    }
    return Response.json(parsed.pathname.endsWith('barbers') ? [{ id: 1, name: 'Мастер' }] : [{ id: 2, name: 'Услуга' }])
  })
  const result = await deps.load('2026-11-16T21:00:00.000Z', '2026-11-17T21:00:00.000Z')
  assert.ok(bookingsRead); assert.equal(result.rows[0].barber_name, 'Мастер')
  await deps.send(todayMessages(result.rows, '17.11.2026')); assert.ok(sent)
})
test('webhook failures log only fixed reason and request ID, never exception or customer data', async t => {
  const logs: string[] = []; t.mock.method(console, 'error', (message: string) => { logs.push(message) })
  const result = await invoke(request(), { load: async () => { throw new Error('PRIVATE_TOKEN CUSTOMER PHONE') }, send: async () => {} })
  assert.equal(result.status, 503)
  assert.deepEqual(logs.map(text => JSON.parse(text)), [{ event: 'telegram_webhook_failed', code: 'TODAY_UNEXPECTED_FAILURE', request_id: result.headers['X-Request-ID'] }])
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE'))
})

test('/tomorrow uses the next Moscow calendar day, including month/year/leap transitions', async () => {
  const { dayRange } = await import('../server/telegram-today.js')
  const cases = [
    ['2026-11-16T20:59:59Z', '2026-11-16T21:00:00.000Z', '2026-11-17T21:00:00.000Z', '17.11.2026'],
    ['2026-11-16T21:00:00Z', '2026-11-17T21:00:00.000Z', '2026-11-18T21:00:00.000Z', '18.11.2026'],
    ['2026-01-30T21:30:00Z', '2026-01-31T21:00:00.000Z', '2026-02-01T21:00:00.000Z', '01.02.2026'],
    ['2026-12-30T21:30:00Z', '2026-12-31T21:00:00.000Z', '2027-01-01T21:00:00.000Z', '01.01.2027'],
    ['2028-02-27T21:30:00Z', '2028-02-28T21:00:00.000Z', '2028-02-29T21:00:00.000Z', '29.02.2028'],
    ['2028-02-28T21:30:00Z', '2028-02-29T21:00:00.000Z', '2028-03-01T21:00:00.000Z', '01.03.2028'],
  ]
  for (const [now, start, end, label] of cases) assert.deepEqual(dayRange(Date.parse(now), 'tomorrow'), { start, end, label })
})

test('/tomorrow routes through the same webhook and formats sorted start/end intervals', async () => {
  const body = update(); body.message.text = '/tomorrow@CutCultureBot'
  const later = { starts_at: '2026-11-18T12:00:00Z', ends_at: '2026-11-18T13:00:00Z', client_name: 'Борис', service_name: 'Стрижка', barber_name: 'Мастер Б' }
  const earlier = { starts_at: '2026-11-18T07:00:00Z', ends_at: '2026-11-18T07:30:00Z', client_name: 'Анна', service_name: 'Укладка', barber_name: 'Мастер А' }
  const rows = [later, earlier]; let text = ''
  const result = await invoke(request(body), {
    async load(start, end) {
      assert.equal(start, '2026-11-17T21:00:00.000Z'); assert.equal(end, '2026-11-18T21:00:00.000Z')
      return { rows, truncated: false }
    }, async send(messages) { text = messages.join('\n') },
  })
  assert.equal(result.status, 200); assert.equal(result.initialized, 1)
  assert.ok(text.includes('Записи на 18.11.2026 (Москва)'))
  assert.ok(text.includes('10:00–10:30 · Анна · Укладка · Мастер А'))
  assert.ok(text.includes('15:00–16:00 · Борис · Стрижка · Мастер Б'))
  assert.ok(text.indexOf('10:00') < text.indexOf('15:00')); assert.equal(rows[0], later)
})

test('/tomorrow empty schedule returns the specified message', async () => {
  const body = update(); body.message.text = '/tomorrow'; let messages: string[] = []
  const result = await invoke(request(body), { load: async () => ({ rows: [], truncated: false }), send: async text => { messages = text } })
  assert.equal(result.status, 200); assert.equal(messages.length, 1)
  assert.equal(messages[0].split('\n').at(-1), 'На завтра подтверждённых записей нет')
})

test('/tomorrow denies wrong secret, sender, chat, group and bot before reading bookings', async () => {
  const deps: TodayDependencies = { load: async () => { assert.fail('unauthorized read') }, send: async () => { assert.fail('unauthorized send') } }
  const body = update(); body.message.text = '/tomorrow'
  const rejected = await invoke(request(body, 'wrong-secret'), deps)
  assert.equal(rejected.status, 403); assert.equal(rejected.initialized, 0)
  for (const scenario of ['sender', 'chat', 'group', 'bot', 'arguments']) {
    const unauthorized = update(); unauthorized.message.text = '/tomorrow'
    if (scenario === 'sender') unauthorized.message.from.id = 999
    if (scenario === 'chat') unauthorized.message.chat.id = 999
    if (scenario === 'group') unauthorized.message.chat.type = 'supergroup'
    if (scenario === 'bot') unauthorized.message.from.is_bot = true
    if (scenario === 'arguments') unauthorized.message.text = '/tomorrow next'
    const result = await invoke(request(unauthorized), deps)
    assert.equal(result.status, 200); assert.equal(result.initialized, 0); assert.deepEqual(result.body, { ok: true })
  }
})

const callbackUpdate = (data: string) => ({ update_id: 2, callback_query: { id: 'test_callback_id', data, from: { id: 12345, is_bot: false }, message: { chat: { id: 12345, type: 'private' }, from: { id: 777, is_bot: true } } } })

test('/start and /menu show greeting with today/tomorrow inline buttons without DB reads', async () => {
  const { mainMenu } = await import('../server/telegram-menu.js')
  for (const command of ['/start', '/menu', '/menu@CutCultureBot']) {
    const body = update(); body.message.text = command; let calls = 0
    const result = await invoke(request(body), {
      load: async () => { assert.fail('menu must not load bookings') },
      send: async (messages, keyboard) => {
        calls++; assert.match(messages.join(''), /Здравствуйте/); assert.deepEqual(keyboard, mainMenu)
        assert.deepEqual(keyboard?.inline_keyboard[0].map(button => button.text), ['📅 Сегодня', '📆 Завтра'])
      },
    })
    assert.equal(result.status, 200); assert.equal(calls, 1)
  }
})

test('today/tomorrow callbacks acknowledge first, reuse schedule range and attach home button', async () => {
  const { homeMenu } = await import('../server/telegram-menu.js')
  for (const day of ['today', 'tomorrow']) {
    const calls: string[] = []
    const result = await invoke(request(callbackUpdate(`schedule:${day}`)), {
      acknowledge: async id => { assert.equal(id, 'test_callback_id'); calls.push('ack') },
      load: async (start, end) => {
        assert.deepEqual(calls, ['ack']); calls.push('load')
        assert.equal(start, day === 'today' ? '2026-11-16T21:00:00.000Z' : '2026-11-17T21:00:00.000Z')
        assert.equal(end, day === 'today' ? '2026-11-17T21:00:00.000Z' : '2026-11-18T21:00:00.000Z')
        return { rows: [], truncated: false }
      },
      send: async (_messages, keyboard) => { calls.push('send'); assert.deepEqual(keyboard, homeMenu) },
    })
    assert.equal(result.status, 200); assert.deepEqual(calls, ['ack', 'load', 'send'])
  }
})

test('home callback opens menu; unknown owner callback is acknowledged without data access', async () => {
  const { mainMenu } = await import('../server/telegram-menu.js')
  for (const data of ['menu:main', 'unsupported']) {
    let acks = 0; let sends = 0
    const result = await invoke(request(callbackUpdate(data)), {
      acknowledge: async () => { acks++ },
      load: async () => { assert.fail('no data read') },
      send: async (_text, keyboard) => { sends++; assert.deepEqual(keyboard, mainMenu) },
    })
    assert.equal(result.status, 200); assert.equal(acks, 1); assert.equal(sends, data === 'menu:main' ? 1 : 0)
  }
})

test('text schedule commands still work with a home button', async () => {
  const { homeMenu } = await import('../server/telegram-menu.js')
  for (const command of ['/today', '/tomorrow']) {
    const body = update(); body.message.text = command; let sent = 0
    const result = await invoke(request(body), {
      load: async () => ({ rows: [], truncated: false }),
      acknowledge: async () => { assert.fail('text command is not a callback') },
      send: async (_text, keyboard) => { sent++; assert.deepEqual(keyboard, homeMenu) },
    })
    assert.equal(result.status, 200); assert.equal(sent, 1)
  }
})

test('menu commands require owner sender AND private owner chat', async () => {
  for (const command of ['/start', '/menu']) {
    for (const scenario of ['sender', 'chat', 'group', 'bot']) {
      const body = update(); body.message.text = command
      if (scenario === 'sender') body.message.from.id = 999
      if (scenario === 'chat') body.message.chat.id = 999
      if (scenario === 'group') body.message.chat.type = 'group'
      if (scenario === 'bot') body.message.from.is_bot = true
      const result = await invoke(request(body), { load: async () => { assert.fail('no read') }, send: async () => { assert.fail('no send') } })
      assert.equal(result.status, 200); assert.equal(result.initialized, 0)
    }
  }
})

test('forged callbacks, inline callbacks and wrong webhook secrets never access data or Telegram', async () => {
  const deps: TodayDependencies = { load: async () => { assert.fail('unauthorized read') }, send: async () => { assert.fail('unauthorized send') }, acknowledge: async () => { assert.fail('unauthorized callback') } }
  for (const scenario of ['sender', 'chat', 'group', 'bot', 'missingMessage', 'messageSenderSpoof']) {
    const body = callbackUpdate('schedule:today')
    if (scenario === 'sender') body.callback_query.from.id = 999
    if (scenario === 'chat') body.callback_query.message.chat.id = 999
    if (scenario === 'group') body.callback_query.message.chat.type = 'supergroup'
    if (scenario === 'bot') body.callback_query.from.is_bot = true
    if (scenario === 'missingMessage') delete (body.callback_query as { message?: unknown }).message
    if (scenario === 'messageSenderSpoof') { body.callback_query.message.from.id = 12345; body.callback_query.from.id = 999 }
    const result = await invoke(request(body), deps)
    assert.equal(result.status, 200); assert.equal(result.initialized, 0)
  }
  const result = await invoke(request(callbackUpdate('schedule:today'), 'wrong-secret'), deps)
  assert.equal(result.status, 403); assert.equal(result.initialized, 0)
})

test('Telegram adapter answers callbacks and sends menu without Supabase configuration', async () => {
  const { mainMenu, homeMenu } = await import('../server/telegram-menu.js')
  const methods: string[] = []
  const deps = todayDependencies({}, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_OWNER_CHAT_ID }, async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'api.telegram.org')
    const method = String(url).split('/').at(-1)!; methods.push(method)
    const body = JSON.parse(String(init?.body))
    if (method === 'answerCallbackQuery') assert.deepEqual(body, { callback_query_id: 'test_callback_id' })
    else {
      assert.equal(body.chat_id, env.TELEGRAM_OWNER_CHAT_ID); assert.equal(body.parse_mode, undefined)
      assert.deepEqual(body.reply_markup, methods.length === 2 ? mainMenu : homeMenu)
    }
    return Response.json({ ok: true })
  })
  await deps.acknowledge!('test_callback_id'); await deps.send(['Menu'], mainMenu); await deps.send(['Schedule'], homeMenu)
  assert.deepEqual(methods, ['answerCallbackQuery', 'sendMessage', 'sendMessage'])
})

test('Telegram callback and menu failures have safe codes and never load schedule after ack failure', async t => {
  const { TodayFailure } = await import('../server/telegram-today.js')
  for (const method of ['ack', 'send']) {
    for (const scenario of ['http', 'network', 'json', 'rejected']) {
      const deps = todayDependencies({}, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_OWNER_CHAT_ID }, async () => {
        if (scenario === 'http') return new Response('PRIVATE', { status: 500 })
        if (scenario === 'network') throw new Error('PRIVATE token')
        if (scenario === 'json') return new Response('PRIVATE')
        return Response.json({ ok: false, description: 'PRIVATE' })
      })
      await assert.rejects(method === 'ack' ? deps.acknowledge!('test_callback_id') : deps.send(['Menu']), error => error instanceof TodayFailure && error.code === (method === 'ack' ? 'BOT_CALLBACK_FAILED' : 'TODAY_SEND_FAILED') && !error.message.includes('PRIVATE'))
    }
  }
  const logs: string[] = []; t.mock.method(console, 'error', (value: string) => { logs.push(value) })
  const result = await invoke(request(callbackUpdate('schedule:today')), {
    acknowledge: async () => { throw new TodayFailure('BOT_CALLBACK_FAILED') },
    load: async () => { assert.fail('must not load after ack failure') }, send: async () => { assert.fail('must not send after ack failure') },
  })
  assert.equal(result.status, 503)
  assert.deepEqual(logs.map(text => JSON.parse(text)), [{ event: 'telegram_webhook_failed', code: 'BOT_CALLBACK_FAILED', request_id: result.headers['X-Request-ID'] }])
})
