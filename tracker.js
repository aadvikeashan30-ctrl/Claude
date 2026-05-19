// ============================================================================
// AI Employee Monitoring — browser tracker
// Include this script on any internal page to track the logged-in employee.
// Captures: active/idle time, keyboard/mouse counts, tab switches, page focus.
// Sends a heartbeat to the server every 30s.
// Ethically: NO keystroke content, NO screen contents, NO personal data.
// ============================================================================
(function () {
  'use strict';

  const STORAGE_KEY = 'monitoring.session';
  const SERVER_KEY = 'monitoring.serverUrl';
  const HEARTBEAT_MS = 30_000;
  const TICK_MS = 1_000;
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

  function getServerUrl() {
    return window.MONITORING_SERVER_URL
      || localStorage.getItem(SERVER_KEY)
      || 'http://localhost:3001';
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  const session = loadSession();
  if (!session || !session.sessionId) {
    console.warn('[tracker] No active session in localStorage. Visit login.html first.');
    return;
  }

  // Counters that reset on each heartbeat
  let activeMs = 0, idleMs = 0;
  let keyboardEvents = 0, mouseEvents = 0;
  let tabSwitches = 0;

  let lastInputAt = Date.now();
  let lastTickAt = Date.now();
  let isVisible = !document.hidden;

  // Self-reported task counts (employee's own honesty inputs)
  function getClaimedTasks() {
    return Number(localStorage.getItem('monitoring.claimedTasks')) || 0;
  }
  function getCompletedTasks() {
    return Number(localStorage.getItem('monitoring.completedTasks')) || 0;
  }

  // === Listeners ===========================================================
  function onAnyInput() { lastInputAt = Date.now(); }
  document.addEventListener('keydown', () => { keyboardEvents++; onAnyInput(); }, { passive: true });
  document.addEventListener('mousedown', () => { mouseEvents++; onAnyInput(); }, { passive: true });
  document.addEventListener('mousemove', onAnyInput, { passive: true });
  document.addEventListener('scroll', onAnyInput, { passive: true });
  document.addEventListener('touchstart', () => { mouseEvents++; onAnyInput(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    tabSwitches++;
    isVisible = !document.hidden;
  });

  // === Active/idle accounting ==============================================
  setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt = now;
    // pause counters when tab is hidden — that's tab-switching, not work
    if (!isVisible) return;
    if (now - lastInputAt > IDLE_THRESHOLD_MS) idleMs += elapsed;
    else activeMs += elapsed;
  }, TICK_MS);

  // === Heartbeat ===========================================================
  let lastStats = null;

  async function sendHeartbeat() {
    const payload = {
      sessionId: session.sessionId,
      deltaActiveMs: activeMs,
      deltaIdleMs: idleMs,
      deltaKeyboard: keyboardEvents,
      deltaMouse: mouseEvents,
      deltaTabSwitches: tabSwitches,
      currentPage: location.pathname + location.search,
      isVisible,
      lastInputAt: new Date(lastInputAt).toISOString(),
      claimedTasks: getClaimedTasks(),
      completedTasks: getCompletedTasks(),
    };
    // reset deltas immediately so we don't double-count if the request is slow
    activeMs = 0; idleMs = 0;
    keyboardEvents = 0; mouseEvents = 0;
    tabSwitches = 0;

    try {
      const r = await fetch(`${getServerUrl()}/api/sessions/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        if (r.status === 404 || r.status === 409) {
          console.warn('[tracker] session ended on server, clearing local session');
          localStorage.removeItem(STORAGE_KEY);
          if (window.MonitoringTracker?.onSessionEnded) window.MonitoringTracker.onSessionEnded();
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      const data = await r.json();
      lastStats = data.stats;
      window.dispatchEvent(new CustomEvent('monitoring:stats', { detail: data.stats }));
    } catch (err) {
      console.warn('[tracker] heartbeat failed:', err.message);
      window.dispatchEvent(new CustomEvent('monitoring:error', { detail: err.message }));
    }
  }

  setInterval(sendHeartbeat, HEARTBEAT_MS);
  // also send a heartbeat immediately on load so the dashboard sees the session quickly
  setTimeout(sendHeartbeat, 1000);

  // === Logout on close ====================================================
  window.addEventListener('beforeunload', () => {
    try {
      const blob = new Blob([JSON.stringify({ sessionId: session.sessionId })], { type: 'application/json' });
      navigator.sendBeacon(`${getServerUrl()}/api/sessions/logout`, blob);
    } catch { /* best-effort */ }
  });

  // === Public API =========================================================
  window.MonitoringTracker = {
    session,
    getStats: () => lastStats,
    forceHeartbeat: sendHeartbeat,
    setClaimedTasks(n) { localStorage.setItem('monitoring.claimedTasks', String(Math.max(0, Number(n) || 0))); },
    setCompletedTasks(n) { localStorage.setItem('monitoring.completedTasks', String(Math.max(0, Number(n) || 0))); },
    async logout() {
      try {
        await fetch(`${getServerUrl()}/api/sessions/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId }),
        });
      } catch { /* ignore */ }
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem('monitoring.claimedTasks');
      localStorage.removeItem('monitoring.completedTasks');
      window.location.href = 'login.html';
    },
    onSessionEnded: null, // callers can set this
  };

  console.log('[tracker] active for', session.employee?.name || session.employee?.email);
})();
