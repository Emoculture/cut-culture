# CUT CULTURE

Демонстрационный сайт современной парикмахерской в стиле Dark Industrial.
React 19, TypeScript, Vite, обычный CSS. Интерфейс на русском языке.

## Запуск

Требуется Node.js 20.19+ или 22.12+ (проверено на Node.js 24).

```sh
npm ci
npm run dev
```

Проверка типов и production-сборка: `npm run build`.
Просмотр сборки: `npm run preview`.
Если домашний npm-кэш недоступен, используйте `npm ci --cache /tmp/cut-culture-npm-cache`.

## Структура

- `index.html` — HTML, метаданные и точка загрузки.
- `src/main.tsx` — подключение React и стилей.
- `src/App.tsx` — композиция разделов, состояние демонстрационного окна, анимации появления.
- `src/components/Header.tsx` — логотип, навигация, мобильное меню.
- `src/components/BookingDialog.tsx` — нативное модальное окно: фокус, Escape, закрытие по фону.
- `src/components/SectionTitle.tsx` — единый заголовок раздела.
- `src/data/content.ts` — демонстрационные услуги, цены, мастера, изображения галереи.
- `src/types/index.ts` — типы контента и предварительный контракт BookingIntent.
- `src/integrations/README.md` — настройка Supabase, серверного API записи и защита данных.
- `src/styles.css` — адаптивные стили, интерактивные состояния и reduced motion.
- `public/images/` — локальные демонстрационные фотографии.
- `public/fonts/` — локальные Manrope и Oswald и их лицензии OFL.
- `public/favicon.svg` — иконка сайта.
- `ASSETS.md` — происхождение медиа.
- `package.json`, `package-lock.json` — команды и фиксированные зависимости.
- `tsconfig.json`, `vite.config.ts` — настройки TypeScript и Vite.
- `.gitignore` — исключения зависимостей, сборки и локальных секретов.

## Каталог и запись

Каталог загружается из Supabase. Форма отправляет запись только через серверный
`POST /api/bookings`; секреты остаются на сервере. Для запуска на Vercel настройте
переменные и проверьте ограничение БД по [инструкции](src/integrations/README.md).
`npm test` проверяет серверную валидацию и обработку ошибок.
Фото и адрес по-прежнему демонстрационные. Платежей нет. Сервер отправляет владельцу Telegram-уведомление после успешного сохранения записи; настройка описана в src/integrations/README.md.
