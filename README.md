# Evently Analytics

A minimal Node.js 20 + TypeScript + Express app scaffold (no database) with security middleware and EJS + Bootstrap 5 views.

## Features
- Express 4 + TypeScript
- EJS templating with layout & partials
- Bootstrap 5 styling (CDN)
- Security: helmet, cors, cookie-session, csurf, morgan logging
- Environment variables via dotenv
- Ready for future event ingestion endpoints

## Getting Started

### 1. Install Dependencies
```
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and adjust values as needed.
```
cp .env.example .env
```

### 3. Run in Development (watch mode)
```
npm run dev
```
Visit: http://localhost:3000

### 4. Build & Start (production style)
```
npm run build
npm start
```

## Scripts
- `dev` – Run with tsx watch (hot reload).
- `build` – TypeScript compile to `dist`.
- `start` – Run compiled server.

## Environment Variables
| Name | Description | Default |
|------|-------------|---------|
| APP_NAME | Display name in templates | Evently Analytics |
| APP_BASE_URL | Base URL of app | http://localhost:3000 |
| PORT | HTTP port | 3000 |
| SESSION_SECRET | Cookie session secret (change in prod) | dev_change_me |
| DATABASE_URL | Placeholder for future persistence | (empty) |

## Security Middleware
- `helmet` – Sets HTTP security headers.
- `cors` – Enables cross-origin requests (adjust origin in production).
- `cookie-session` – Lightweight, signed, encrypted cookie session.
- `csurf` – CSRF protection for forms / state-changing requests.
- `morgan` – HTTP request logging.

## Project Structure
```
src/
  app.ts        # Express app configuration
  server.ts     # HTTP server bootstrapping
views/          # EJS templates (layout, partials, pages)
public/         # Static assets (CSS, images, etc.)
```

## Adding a New Page
1. Create a new `.ejs` file in `views/`.
2. Start with `<% layout('layout') -%>`.
3. Add route in `app.ts` that calls `res.render('<name>')`.

## CSRF Tokens
CSRF token is exposed to templates as `csrfToken`. Include as hidden field in forms:
```html
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
```

## Future Enhancements (Ideas)
- Event ingestion endpoint (`POST /events`)
- Rate limiting (e.g., express-rate-limit)
- Persistent session store & database
- Authentication (API keys / JWT)

## License
ISC
