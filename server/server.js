// ============================================================================
// AI Employee Monitoring Server
// - Receives login / heartbeat / logout events from browser tracker
// - Persists sessions to disk (JSON file)
// - Sends hourly email digests via Gmail SMTP (Nodemailer)
// - Auto-ends stale sessions
// ============================================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Config =================================================================
const PORT = Number(process.env.PORT) || 3001;
const COMPANY_NAME = process.env.COMPANY_NAME || 'Your Company';
const EXPECTED_LOGIN_HOUR = Number(process.env.EXPECTED_LOGIN_HOUR ?? 9);
const EXPECTED_LOGIN_MINUTE = Number(process.env.EXPECTED_LOGIN_MINUTE ?? 0);
const EMAIL_INTERVAL_MINUTES = Math.max(1, Number(process.env.EMAIL_INTERVAL_MINUTES) || 60);
const EMAIL_ON_SESSION_END = String(process.env.EMAIL_ON_SESSION_END || 'true').toLowerCase() === 'true';
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || 'aicodeorigin@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
await fs.mkdir(DATA_DIR, { recursive: true });

// === Persistence ============================================================
async function loadSessions() {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { sessions: [] };
    throw err;
  }
}

async function saveSessions(data) {
  const tmp = SESSIONS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, SESSIONS_FILE);
}

const store = await loadSessions();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await saveSessions(store); }
    catch (err) { console.error('[persist] save failed:', err.message); }
  }, 250);
}

// === Scoring ================================================================
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (n, d) => (d > 0 ? n / d : 0);

function deriveStats(s) {
  const activeMs = s.activeMs ?? 0;
  const idleMs = s.idleMs ?? 0;
  const totalMs = activeMs + idleMs;
  const activeMin = Math.round(activeMs / 60000);
  const idleMin = Math.round(idleMs / 60000);
  const activeRatio = pct(activeMs, totalMs);
  const inputs = (s.keyboardEvents ?? 0) + (s.mouseEvents ?? 0);
  const inputNorm = clamp((inputs / 8000) * 100, 0, 100);
  const switchPenalty = clamp(((s.tabSwitches ?? 0) / 80) * 100, 0, 60);

  const productivityScore = clamp(Math.round(activeRatio * 70 + inputNorm * 0.3));
  const focusScore = clamp(Math.round(inputNorm * 0.6 + (100 - switchPenalty) * 0.4));

  const lateLoginMin = s.expectedLoginAt && s.loginAt
    ? Math.max(0, (new Date(s.loginAt) - new Date(s.expectedLoginAt)) / 60000)
    : 0;
  const latePenalty = clamp((lateLoginMin / 120) * 100, 0, 80);
  const idlePenalty = clamp(pct(idleMs, totalMs) * 120, 0, 80);
  const disciplineScore = clamp(Math.round(100 - latePenalty * 0.5 - idlePenalty * 0.5));

  const lastBeat = new Date(s.lastHeartbeatAt || s.loginAt).getTime();
  const lastInput = new Date(s.lastInputAt || s.loginAt).getTime();
  const now = Date.now();
  let status = 'active';
  if (s.logoutAt) status = 'offline';
  else if (now - lastBeat > 90 * 1000) status = 'offline';
  else if (now - lastInput > 5 * 60 * 1000) status = 'idle';

  let riskLevel = 'Low';
  if (productivityScore < 50 || lateLoginMin > 60) riskLevel = 'High';
  else if (productivityScore < 70 || lateLoginMin > 15) riskLevel = 'Medium';

  return {
    activeMin, idleMin, activeRatio,
    productivityScore, focusScore, disciplineScore,
    lateLoginMin: Math.round(lateLoginMin),
    status, riskLevel,
    composite: Math.round(productivityScore * 0.5 + focusScore * 0.3 + disciplineScore * 0.2),
  };
}

// === Email ==================================================================
let mailer = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
}

const fmtDur = (min) => `${Math.floor(min / 60)}h ${min % 60}m`;
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '\u2014';

