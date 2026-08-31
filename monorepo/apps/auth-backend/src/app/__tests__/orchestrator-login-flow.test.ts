import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, Router } from "express";
import {
  DEFAULT_AUTH_POLICY,
  DEFAULT_IDNEST_BRAND,
  type KratosFlow,
  type KratosSession,
  type ResolvedAuthConfiguration,
} from "@idnest/shared-types";
import type { AuthTransactionRecord } from "@idnest/authz-store";
import { createOrchestratorRouter } from "../orchestrator";
import {
  KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
} from "../login-flow-binding";
import { encryptSensitiveValue } from "../transaction-crypto";
import { mockFetchByUrl } from "./helpers";

const storeMocks = vi.hoisted(() => ({
  bindAuthTransactionFlow: vi.fn(),
  claimAuthTransactionCompletion: vi.fn(),
  createAuthTransaction: vi.fn(),
  findAuthTransactionByChallengeHash: vi.fn(),
  findAuthTransactionById: vi.fn(),
  findAuthTransactionByKratosFlowId: vi.fn(),
  findAuthTransactionByTokenHash: vi.fn(),
  getAuthzPool: vi.fn(),
  recordAuthAuditEvent: vi.fn(),
  resolveAuthConfiguration: vi.fn(),
  setAuthTransactionResult: vi.fn(),
}));

vi.mock("@idnest/authz-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@idnest/authz-store")>();
  return {
    ...actual,
    bindAuthTransactionFlow: storeMocks.bindAuthTransactionFlow,
    claimAuthTransactionCompletion: storeMocks.claimAuthTransactionCompletion,
    createAuthTransaction: storeMocks.createAuthTransaction,
    findAuthTransactionByChallengeHash: storeMocks.findAuthTransactionByChallengeHash,
    findAuthTransactionById: storeMocks.findAuthTransactionById,
    findAuthTransactionByKratosFlowId: storeMocks.findAuthTransactionByKratosFlowId,
    findAuthTransactionByTokenHash: storeMocks.findAuthTransactionByTokenHash,
    getAuthzPool: storeMocks.getAuthzPool,
    recordAuthAuditEvent: storeMocks.recordAuthAuditEvent,
    resolveAuthConfiguration: storeMocks.resolveAuthConfiguration,
    setAuthTransactionResult: storeMocks.setAuthTransactionResult,
  };
});

const originalEnv = { ...process.env };
const authBase = "https://auth-local.idnest.cloud";
const kratosPublic = "https://kratos-local.idnest.cloud";
const fakeDb = {};

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
    }>;
  };
}

interface RouteJsonResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type FetchResult = {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
};

function findGetHandler(router: Router, path: string) {
  const stack = (router as unknown as { stack: ExpressRouteLayer[] }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.get)?.route;
  if (!route) throw new Error(`Missing GET route ${path}`);
  return route.stack.at(-1)?.handle;
}

