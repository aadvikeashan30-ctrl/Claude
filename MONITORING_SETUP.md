# AI Employee Monitoring — Setup Guide

End-to-end real-time monitoring with hourly email digests sent to `aicodeorigin@gmail.com` (or any address you choose).

## What's in this repo

```
Claude/
├── login.html           Employee login page (starts a session)
├── workspace.html       Tracked work portal — runs the tracker continuously
├── tracker.js           Browser tracking module (active/idle, kbd/mouse, tabs)
├── dashboard.html       Admin live dashboard (auto-fetches from server)
├── index.html           Original employee registration form (separate flow)
└── server/
    ├── server.js        Node.js + Express + Nodemailer + node-cron backend
    ├── package.json
    ├── .env.example     Copy to .env and fill in real values
    └── data/            Auto-created — sessions persist here as JSON
```

## What's tracked vs. not tracked

**Tracked (only on monitored pages, while the browser tab is open):**
- Login & logout times
- Active vs. idle time (idle = no input for 5+ minutes)
- Keyboard event count (counts only — never key contents)
- Mouse event count (clicks, scrolls, movement)
- Tab visibility changes (focus/blur)
- Self-reported task counts vs. tracker-confirmed counts (honesty signal)

**Never tracked:**
- Keystroke content, passwords, chat messages
- Screen recordings or screenshots
- Activity in other apps, other websites, or when the browser is closed
- Camera, microphone, or location

> **Honest scope note:** A browser-based tracker can only see the tab(s) it's loaded into. It cannot monitor Slack, VS Code, gaming apps, or other websites. For OS-wide monitoring you would need a desktop agent (e.g. Electron) — not part of this project.

## Step 1 — Run the server

Requires Node.js 18+.

```bash
cd Claude/server
npm install
cp .env.example .env
# edit .env with your real values (see below)
npm start
```

You should see:

```
✨ AI Employee Monitoring server
   Listening:        http://localhost:3001
   Email recipient:  aicodeorigin@gmail.com
   Email configured: yes
   Digest interval:  every 60 minute(s)
```

## Step 2 — Configure Gmail SMTP

The server uses a Gmail account to send the digest. You need an **App Password** (Google does not allow regular passwords for SMTP since 2022).

1. Sign into the Gmail account you want the emails to come from (this can be the same as the recipient, or a different sending account).
2. Enable **2-Step Verification** on that account (required).
   https://myaccount.google.com/security
3. Generate an App Password:
   https://myaccount.google.com/apppasswords
   - Pick "Mail" → "Other (Custom name)"
   - Name it `Monitoring Server`
   - Google will give you a 16-character password like `abcd efgh ijkl mnop`
4. Put it in `.env`:

   ```env
   GMAIL_USER=your-sender@gmail.com
   GMAIL_APP_PASSWORD=abcdefghijklmnop          # no spaces
   RECIPIENT_EMAIL=aicodeorigin@gmail.com
   EMAIL_INTERVAL_MINUTES=60
   ```

5. Restart the server. Test it works:

   ```bash
   curl -X POST http://localhost:3001/api/email/test
   ```

   Check `aicodeorigin@gmail.com` for a "test email" message.

## Step 3 — Open the employee login

Visit http://localhost:3001 ... wait, the server only serves the API. The HTML pages can be served any way you like:

**Option A — quick local serve:**
```bash
cd Claude
python3 -m http.server 8080
```
Open http://localhost:8080/login.html

**Option B — GitHub Pages (static frontend) + hosted server:**
- Push the HTML/JS files to a branch that GitHub Pages serves
- Deploy `server/` to Render / Railway / Fly.io / your own VPS
- Update `CORS_ORIGIN` in `.env` to your Pages URL
- On the login page, paste your server URL into the "Monitoring server" field

**Option C — same-origin (recommended for production):**
- Serve the HTML files from the same Express server (add `app.use(express.static(...))`) so URLs match and CORS isn't an issue. Easy enhancement if you want; ask and I'll wire it.

## Step 4 — Walk through the flow

1. **Open `login.html`** — the page tests the server connection at the bottom.
2. Enter your name, work email, ID, department, role, accept the consent checkbox.
3. Click **Start session** → you're redirected to `workspace.html`.
4. The tracker runs automatically. You see live stats: active time, idle time, productivity / focus / discipline scores. They update every 30 seconds (heartbeat interval).
5. **Open `dashboard.html`** in another tab. Paste your server URL into the live-mode bar (or it auto-connects if you logged in from the same browser). You'll see the live employee appear.
6. Wait an hour (or change `EMAIL_INTERVAL_MINUTES=2` in `.env` to test quickly) — an email arrives at `aicodeorigin@gmail.com` with a per-employee digest.
7. When the employee closes the workspace tab, the session ends and a "Session ended" email is sent (controlled by `EMAIL_ON_SESSION_END=true`).

## Step 5 — Verify everything

Quick health check:

```bash
curl http://localhost:3001/api/health
# {"ok":true,"sessions":1,"activeSessions":1,"emailConfigured":true,...}
```

Force a digest right now:

```bash
curl -X POST http://localhost:3001/api/digest/send
```

List all sessions:

```bash
curl http://localhost:3001/api/sessions
```

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | Server status, email config, active session count |
| POST | `/api/sessions/login` | Start a new monitored session (returns sessionId) |
| POST | `/api/sessions/heartbeat` | Submit deltas for the last interval |
| POST | `/api/sessions/logout` | End a session |
| GET  | `/api/sessions` | All sessions with derived stats (used by dashboard) |
| GET  | `/api/sessions/:id` | One session |
| POST | `/api/digest/send` | Force-send the digest now |
| POST | `/api/email/test` | Send a 1-line test email |

## Configuration reference (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Server port |
| `COMPANY_NAME` | `Your Company` | Shown in email subject/header |
| `EXPECTED_LOGIN_HOUR` | `9` | Used to flag late logins |
| `EXPECTED_LOGIN_MINUTE` | `0` | |
| `EMAIL_INTERVAL_MINUTES` | `60` | How often the digest goes out |
| `EMAIL_ON_SESSION_END` | `true` | Email when an employee logs out |
| `RECIPIENT_EMAIL` | `aicodeorigin@gmail.com` | Where digests are sent |
| `GMAIL_USER` | — | Your sending Gmail address |
| `GMAIL_APP_PASSWORD` | — | 16-char Gmail App Password |
| `CORS_ORIGIN` | `*` | Restrict to your frontend origin in production |

## Hardening checklist for production

- [ ] Restrict `CORS_ORIGIN` to your real frontend domain
- [ ] Move from JSON file to a real database (Postgres / SQLite via better-sqlite3)
- [ ] Add an admin auth token for `/api/sessions` and `/api/digest/send`
- [ ] Run behind HTTPS (reverse proxy with nginx / Caddy / a hosted platform)
- [ ] Enforce password / SSO on `login.html` (currently anyone with the URL can start a session)
- [ ] Add `helmet`, rate limiting, and structured logging
- [ ] Add an OS-level desktop agent if you need to track activity outside the browser

## Privacy & ethics

- The login page requires explicit consent before tracking begins.
- Employees see their own scores in real-time on `workspace.html` (transparency).
- Only aggregate counts are stored — never input contents, never screen contents.
- Logs are kept on disk in `server/data/sessions.json`. Decide on a retention policy.
- This is a monitoring tool. Use it responsibly — discuss with your team, document the scope, and make participation a condition of employment, not a surveillance ambush.