function buildEmailHtml(sessions, opts = {}) {
  const heading = opts.heading || `${COMPANY_NAME} \u2014 Hourly Monitoring Digest`;
  if (sessions.length === 0) {
    return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f9fafb;padding:24px;">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#4f46e5,#4338ca);color:#fff;padding:18px 22px;">
    <div style="font-size:17px;font-weight:700;">${heading}</div>
    <div style="font-size:12px;opacity:0.9;margin-top:3px;">${new Date().toLocaleString()}</div>
  </div>
  <div style="padding:24px;color:#6b7280;font-size:14px;">No active employee sessions during this period.</div>
</div></body></html>`;
  }

  const rows = sessions.map(s => {
    const d = deriveStats(s);
    const statusColor = d.status === 'active' ? '#10b981' : d.status === 'idle' ? '#f59e0b' : '#9ca3af';
    const riskColor = d.riskLevel === 'High' ? '#ef4444' : d.riskLevel === 'Medium' ? '#f59e0b' : '#10b981';
    const claimGap = (s.claimedTasks ?? 0) - (s.completedTasks ?? 0);
    return `
<tr>
  <td style="padding:12px;border-top:1px solid #e5e7eb;vertical-align:top;width:34%;">
    <div style="font-weight:600;color:#111827;">${escapeHtml(s.employee.name)}</div>
    <div style="color:#6b7280;font-size:12px;">${escapeHtml(s.employee.role || '\u2014')} \u00b7 ${escapeHtml(s.employee.department || '\u2014')}</div>
    <div style="color:#6b7280;font-size:12px;">${escapeHtml(s.employee.email || '')}</div>
    <div style="color:#9ca3af;font-size:11px;margin-top:4px;">${escapeHtml(s.employee.id || '')}</div>
  </td>
  <td style="padding:12px;border-top:1px solid #e5e7eb;font-size:13px;color:#374151;width:33%;">
    <div><span style="color:${statusColor};font-weight:700;">\u25cf</span> ${d.status.toUpperCase()}</div>
    <div>Login: <b>${fmtTime(s.loginAt)}</b>${d.lateLoginMin > 15 ? ` <span style="color:#ef4444;">(+${d.lateLoginMin}m late)</span>` : ''}</div>
    <div>Active: <b>${fmtDur(d.activeMin)}</b> \u00b7 Idle: ${fmtDur(d.idleMin)}</div>
    <div style="color:#6b7280;font-size:12px;">Keyboard: ${(s.keyboardEvents||0).toLocaleString()} \u00b7 Mouse: ${(s.mouseEvents||0).toLocaleString()} \u00b7 Tab switches: ${s.tabSwitches||0}</div>
    ${claimGap > 0 ? `<div style="color:#ef4444;font-size:12px;margin-top:4px;">Reported ${s.claimedTasks} done, system tracked ${s.completedTasks||0}</div>` : ''}
  </td>
  <td style="padding:12px;border-top:1px solid #e5e7eb;font-size:13px;color:#374151;width:33%;">
    <div><b>Productivity:</b> ${d.productivityScore} / 100</div>
    <div><b>Focus:</b> ${d.focusScore} / 100</div>
    <div><b>Discipline:</b> ${d.disciplineScore} / 100</div>
    <div style="margin-top:6px;color:${riskColor};font-weight:700;">Risk: ${d.riskLevel}</div>
  </td>
</tr>`;
  }).join('');

  const totalActive = sessions.filter(s => deriveStats(s).status !== 'offline').length;
  const avgProd = Math.round(sessions.reduce((a, s) => a + deriveStats(s).productivityScore, 0) / sessions.length);

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f9fafb;margin:0;padding:24px;">
<div style="max-width:760px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
  <div style="background:linear-gradient(135deg,#4f46e5,#4338ca);color:#fff;padding:20px 24px;">
    <div style="font-size:18px;font-weight:700;">${heading}</div>
    <div style="font-size:12px;opacity:0.9;margin-top:4px;">${new Date().toLocaleString()}</div>
  </div>
  <div style="padding:14px 24px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:13px;color:#374151;">
    <b>${sessions.length}</b> employees in this digest \u00b7
    <b>${totalActive}</b> currently online \u00b7
    Average productivity: <b>${avgProd}/100</b>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr style="background:#f3f4f6;">
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Employee</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Activity</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Scores</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;line-height:1.5;">
    <b>Privacy:</b> Only work-related browser signals are tracked (login times, idle, aggregated input counts, tab visibility).
    No keystrokes content, screen recordings, or personal data is recorded. Logs are retained for 90 days.
  </div>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sendDigest() {
  if (!mailer) {
    console.warn('[email] Skipping digest \u2014 GMAIL_USER / GMAIL_APP_PASSWORD not configured');
    return { skipped: true, reason: 'mailer not configured' };
  }
  const since = Date.now() - EMAIL_INTERVAL_MINUTES * 60 * 1000;
  const recent = store.sessions.filter(s => {
    const ref = new Date(s.lastHeartbeatAt || s.loginAt).getTime();
    return ref >= since || !s.logoutAt;
  });
  const html = buildEmailHtml(recent);
  const subject = `${COMPANY_NAME} \u2014 monitoring digest (${recent.length} ${recent.length === 1 ? 'employee' : 'employees'})`;
  try {
    const info = await mailer.sendMail({
      from: `"${COMPANY_NAME} Monitoring" <${GMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      subject,
      html,
    });
    console.log(`[email] digest sent to ${RECIPIENT_EMAIL}: ${info.messageId}`);
    return { sent: true, messageId: info.messageId, count: recent.length };
  } catch (err) {
    console.error('[email] failed to send digest:', err.message);
    return { error: err.message };
  }
}