function mockFetchSequence(matchers: Array<{ match: string; result: FetchResult }>) {
  const pending = [...matchers];
  const fn = vi.fn(async (...args: [url: string | URL, init?: RequestInit]) => {
    const [url] = args;
    const u = String(url);
    const index = pending.findIndex((m) => u.includes(m.match));
    const hit = index >= 0 ? pending.splice(index, 1)[0] : undefined;
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

async function loginFlowContext(flowId: string): Promise<RouteJsonResult> {
  const router = createOrchestratorRouter();
  const handler = findGetHandler(router, "/auth/v1/flows/login/:flowId/context");
  if (!handler) throw new Error("Missing login flow context handler");
  const result: RouteJsonResult = { status: 200, headers: {}, body: undefined };
  const req = {
    params: { flowId },
    headers: { "user-agent": "vitest" },
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
  const res = {
    set(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;

  await handler(req, res, (err?: unknown) => {
    if (err) throw err;
  });
  return result;
}

async function getRoute(path: string, params: Record<string, string> = {}): Promise<RouteJsonResult> {
  const router = createOrchestratorRouter();
  const url = new URL(path, authBase);
  const handler = findGetHandler(router, url.pathname);
  if (!handler) throw new Error(`Missing handler for ${url.pathname}`);
  const result: RouteJsonResult = { status: 200, headers: {}, body: undefined };
  const req = {
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: { "user-agent": "vitest" },
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
  const res = {
    set(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    type(value: string) {
      result.headers["content-type"] = value;
      return this;
    },
    send(body: unknown) {
      result.body = body;
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

function expectAutoConsentRedirectPage(
  result: RouteJsonResult,
  redirectTo: string,
) {
  expect(result.status).toBe(200);
  expect(result.headers.location).toBeUndefined();
  expect(result.headers["content-type"]).toBe("html");
  const body = String(result.body);
  expect(body).toContain("Completing sign-in");
  expect(body).toContain('role="progressbar"');
  expect(body).toContain("auto-consent-spinner");
  expect(body).toContain('http-equiv="refresh"');
  expect(body).toContain(redirectTo);
  expect(body).not.toContain("same verified email address");
  expect(body).not.toContain("trusted first-party application");
  expect(body).not.toContain("already carries a verified email identity");
}

function expectDirectRedirect(result: RouteJsonResult, redirectTo: string) {
  expect(result.status).toBe(302);
  expect(result.headers.location).toBe(redirectTo);
  expect(result.body).toBeUndefined();
}

function transaction(overrides: Partial<AuthTransactionRecord> = {}): AuthTransactionRecord {
  return {
    id: "transaction-1",
    token_hash: "opaque-token-hash",
    hydra_login_challenge_hash: "hydra-login-challenge-hash",
    hydra_login_challenge_ciphertext: "hydra-login-challenge-ciphertext",
    hydra_client_id: "daybook-web-bff-local",
    brand_id: "00000000-0000-4000-8000-000000000001",
    brand_version: 1,
    authentication_policy_id: "00000000-0000-4000-8000-000000000002",
    authentication_policy_version: 1,
    mapping_version: 1,
    client_config_snapshot: {
      hydraClientId: "daybook-web-bff-local",
      clientDisplayName: "Daybook",
      clientHomeUrl: "https://app-local.daybook.cloud/",
      status: "active",
      isFirstParty: true,
      consentMode: "skip-for-first-party",
      brandId: "00000000-0000-4000-8000-000000000001",
      brandVersion: 1,
      authPolicyId: "00000000-0000-4000-8000-000000000002",
      authPolicyVersion: 1,
      mappingVersion: 1,
    },
    brand_snapshot: { ...DEFAULT_IDNEST_BRAND, productName: "Daybook" },
    policy_snapshot: {
      ...DEFAULT_AUTH_POLICY,
      allowedOidcProviders: ["apple"],
    },
    kratos_flow_id: "flow-successor",
    kratos_flow_issued_at: new Date(Date.now() - 120_000).toISOString(),
    subject: null,
    status: "awaiting-authentication",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    completion_started_at: null,
    completed_at: null,
    failure_code: null,
    redirect_to: null,
    ...overrides,
  };
}

function daybookResolved(
  overrides: Partial<ResolvedAuthConfiguration> = {},
): ResolvedAuthConfiguration {
  const snapshot = transaction().client_config_snapshot;
  return {
    client: snapshot,
    brand: { ...DEFAULT_IDNEST_BRAND, productName: "Daybook" },
    policy: {
      ...DEFAULT_AUTH_POLICY,
      allowedOidcProviders: ["google", "apple"],
    },
    usedFallback: false,
    ...overrides,
  };
}

function googleSession(): KratosSession {
  return {
    id: "kratos-session-google",
    active: true,
    authenticated_at: new Date(Date.now() - 1_000).toISOString(),
    authenticator_assurance_level: "aal1",
    authentication_methods: [
      {
        method: "oidc",
        provider: "google",
        aal: "aal1",
        completed_at: new Date(Date.now() - 1_000).toISOString(),
      },
    ],
    identity: {
      id: "kratos-google-identity-1",
      traits: { email: "PrinceKFrancis@Gmail.com" },
      verifiable_addresses: [
        { via: "email", value: "PrinceKFrancis@Gmail.com", verified: true },
      ],
      state: "active",
    },
  };
}

function adminMfaSession(): KratosSession {
  const completedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    id: "kratos-session-admin",
    active: true,
    authenticated_at: completedAt,
    authenticator_assurance_level: "aal2",
    authentication_methods: [
      {
        method: "oidc",
        provider: "google",
        aal: "aal1",
        completed_at: completedAt,
      },
      {
        method: "totp",
        aal: "aal2",
        completed_at: completedAt,
      },
    ],
    identity: {
      id: "kratos-admin-identity-1",
      traits: { email: "Admin@Example.com", name: "Admin User" },
      verifiable_addresses: [
        { via: "email", value: "Admin@Example.com", verified: true },
      ],
      state: "active",
    },
  };
}

function appleFlow(
  overrides: Partial<KratosFlow> = {},
  messageContext: Record<string, unknown> | null = {
    provider: "apple",
    duplicateIdentifier: "PrinceKFrancis@Gmail.com",
  },
): KratosFlow {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    id: "flow-successor",
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    return_to: `${authBase}/oauth2/login/complete?transaction=opaque-token-1`,
    request_url: `${kratosPublic}/self-service/login/browser?return_to=${encodeURIComponent(
      `${authBase}/oauth2/login/complete?transaction=opaque-token-1`,
    )}`,
    ui: {
      action: `${kratosPublic}/self-service/login?flow=flow-successor`,
      method: "POST",
      messages: [
        {
          id: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
          type: "info",
          text: "Sign in to link your account.",
          context: messageContext ?? undefined,
        },
      ],
      nodes: [
        {
          type: "input",
          group: "default",
          attributes: { name: "csrf_token", type: "hidden", value: "csrf-1" },
        },
        {
          type: "input",
          group: "oidc",
          attributes: { name: "provider", type: "submit", value: "apple" },
          meta: { label: { text: "Continue with Apple" } },
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.AUTH_BASE_URL = authBase;
  process.env.KRATOS_PUBLIC_URL = kratosPublic;
  process.env.KRATOS_INTERNAL_URL = "http://kratos:4433";
  process.env.AUTHZ_DATABASE_URL = "postgres://authz.test";
  process.env.AUTH_TRANSACTION_SECRET = "development-only-auth-transaction-secret";
  storeMocks.getAuthzPool.mockReturnValue(fakeDb);
  storeMocks.recordAuthAuditEvent.mockResolvedValue(undefined);
  storeMocks.resolveAuthConfiguration.mockResolvedValue(daybookResolved());
  storeMocks.setAuthTransactionResult.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("orchestrator login flow context", () => {
  it("accepts structured duplicate-email account-link flows as successful login", async () => {
    const flow = appleFlow();
    const boundTransaction = transaction({
      hydra_login_challenge_ciphertext: encryptSensitiveValue("login-challenge-1"),
      kratos_flow_id: flow.id,
      kratos_flow_issued_at: flow.issued_at,
    });
    storeMocks.bindAuthTransactionFlow.mockResolvedValue(boundTransaction);
    storeMocks.claimAuthTransactionCompletion.mockResolvedValue({
      ...boundTransaction,
      status: "completing",
    });
    const fetchMock = mockFetchByUrl([
      { match: "/self-service/login/flows", result: { ok: true, json: flow } },
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "login-challenge-1",
            client: { client_id: "daybook-web-bff-local" },
            skip: false,
          },
        },
      },
      {
        match: "/oauth2/auth/requests/login/accept",
        result: { ok: true, json: { redirect_to: "https://hydra/continue" } },
      },
    ]);

    const result = await loginFlowContext(flow.id);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ redirectTo: "https://hydra/continue" });
    expect(storeMocks.bindAuthTransactionFlow).toHaveBeenCalledWith(
      fakeDb,
      expect.any(String),
      flow.id,
      {
        reason: "account-link-recovery",
        issuedAt: flow.issued_at,
      },
    );
    expect(storeMocks.claimAuthTransactionCompletion).toHaveBeenCalledWith(
      fakeDb,
      expect.any(String),
    );
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/login/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.subject).toBe("princekfrancis@gmail.com");
    expect(sent.context.id_token).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
    expect(storeMocks.setAuthTransactionResult).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        id: "transaction-1",
        status: "hydra-accepted",
        subject: "princekfrancis@gmail.com",
      }),
    );
    expect(storeMocks.recordAuthAuditEvent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        eventType: "auth.login.completed",
        hydraClientId: "daybook-web-bff-local",
        identityId: "princekfrancis@gmail.com",
        result: "accepted-via-verified-email",
      }),
    );
  });

  it("does not treat a bare account-link message id as a rebindable successor", async () => {
    const flow = appleFlow({}, null);
    storeMocks.bindAuthTransactionFlow.mockResolvedValue(null);
    storeMocks.findAuthTransactionByTokenHash.mockResolvedValue(transaction());
    mockFetchByUrl([{ match: "/self-service/login/flows", result: { ok: true, json: flow } }]);

    const result = await loginFlowContext(flow.id);

    expect(result.status).toBe(410);
    expect(storeMocks.bindAuthTransactionFlow).toHaveBeenCalledWith(
      fakeDb,
      expect.any(String),
      flow.id,
      {
        reason: "initial",
        issuedAt: flow.issued_at,
      },
    );
    expect(storeMocks.recordAuthAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps the Kratos identity id as the admin OAuth login subject", async () => {
    const adminTransaction = transaction({
      id: "admin-transaction-1",
      hydra_client_id: "idnest-admin-client",
      hydra_login_challenge_ciphertext: encryptSensitiveValue("admin-login-challenge"),
      client_config_snapshot: {
        ...transaction().client_config_snapshot,
        hydraClientId: "idnest-admin-client",
        clientDisplayName: "Idnest Admin",
        isFirstParty: true,
        consentMode: "skip-for-first-party",
      },
      policy_snapshot: {
        ...DEFAULT_AUTH_POLICY,
        allowedOidcProviders: ["google"],
        totpEnabled: true,
        minimumAal: "aal2",
      },
    });
    storeMocks.claimAuthTransactionCompletion.mockResolvedValue({
      ...adminTransaction,
      status: "completing",
    });
    const fetchMock = mockFetchByUrl([
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "admin-login-challenge",
            client: { client_id: "idnest-admin-client" },
            skip: false,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: true, json: adminMfaSession() } },
      {
        match: "/oauth2/auth/requests/login/accept",
        result: { ok: true, json: { redirect_to: "https://admin-local.idnest.cloud/callback" } },
      },
    ]);

    const result = await getRoute("/oauth2/login/complete?transaction=admin-token");

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("https://admin-local.idnest.cloud/callback");
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/login/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.subject).toBe("kratos-admin-identity-1");
    expect(sent.context.id_token.email).toBe("admin@example.com");
    expect(storeMocks.setAuthTransactionResult).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        id: "admin-transaction-1",
        status: "hydra-accepted",
        subject: "kratos-admin-identity-1",
      }),
    );
  });

  it("accepts admin consent when Hydra subject is the Kratos identity id", async () => {
    const adminTransaction = transaction({
      id: "admin-transaction-1",
      hydra_client_id: "idnest-admin-client",
      subject: "kratos-admin-identity-1",
      status: "hydra-accepted",
      client_config_snapshot: {
        ...transaction().client_config_snapshot,
        hydraClientId: "idnest-admin-client",
        clientDisplayName: "Idnest Admin",
        isFirstParty: true,
        consentMode: "skip-for-first-party",
      },
      policy_snapshot: {
        ...DEFAULT_AUTH_POLICY,
        allowedOidcProviders: ["google"],
        totpEnabled: true,
        minimumAal: "aal2",
      },
    });
    storeMocks.findAuthTransactionByChallengeHash.mockResolvedValue(adminTransaction);
    const fetchMock = mockFetchByUrl([
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "admin-consent-challenge",
            client: { client_id: "idnest-admin-client" },
            subject: "kratos-admin-identity-1",
            requested_scope: ["openid", "profile", "email"],
            requested_access_token_audience: ["idnest-admin"],
            skip: true,
            login_challenge: "login-challenge-1",
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: true, json: adminMfaSession() } },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://admin-local.idnest.cloud/api/admin/auth/callback" } },
      },
    ]);

    const result = await getRoute("/oauth2/consent?consent_challenge=admin-consent-challenge");

    expectDirectRedirect(result, "https://admin-local.idnest.cloud/api/admin/auth/callback");
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/consent/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.session.id_token.user.email).toBe("admin@example.com");
  });

  it("completes Google first, then Apple duplicate-email login, then consent for the same email", async () => {
    const baseResolved = daybookResolved();
    const resolved = daybookResolved({
      client: {
        ...baseResolved.client,
        isFirstParty: false,
        consentMode: "follow-hydra",
        mappingVersion: 0,
      },
      usedFallback: true,
    });
    const googleTransaction = transaction({
      id: "google-transaction-1",
      token_hash: "google-token-hash",
      hydra_login_challenge_ciphertext: encryptSensitiveValue("google-login-challenge"),
      client_config_snapshot: resolved.client,
      brand_snapshot: resolved.brand,
      policy_snapshot: resolved.policy,
      kratos_flow_id: "google-flow",
    });
    const appleTransaction = transaction({
      id: "apple-transaction-1",
      token_hash: "apple-token-hash",
      hydra_login_challenge_ciphertext: encryptSensitiveValue("apple-login-challenge"),
      client_config_snapshot: resolved.client,
      brand_snapshot: resolved.brand,
      policy_snapshot: resolved.policy,
      kratos_flow_id: "apple-flow-successor",
    });
    const flow = appleFlow({
      id: "apple-flow-successor",
      return_to: `${authBase}/oauth2/login/complete?transaction=apple-token`,
      request_url: `${kratosPublic}/self-service/login/browser?return_to=${encodeURIComponent(
        `${authBase}/oauth2/login/complete?transaction=apple-token`,
      )}`,
    });

    storeMocks.resolveAuthConfiguration.mockResolvedValue(resolved);
    storeMocks.createAuthTransaction
      .mockResolvedValueOnce(googleTransaction)
      .mockResolvedValueOnce(appleTransaction);
    storeMocks.claimAuthTransactionCompletion
      .mockResolvedValueOnce({ ...googleTransaction, status: "completing" })
      .mockResolvedValueOnce({ ...appleTransaction, status: "completing" });
    storeMocks.bindAuthTransactionFlow.mockResolvedValue(appleTransaction);
    storeMocks.findAuthTransactionByChallengeHash.mockResolvedValue(null);
    storeMocks.findAuthTransactionById.mockResolvedValue(null);

    const fetchMock = mockFetchSequence([
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "google-login-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            skip: false,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: false, status: 401, json: {} } },
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "google-login-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            skip: false,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: true, json: googleSession() } },
      {
        match: "/oauth2/auth/requests/login/accept",
        result: {
          ok: true,
          json: {
            redirect_to: `${authBase}/oauth2/consent?consent_challenge=google-consent-challenge`,
          },
        },
      },
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "google-consent-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            subject: "princekfrancis@gmail.com",
            requested_scope: ["openid", "email"],
            requested_access_token_audience: ["daybook"],
            skip: true,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: true, json: googleSession() } },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://daybook/callback/google" } },
      },
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "apple-login-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            skip: false,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: false, status: 401, json: {} } },
      { match: "/self-service/login/flows", result: { ok: true, json: flow } },
      {
        match: "/oauth2/auth/requests/login?",
        result: {
          ok: true,
          json: {
            challenge: "apple-login-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            skip: false,
          },
        },
      },
      {
        match: "/oauth2/auth/requests/login/accept",
        result: {
          ok: true,
          json: {
            redirect_to: `${authBase}/oauth2/consent?consent_challenge=apple-consent-challenge`,
          },
        },
      },
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "apple-consent-challenge",
            client: { client_id: "daybook-web-bff-local", client_name: "Daybook" },
            subject: "PrinceKFrancis@Gmail.com",
            requested_scope: ["openid", "email"],
            requested_access_token_audience: ["daybook"],
            skip: true,
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: false, status: 401, json: {} } },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://daybook/callback/apple" } },
      },
    ]);

    const googleStart = await getRoute("/oauth2/login?login_challenge=google-login-challenge");
    expect(googleStart.status).toBe(302);
    expect(googleStart.headers.location).toContain("/self-service/login/browser?");

    const googleComplete = await getRoute("/oauth2/login/complete?transaction=google-token");
    expect(googleComplete.status).toBe(302);
    expect(googleComplete.headers.location).toBe(
      `${authBase}/oauth2/consent?consent_challenge=google-consent-challenge`,
    );

    const googleConsent = await getRoute("/oauth2/consent?consent_challenge=google-consent-challenge");
    expectDirectRedirect(googleConsent, "https://daybook/callback/google");

    const appleStart = await getRoute("/oauth2/login?login_challenge=apple-login-challenge");
    expect(appleStart.status).toBe(302);
    expect(appleStart.headers.location).toContain("/self-service/login/browser?");

    const appleFlowContext = await loginFlowContext(flow.id);
    expect(appleFlowContext.status).toBe(200);
    expect(appleFlowContext.body).toEqual({
      redirectTo: `${authBase}/oauth2/consent?consent_challenge=apple-consent-challenge`,
    });

    const appleConsent = await getRoute("/oauth2/consent?consent_challenge=apple-consent-challenge");
    expectDirectRedirect(appleConsent, "https://daybook/callback/apple");

    const loginAcceptBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/oauth2/auth/requests/login/accept"))
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(loginAcceptBodies.map((body) => body.subject)).toEqual([
      "princekfrancis@gmail.com",
      "princekfrancis@gmail.com",
    ]);

    const consentAcceptBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/oauth2/auth/requests/consent/accept"))
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(consentAcceptBodies.at(-1)?.session.id_token.user).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
  });

  it("auto-accepts first-party consent after email-subject login completion", async () => {
    storeMocks.findAuthTransactionByChallengeHash.mockResolvedValue(transaction({
      subject: "princekfrancis@gmail.com",
      status: "hydra-accepted",
    }));
    const fetchMock = mockFetchByUrl([
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "consent-challenge-1",
            client: { client_id: "daybook-web-bff-local" },
            subject: "princekfrancis@gmail.com",
            requested_scope: ["openid", "email"],
            requested_access_token_audience: ["daybook"],
            skip: true,
            login_challenge: "login-challenge-1",
          },
        },
      },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://daybook/callback" } },
      },
    ]);

    const result = await getRoute("/oauth2/consent?consent_challenge=consent-challenge-1");

    expectDirectRedirect(result, "https://daybook/callback");
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/consent/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.grant_scope).toEqual(["openid", "email"]);
    expect(sent.grant_access_token_audience).toEqual(["daybook"]);
    expect(sent.session.id_token.user).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
    expect(sent.session.access_token.user).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/sessions/whoami"))).toBe(
      false,
    );
  });

  it("accepts duplicate-email Apple consent without a Kratos session when Hydra skip is false", async () => {
    const clientConfig = {
      ...transaction().client_config_snapshot,
      isFirstParty: false,
      consentMode: "follow-hydra" as const,
    };
    storeMocks.findAuthTransactionByChallengeHash.mockResolvedValue(transaction({
      subject: "princekfrancis@gmail.com",
      status: "hydra-accepted",
      client_config_snapshot: clientConfig,
    }));
    const fetchMock = mockFetchByUrl([
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "consent-challenge-1",
            client: { client_id: "daybook-web-bff-local" },
            subject: "PrinceKFrancis@Gmail.com",
            requested_scope: ["openid", "email"],
            requested_access_token_audience: ["daybook"],
            skip: false,
            login_challenge: "login-challenge-1",
          },
        },
      },
      { match: "/sessions/whoami", result: { ok: false, status: 401, json: {} } },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://daybook/callback" } },
      },
    ]);

    const result = await getRoute("/oauth2/consent?consent_challenge=consent-challenge-1");

    expectAutoConsentRedirectPage(result, "https://daybook/callback");
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/consent/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.session.id_token.user).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/sessions/whoami"))).toBe(
      false,
    );
  });

  it("resumes first-party consent from Hydra login context after email-subject Apple login", async () => {
    storeMocks.findAuthTransactionById.mockResolvedValue(transaction({
      id: "transaction-1",
      subject: "princekfrancis@gmail.com",
      status: "hydra-accepted",
    }));
    const fetchMock = mockFetchByUrl([
      {
        match: "/oauth2/auth/requests/consent?",
        result: {
          ok: true,
          json: {
            challenge: "consent-challenge-1",
            client: { client_id: "daybook-web-bff-local" },
            subject: "PrinceKFrancis@Gmail.com",
            requested_scope: ["openid", "email"],
            requested_access_token_audience: ["daybook"],
            skip: true,
            context: {
              auth_transaction_id: "transaction-1",
            },
          },
        },
      },
      {
        match: "/oauth2/auth/requests/consent/accept",
        result: { ok: true, json: { redirect_to: "https://daybook/callback" } },
      },
    ]);

    const result = await getRoute("/oauth2/consent?consent_challenge=consent-challenge-1");

    expectDirectRedirect(result, "https://daybook/callback");
    expect(storeMocks.findAuthTransactionByChallengeHash).not.toHaveBeenCalled();
    expect(storeMocks.findAuthTransactionById).toHaveBeenCalledWith(fakeDb, "transaction-1");
    const acceptCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/oauth2/auth/requests/consent/accept"),
    );
    expect(acceptCall).toBeDefined();
    const sent = JSON.parse((acceptCall?.[1] as RequestInit).body as string);
    expect(sent.session.id_token.user).toEqual({
      name: undefined,
      email: "princekfrancis@gmail.com",
      email_verified: true,
      picture: undefined,
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/sessions/whoami"))).toBe(
      false,
    );
  });
});
