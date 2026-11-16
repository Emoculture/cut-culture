# Диагностика 503 в Vercel

Все управляемые ветки 503 возвращают безопасный `code` и заголовок
`X-Request-ID`. В Function Logs на уровне Error появляется одна JSON-строка:

```json
{"event":"booking_failed","status":503,"code":"REDIS_TIMEOUT","request_id":"01234567-89ab-4def-8123-456789abcdef"}
```

Это не персональные данные: код берётся из фиксированного списка, UUID создаётся
на сервере. Тела запросов/ответов внешних сервисов, значения полей/переменных,
ключи, токены, IP, даты записей, тексты исключений и стеки не логируются.
Не включать дампы env или payload при дальнейшей диагностике.

## Все ветки 503

| Код / группа | Что проверять |
| --- | --- |
| CONFIG_SUPABASE_URL_MISSING, CONFIG_SUPABASE_SECRET_KEY_MISSING | Наличие непустых серверных переменных SUPABASE_URL, SUPABASE_SECRET_KEY |
| CONFIG_ORIGIN_MISSING | BOOKING_ALLOWED_ORIGIN |
| CONFIG_REDIS_URL_MISSING, CONFIG_REDIS_TOKEN_MISSING | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN |
| CONFIG_SUPABASE_URL_INVALID, CONFIG_REDIS_URL_INVALID | Корректный HTTPS URL без credentials; Redis REST URL, не redis:// |
| CONFIG_ORIGIN_INVALID | Точный HTTPS origin без path, завершающего /, query или credentials |
| SUPABASE_CLIENT_INIT_FAILED | Инициализация SDK (исключение перехвачено, его текст намеренно скрыт) |
| FORWARDED_IP_MISSING | Vercel ingress не передал x-forwarded-for; не подставлять IP из недоверенного источника |
| REDIS_TIMEOUT, REDIS_NETWORK_FAILED | Таймаут 3 секунды, доступность Upstash, DNS/TLS/сеть |
| REDIS_AUTH_FAILED | HTTP 401/403: правильный REST token, его актуальность и соответствие Redis URL |
| REDIS_HTTP_FAILED | Другой неуспешный HTTP-ответ Redis: состояние сервиса, лимиты провайдера |
| REDIS_RESPONSE_INVALID | Невалидный/непрочитанный JSON, error от Redis/EVAL, неверный result |
| SUPABASE_BARBER_QUERY_FAILED, SUPABASE_SERVICE_QUERY_FAILED | Ошибка SELECT конкретной таблицы; в том числе сеть/таймаут/неизвестный ответ SDK |
| SUPABASE_INSERT_FAILED | Ошибка INSERT или неоднозначный сетевой результат; запись могла сохраниться, автоматически не повторять |
| SUPABASE_AUTH_FAILED | Известные коды PostgREST PGRST301/PGRST302: серверный ключ/аутентификация |
| SUPABASE_PERMISSION_DENIED | PostgreSQL 42501: права серверного доступа; не открывать публичный доступ |
| SUPABASE_SCHEMA_MISMATCH | Известные ошибки таблицы/колонки/кеша схемы (PGRST204/205, 42P01, 42703) |
| SUPABASE_CONSTRAINT_FAILED | Известные нарушения NOT NULL/FK/UNIQUE/CHECK (23502/23503/23505/23514) |
| SERVICE_DURATION_INVALID | duration_minutes не целое число в диапазоне 1–720 |
| REDIS_UNEXPECTED_FAILURE, SUPABASE_CATALOG_UNEXPECTED_FAILURE, SUPABASE_INSERT_UNEXPECTED_FAILURE | Непредвиденное исключение с указанием стадии |
| BOOKING_UNEXPECTED_FAILURE, HANDLER_UNEXPECTED_FAILURE | Прочее исключение в ядре/обёртке обработчика |

Известные SQL-коды преобразуются в фиксированные категории; исходные ошибки
не выводятся. SDK может представить сетевую ошибку как общий PostgREST error:
тогда будет код соответствующего запроса/INSERT, без утверждения о точной причине.
Временно недоступный каталог, Redis, конфигурация и неудачная вставка не сообщают
об успехе. Exclusion violation 23P01 по-прежнему возвращает 409, лимит — 429,
Origin — 403; ни Redis, ни Origin, ни RLS не отключены.

## Что проверить на https://cut-culture.vercel.app

1. Убедиться, что основной домен указывает на deployment с новым коммитом main.
2. В Vercel Settings → Environment Variables проверить именно окружение
   **Production** и наличие всех пяти серверных переменных из таблицы выше.
   Preview-переменные в Production не переносятся автоматически. После изменений
   сделать redeploy. Не пересылать значения ключей или скриншоты с ними.
3. BOOKING_ALLOWED_ORIGIN должен быть ровно `https://cut-culture.vercel.app`.
   Несовпадающий, но корректный origin даёт 403; неправильный формат конфига — 503.
4. SUPABASE_URL должен указывать на тот же проект, что VITE_SUPABASE_URL.
   Сервер использует SUPABASE_SECRET_KEY, а не publishable key. Проверить ключ
   администратором, не помещая его в VITE_*. Проверить состояние проекта Supabase.
5. Redis URL/token должны быть от одной базы Upstash и разрешать EVAL/INCR/EXPIRE.
   Проверить состояние/квоты Upstash. При сбое Redis сервер продолжает отказывать.
6. Сопоставить `code` и `X-Request-ID` из ответа с `booking_failed` в Runtime Logs
   нужного deployment, времени запроса и уровня **Error** (400 логируется как Warn).
   Не пересылать JSON формы с именем/телефоном.
7. Если нет X-Request-ID и booking_failed, запрос мог не дойти до обработчика
   (маршрутизация, импорт/запуск функции, лимит платформы, Firewall или лог-фильтры).
   Проверить Vercel invocation/error details и статус развёртывания. Такие ошибки
   до запуска функции невозможно залогировать внутри неё.

`[tls-profile] applied 'commercial/2025'` не определяет, какая ветка 503 сработала.
Доступа к production env и логам в Codex нет, поэтому конкретная причина не
подтверждена. Локальные тесты используют подменённый fetch/repository, проверяют
реальный адаптер Supabase SDK и обёртку Vercel, не создавая записей в базе.

Политики/схема БД не менялись. Публичные INSERT/SELECT bookings не добавляются.
