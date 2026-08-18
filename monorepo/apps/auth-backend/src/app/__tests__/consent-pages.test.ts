import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, Router } from "express";
import type { LoadedConsent } from "../handlers/consent-decision";

const consentDecisionMocks = vi.hoisted(() => ({
  acceptLoadedConsent: vi.fn(),
  auditDecision: vi.fn(),
  decideConsent: vi.fn(),
  rememberConsent: vi.fn(),
}));

vi.mock("../handlers/consent-decision", () => consentDecisionMocks);

import { createPagesRouter } from "../pages";

interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void> }>;
  };
}

const loaded = {
  challenge: "cc_1",
  subject: "kratos-id-1",
  clientId: "idnest-admin-client",
} as LoadedConsent;

function findGetHandler(router: Router, path: string) {
  const stack = (router as unknown as { stack: ExpressRouteLayer[] }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.get)?.route;
  if (!route) throw new Error(`Missing GET route ${path}`);
  return route.stack[0].handle;
}

async function requestPath(path: string): Promise<RouteResult> {
  const router = createPagesRouter();
  const url = new URL(path, "https://auth-local.idnest.cloud");
  const handler = findGetHandler(router, url.pathname);
  const result: RouteResult = { status: 200, headers: {}, body: "" };

  const req = {
    query: Object.fromEntries(url.searchParams.entries()),
    headers: {},
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
  } as unknown as Response;

  await handler(req, res, (err?: unknown) => {
    if (err) throw err;
  });

  return result;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTH_RETURN_TO_ALLOWED_ORIGINS;
  delete process.env.ADMIN_PUBLIC_ORIGIN;
});

describe("consent page route", () => {
  it("audits the specific auto-accept reason returned by the decision policy", async () => {
    consentDecisionMocks.decideConsent.mockResolvedValue({
      loaded,
      hasAccess: true,
      canAutoAccept: true,
      autoAcceptReason: "remembered_first_party_offline_access_consent",
      reasons: [],
      observeOnly: false,
    });
    consentDecisionMocks.auditDecision.mockResolvedValue(undefined);
    consentDecisionMocks.acceptLoadedConsent.mockResolvedValue({
      status: 200,
      body: { redirect_to: "https://admin-local.idnest.cloud/auth/callback" },
    });

    const res = await requestPath("/consent?consent_challenge=cc_1");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://admin-local.idnest.cloud/auth/callback");
    expect(consentDecisionMocks.auditDecision).toHaveBeenCalledWith(
      loaded,
      "auto_accept",
      "remembered_first_party_offline_access_consent",
    );
  });

  it("renders a switch-account logout link on access denied for allowed client roots", async () => {
    process.env.ADMIN_PUBLIC_ORIGIN = "https://admin-local.idnest.cloud";
    consentDecisionMocks.decideConsent.mockResolvedValue({
      loaded: {
        ...loaded,
        identity: { traits: { email: "other@example.com" } },
        client: {
          client_id: "idnest-admin-client",
          client_name: "Idnest Admin Console",
          client_uri: "https://admin-local.idnest.cloud",
          metadata: {
            allowed_return_uris: ["https://admin-local.idnest.cloud/"],
          },
        },
      } as LoadedConsent,
      hasAccess: false,
      canAutoAccept: false,
      reasons: ["missing_client_access_grant"],
      observeOnly: false,
    });

    const res = await requestPath("/consent?consent_challenge=cc_1");

    expect(res.status).toBe(403);
    expect(res.body).toContain("Use a different account");
    expect(res.body).toContain("Try again");
    expect(res.body).toContain(
      "/logout?return_to=https%3A%2F%2Fadmin-local.idnest.cloud%2F&amp;client_id=idnest-admin-client",
    );
    expect(res.body).toContain('href="https://admin-local.idnest.cloud/"');
  });
});
