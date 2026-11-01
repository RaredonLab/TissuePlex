/**
 * Report browser-side failures to the backend's log file.
 *
 * Every data hook swallows a failed fetch on purpose: an empty layer is the right
 * degradation, where a thrown error would take the whole viewer down. The cost
 * was that nothing, anywhere, recorded the failure — a backend that had been
 * OOM-killed and restarted, or an nginx 504 on a slow query, looked exactly like
 * "the software stopped doing anything". These reports land in the same rotating
 * file as the backend's own slow-request and error lines (POST /client-log, see
 * backend/app/logging_setup.py), so one file tells both halves of the story.
 *
 * Fire-and-forget, throttled, and de-duplicated per message within a short
 * window, so a layer that fails on every pan does not itself flood the log.
 * Reports also go to the console and to the store, which surfaces the most recent
 * one as a badge in the viewer (RenderingStatus).
 */
import { useStore } from "../store";

const WINDOW_MS = 10_000;     // same message at most once per window
const MAX_PER_MINUTE = 30;
const recent = new Map();     // message -> last sent
let sentThisMinute = 0;
let minuteStart = Date.now();

function apiBase() {
  try { return useStore.getState().apiBase; } catch { return "/api"; }
}

/**
 * @param level   "error" | "warning" | "info"
 * @param message short human-readable line, e.g. "transcripts fetch failed: HTTP 504"
 * @param context small JSON-safe object: dataset, endpoint, status, duration…
 */
export function reportClient(level, message, context = null) {
  const now = Date.now();
  if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0; }
  const last = recent.get(message);
  if (last && now - last < WINDOW_MS) return;
  if (sentThisMinute >= MAX_PER_MINUTE) return;
  recent.set(message, now);
  sentThisMinute += 1;

  const line = context ? `${message} ${JSON.stringify(context)}` : message;
  (level === "error" ? console.error : console.warn)(`[tissueplex] ${line}`);
  if (level === "error") {
    try { useStore.getState().setBackendError?.({ message, context, at: now }); } catch { /* store not ready */ }
  }
  try {
    fetch(`${apiBase()}/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, message, context }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never let logging throw */ }
}

/**
 * Describe a failed `fetch` response for the log: "HTTP 504" plus whatever the
 * backend said, when it said anything short.
 */
export async function describeResponse(res) {
  let detail = "";
  try {
    const text = await res.text();
    if (text && text.length < 300) detail = ` ${text.replace(/\s+/g, " ").trim()}`;
  } catch { /* body unreadable */ }
  return `HTTP ${res.status}${detail}`;
}

/**
 * Wrap a data fetch so that a non-ok response or a network failure is logged
 * with timing, then re-thrown for the caller's existing handling. Aborts are
 * not failures and are passed through silently.
 *
 *   const res = await loggedFetch("edges/query-grouped", { dataset }, url, init);
 */
export async function loggedFetch(what, context, url, init) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e?.name !== "AbortError") {
      reportClient("error", `${what} fetch failed: ${e?.message ?? e}`,
        { ...context, ms: Math.round(performance.now() - started) });
    }
    throw e;
  }
  if (!res.ok) {
    reportClient(res.status >= 500 || res.status === 0 ? "error" : "warning",
      `${what} failed: ${await describeResponse(res.clone())}`,
      { ...context, status: res.status, ms: Math.round(performance.now() - started) });
  }
  return res;
}

/** Install window-level handlers once (main.jsx). */
export function installGlobalErrorReporting() {
  if (typeof window === "undefined" || window.__tpErrorReportingInstalled) return;
  window.__tpErrorReportingInstalled = true;
  window.addEventListener("error", (ev) => {
    reportClient("error", `uncaught: ${ev.message}`,
      { source: ev.filename, line: ev.lineno, col: ev.colno });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    if (r?.name === "AbortError") return;
    reportClient("error", `unhandled rejection: ${r?.message ?? String(r)}`);
  });
}
