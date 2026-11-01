/**
 * Client-side failure reporting (utils/clientLog.js).
 *
 * The hooks degrade a failed fetch to an empty layer on purpose. These tests
 * pin the one thing that makes that degradation visible: a failed request is
 * reported exactly once per window, lands in the store for the badge, and an
 * abort — which is routine, not a failure — is never reported.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "./store";
import { loggedFetch, reportClient } from "./utils/clientLog";

function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  });
  return calls;
}

const ok = (body = "{}", status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } });

describe("clientLog", () => {
  beforeEach(() => {
    useStore.setState({ backendError: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reports a 5xx data fetch once, to the backend and to the store", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/client-log") ? ok() : ok('{"detail":"boom"}', 500));
    const res = await loggedFetch("edges/query-grouped", { dataset: "d" },
      "/api/edges/d/query-grouped", { method: "POST" });
    expect(res.status).toBe(500);
    // give the fire-and-forget report a tick
    await new Promise((r) => setTimeout(r, 0));
    const reports = calls.filter((c) => c.url.endsWith("/client-log"));
    expect(reports).toHaveLength(1);
    const body = JSON.parse(reports[0].init.body);
    expect(body.level).toBe("error");
    expect(body.message).toMatch(/edges\/query-grouped failed: HTTP 500/);
    expect(body.context).toMatchObject({ dataset: "d", status: 500 });
    expect(useStore.getState().backendError?.message).toMatch(/HTTP 500/);
  });

  it("does not report an aborted request", async () => {
    const calls = stubFetch(() => {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    });
    await expect(loggedFetch("transcripts", {}, "/api/x")).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter((c) => c.url.endsWith("/client-log"))).toHaveLength(0);
    expect(useStore.getState().backendError).toBeNull();
  });

  it("de-duplicates the same message inside the window and logs 4xx as a warning", async () => {
    const calls = stubFetch((url) => url.endsWith("/client-log") ? ok() : ok("nope", 404));
    const msg = `dup-${Math.random()}`;
    reportClient("warning", msg);
    reportClient("warning", msg);
    reportClient("warning", msg);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url.endsWith("/client-log"))).toHaveLength(1);
    // a 4xx is a warning, not an error: no badge
    await loggedFetch("cell-boundaries", {}, "/api/y");
    expect(useStore.getState().backendError).toBeNull();
  });
});