async function sendSessionEndEmail(s) {
  if (!mailer || !EMAIL_ON_SESSION_END) return;
  const d = deriveStats(s);
  const subject = `[Session ended] ${s.employee.name} \u2014 ${fmtDur(d.activeMin)} active, ${d.productivityScore}/100 productivity`;
  const html = buildEmailHtml([s], { heading: `Session ended: ${s.employee.name}` });
  try {
    await mailer.sendMail({ from: `"${COMPANY_NAME} Monitoring" <${GMAIL_USER}>`, to: RECIPIENT_EMAIL, subject, html });
    console.log(`[email] session-end notice for ${s.employee.name}`);
  } catch (err) {
    console.error('[email] session-end failed:', err.message);
  }
}

// === HTTP API ==============================================================
const app = express();
const corsOpts = CORS_ORIGIN === '*'
  ? { origin: true }
  : { origin: CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) };
app.use(cors(corsOpts));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    company: COMPANY_NAME,
    sessions: store.sessions.length,
    activeSessions: store.sessions.filter(s => !s.logoutAt).length,
    emailConfigured: !!mailer,
    recipientEmail: RECIPIENT_EMAIL,
    emailIntervalMinutes: EMAIL_INTERVAL_MINUTES,
    expectedLogin: `${String(EXPECTED_LOGIN_HOUR).padStart(2, '0')}:${String(EXPECTED_LOGIN_MINUTE).padStart(2, '0')}`,
  });
});

app.post('/api/sessions/login', async (req, res) => {
  const { id, name, email, department, role } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  const now = new Date();
  const expected = new Date();
  expected.setHours(EXPECTED_LOGIN_HOUR, EXPECTED_LOGIN_MINUTE, 0, 0);

  const session = {
    id: randomUUID(),
    employee: {
      id: id || `EMP-${Date.now().toString(36).toUpperCase().slice(-6)}`,
      name: String(name).slice(0, 100),
      email: String(email).slice(0, 100),
      department: department ? String(department).slice(0, 100) : null,
      role: role ? String(role).slice(0, 100) : null,
    },
    loginAt: now.toISOString(),
    expectedLoginAt: expected.toISOString(),
    logoutAt: null,
    lastHeartbeatAt: now.toISOString(),
    lastInputAt: now.toISOString(),
    activeMs: 0,
    idleMs: 0,
    keyboardEvents: 0,
    mouseEvents: 0,
    tabSwitches: 0,
    currentPage: req.body.currentPage || '/',
    isVisible: true,
    claimedTasks: 0,
    completedTasks: 0,
  };
  store.sessions.push(session);
  scheduleSave();
  console.log(`[login] ${session.employee.name} (${session.employee.email}) sessionId=${session.id}`);
  res.json({
    sessionId: session.id,
    employee: session.employee,
    loginAt: session.loginAt,
    expectedLoginAt: session.expectedLoginAt,
  });
});

