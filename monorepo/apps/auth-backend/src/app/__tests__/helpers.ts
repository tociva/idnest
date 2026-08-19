import { vi } from "vitest";

type FetchResult = {
  ok: boolean;
  status?: number;
  /** JSON body returned by res.json() */
  json?: unknown;
  /** Text body returned by res.text() */
  text?: string;
};

/**
 * Route global fetch calls by URL substring. Each matcher returns a fake
 * Response. Falls back to a 500 if no matcher matches, surfacing test gaps.
 */
export function mockFetchByUrl(matchers: Array<{ match: string; result: FetchResult }>) {
  const fn = vi.fn(async (...args: [url: string | URL, init?: RequestInit]) => {
    const [url] = args;
    const u = String(url);
    const hit = matchers.find((m) => u.includes(m.match));
    const r: FetchResult = hit?.result ?? { ok: false, status: 500, json: { error: "unmatched" } };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ""),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
