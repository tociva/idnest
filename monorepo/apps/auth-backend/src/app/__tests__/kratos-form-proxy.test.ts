import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, Router } from "express";
import { createPagesRouter } from "../pages";
import { mockFetchByUrl } from "./helpers";

const originalEnv = { ...process.env };

interface RouteResult {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void> }>;
  };
}

function findPostHandler(router: Router, path: string) {
  const stack = (router as unknown as { stack: ExpressRouteLayer[] }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.post)?.route;
  if (!route) throw new Error(`Missing POST route ${path}`);
  return route.stack[0].handle;
}

async function postPath(
  path: string,
  options: { body?: Record<string, string>; cookie?: string } = {},
): Promise<RouteResult> {
  const router = createPagesRouter();
  const url = new URL(path, "https://auth-local.idnest.cloud");
  const handler = findPostHandler(router, url.pathname);
  const result: RouteResult = { status: 200, headers: {}, cookies: [], body: "" };

  const req = {
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    query: Object.fromEntries(url.searchParams.entries()),
    body: options.body ?? {},
    headers: { cookie: options.cookie ?? "" },
  } as Request;

  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    type(value: string) {
      result.headers["content-type"] = value;
      return this;
    },
    send(value: unknown) {
      result.body = String(value);
      return this;
    },
    redirect(target: string) {
      result.status = 302;
      result.headers.location = target;
      return this;
    },
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
      return this;
    },
    append(name: string, value: string) {
      if (name.toLowerCase() === "set-cookie") result.cookies.push(value);
      result.headers[name.toLowerCase()] = value;
      return this;
    },
  } as unknown as Response;

  await handler(req, res, (err?: unknown) => {
    if (err) throw err;
  });

  return result;
}

beforeEach(() => {
  process.env.AUTH_BASE_URL = "https://auth-local.idnest.cloud";
  process.env.KRATOS_PUBLIC_URL = "https://kratos-local.idnest.cloud";
  process.env.KRATOS_INTERNAL_URL = "http://localhost:4433";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("Kratos form POST bounce", () => {
  it("returns 200 continue HTML for a Google OIDC redirect and never 302s", async () => {
    const google =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fkratos-local.idnest.cloud%2Fcallback";
    const fetchMock = mockFetchByUrl([
      {
        match: "/self-service/login",
        result: {
          ok: false,
          status: 303,
          headers: { location: google },
          setCookie: ["csrf_token=next; Path=/; HttpOnly"],
        },
      },
    ]);

    const res = await postPath("/self-service/login?flow=flow-1", {
      body: { csrf_token: "csrf", provider: "google" },
      cookie: "ory_kratos_session=sess",
    });

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(res.body).toContain("client_id=abc");
    expect(res.body).toContain('http-equiv="refresh"');
    expect(res.body).not.toContain("<script>");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.cookies).toEqual(["csrf_token=next; Path=/; HttpOnly"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("http://localhost:4433/self-service/login?flow=flow-1");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({
      cookie: "ory_kratos_session=sess",
      accept: "text/html",
    });
    expect(init.body).toBe("csrf_token=csrf&provider=google");
  });

  it("rejects a disallowed Kratos Location with 502", async () => {
    mockFetchByUrl([
      {
        match: "/self-service/login",
        result: {
          ok: false,
          status: 303,
          headers: { location: "https://evil.example/phish" },
        },
      },
    ]);

    const res = await postPath("/self-service/login?flow=flow-1", {
      body: { csrf_token: "csrf", provider: "google" },
    });

    expect(res.status).toBe(502);
    expect(res.body).toContain("login_continue_error");
    expect(res.headers.location).toBeUndefined();
  });
});