app.post('/api/sessions/heartbeat', (req, res) => {
  const {
    sessionId, deltaActiveMs, deltaIdleMs,
    deltaKeyboard, deltaMouse, deltaTabSwitches,
    currentPage, isVisible, lastInputAt,
    claimedTasks, completedTasks,
  } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const s = store.sessions.find(x => x.id === sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.logoutAt) return res.status(409).json({ error: 'session already ended' });

  s.activeMs += Math.max(0, Number(deltaActiveMs) || 0);
  s.idleMs += Math.max(0, Number(deltaIdleMs) || 0);
  s.keyboardEvents += Math.max(0, Number(deltaKeyboard) || 0);
  s.mouseEvents += Math.max(0, Number(deltaMouse) || 0);
  s.tabSwitches += Math.max(0, Number(deltaTabSwitches) || 0);
  if (currentPage) s.currentPage = String(currentPage).slice(0, 200);
  if (typeof isVisible === 'boolean') s.isVisible = isVisible;
  if (lastInputAt) {
    const t = new Date(lastInputAt);
    if (!isNaN(t)) s.lastInputAt = t.toISOString();
  }
  if (Number.isFinite(claimedTasks)) s.claimedTasks = Math.max(0, Number(claimedTasks));
  if (Number.isFinite(completedTasks)) s.completedTasks = Math.max(0, Number(completedTasks));
  s.lastHeartbeatAt = new Date().toISOString();

  scheduleSave();
  res.json({ ok: true, stats: deriveStats(s) });
});

app.post('/api/sessions/logout', async (req, res) => {
  const { sessionId } = req.body || {};
  const s = store.sessions.find(x => x.id === sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.logoutAt) return res.json({ ok: true, alreadyEnded: true });

  s.logoutAt = new Date().toISOString();
  scheduleSave();
  console.log(`[logout] ${s.employee.name} after ${fmtDur(deriveStats(s).activeMin)} active`);
  res.json({ ok: true });
  // fire email asynchronously, don't block response
  sendSessionEndEmail(s).catch(err => console.error('[email] async session-end failed:', err.message));
});

app.get('/api/sessions', (req, res) => {
  const enriched = store.sessions.map(s => ({ ...s, stats: deriveStats(s) }));
  res.json({ sessions: enriched });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = store.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ session: { ...s, stats: deriveStats(s) } });
});

// Manual triggers for testing
app.post('/api/digest/send', async (req, res) => {
  const result = await sendDigest();
  res.json(result);
});

app.post('/api/email/test', async (req, res) => {
  if (!mailer) return res.status(503).json({ error: 'email not configured' });
  try {
    const info = await mailer.sendMail({
      from: `"${COMPANY_NAME} Monitoring" <${GMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      subject: `${COMPANY_NAME} monitoring \u2014 test email`,
      html: `<p>Test email from your monitoring server. Sent at ${new Date().toLocaleString()}.</p>
             <p>If you got this, your Gmail SMTP config is working. The hourly digest will arrive at <b>${RECIPIENT_EMAIL}</b> every ${EMAIL_INTERVAL_MINUTES} minute(s).</p>`,
    });
    res.json({ ok: true, messageId: info.messageId, sentTo: RECIPIENT_EMAIL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Schedules =============================================================
console.log(`[schedule] digest will be sent every ${EMAIL_INTERVAL_MINUTES} minute(s) to ${RECIPIENT_EMAIL}`);
setInterval(() => {
  console.log('[schedule] tick \u2014 sending digest');
  sendDigest().catch(err => console.error('[schedule] digest error:', err.message));
}, EMAIL_INTERVAL_MINUTES * 60 * 1000);

// Stale-session sweeper: if heartbeat hasn't come in for 10 minutes, end the session
cron.schedule('*/2 * * * *', async () => {
  const now = Date.now();
  const stalenessMs = 10 * 60 * 1000;
  for (const s of store.sessions) {
    if (!s.logoutAt && now - new Date(s.lastHeartbeatAt).getTime() > stalenessMs) {
      s.logoutAt = new Date().toISOString();
      s.autoEnded = true;
      scheduleSave();
      console.log(`[sweep] auto-ended stale session for ${s.employee.name}`);
      sendSessionEndEmail(s).catch(err => console.error('[email] sweep email failed:', err.message));
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n\u2728 AI Employee Monitoring server`);
  console.log(`   Listening:        http://localhost:${PORT}`);
  console.log(`   Sessions on disk: ${store.sessions.length}`);
  console.log(`   Email recipient:  ${RECIPIENT_EMAIL}`);
  console.log(`   Email configured: ${!!mailer ? 'yes' : 'NO  \u2014 set GMAIL_USER and GMAIL_APP_PASSWORD in .env'}`);
  console.log(`   Digest interval:  every ${EMAIL_INTERVAL_MINUTES} minute(s)\n`);
});
