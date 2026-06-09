# PDF Editor — AI-powered

Редактор PDF-файлов на базе Claude AI. Работает прямо в браузере — файлы никуда не отправляются, Python выполняется локально через Pyodide.

## Возможности

- Замена текста
- Водяные знаки на всех страницах
- Удаление / извлечение страниц
- Нумерация страниц
- Поворот страниц
- Любые другие операции через текстовый запрос

## Деплой на Vercel

### 1. Клонируй репо и запушь на GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/pdf-editor.git
git push -u origin main
```

### 2. Подключи к Vercel

1. Зайди на [vercel.com](https://vercel.com) → New Project
2. Импортируй репозиторий с GitHub
3. Framework: **Next.js** (определится автоматически)
4. Добавь Environment Variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: твой ключ с [console.anthropic.com](https://console.anthropic.com)
5. Deploy

### Локальный запуск

```bash
cp .env.example .env.local
# Вставь свой ANTHROPIC_API_KEY в .env.local

npm install
npm run dev
# Открой http://localhost:3000
```

## Архитектура

- **Next.js 14** (App Router)
- **API Route** `/api/chat` — проксирует запросы к Anthropic, ключ хранится на сервере
- **Pyodide** — Python в браузере (pypdf + reportlab)
- Файлы обрабатываются локально, не покидают браузер пользователя
