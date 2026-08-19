import { vi } from "vitest";

type FetchResult = {
  ok: boolean;
  status?: number;
  /** JSON body returned by res.json() */
  json?: unknown;
  /** Text body returned by res.text() */
  text?: string;
  headers?: Record<string, string>;
  setCookie?: string[];
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
    const status = r.status ?? (r.ok ? 200 : 500);
    const headerLookup = new Map(
      Object.entries(r.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return {
      ok: r.ok,
      status,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ""),
      headers: {
        get(name: string) {
          return headerLookup.get(name.toLowerCase()) ?? null;
        },
        getSetCookie: () => r.setCookie ?? [],
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
