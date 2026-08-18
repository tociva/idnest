import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideConsent,
  isRememberedOfflineAccessAllowed,
  type LoadedConsent,
} from "../handlers/consent-decision";
import { mockFetchByUrl } from "./helpers";

const authzMocks = vi.hoisted(() => ({
  auditConsentEvent: vi.fn(),
  bootstrapFirstSystemAdmin: vi.fn(),
  findConsentApproval: vi.fn(),
  getAuthzPool: vi.fn(),
  hasActiveClientAccess: vi.fn(),
  rememberConsentApproval: vi.fn(),
  canonicalList: (values: string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(),
}));

vi.mock("@idnest/authz-store", () => authzMocks);

const originalEnv = { ...process.env };
const pool = { query: vi.fn() };

const verifiedIdentity = {
  id: "kratos-id-1",
  traits: { name: "Ada", email: "ada@example.com" },
  verifiable_addresses: [{ via: "email", value: "ada@example.com", verified: true }],
};

const approval = {
  id: "approval-1",
  identity_id: "kratos-id-1",
  client_id: "idnest-admin-client",
  scope_hash: "scope-hash",
  audience_hash: "audience-hash",
  trust_tier: "first_party",
  consent_version: 1,
  approved_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
};

function consentRequest(input?: {
  clientId?: string;
  clientName?: string;
  scopes?: string[];
  audiences?: string[];
  registeredAudiences?: string[];
  trustTier?: "first_party" | "partner" | "third_party";
  consentVersion?: number;
  rememberOfflineAccess?: boolean;
}) {
  const clientId = input?.clientId ?? "idnest-admin-client";
  const audiences = input?.audiences ?? (clientId === "example-user-client" ? ["example-users"] : ["idnest-admin"]);
  const clientName =
    input?.clientName ?? (clientId === "example-user-client" ? "Example User Client" : "Idnest Admin Console");
  return {
    challenge: "cc_1",
    subject: "kratos-id-1",
    requested_scope: input?.scopes ?? ["openid", "profile", "email", "offline_access"],
    requested_access_token_audience: audiences,
    skip: false,
    client: {
      client_id: clientId,
      client_name: clientName,
      audience: input?.registeredAudiences ?? audiences,
      metadata: {
        trust_tier: input?.trustTier ?? "first_party",
        consent_version: input?.consentVersion ?? 1,
        remember_offline_access: input?.rememberOfflineAccess ?? true,
      },
    },
  };
}

async function decide(input?: {
  clientId?: string;
  clientName?: string;
  scopes?: string[];
  audiences?: string[];
  registeredAudiences?: string[];
  trustTier?: "first_party" | "partner" | "third_party";
  rememberOfflineAccess?: boolean;
  hasAccess?: boolean;
  hasApproval?: boolean;
}) {
  mockFetchByUrl([
    { match: "/requests/consent?", result: { ok: true, json: consentRequest(input) } },
    { match: "/identities/", result: { ok: true, json: verifiedIdentity } },
  ]);
  authzMocks.getAuthzPool.mockReturnValue(pool);
  authzMocks.hasActiveClientAccess.mockResolvedValue(input?.hasAccess ?? true);
  authzMocks.findConsentApproval.mockResolvedValue(
    input?.hasApproval === false ? null : { ...approval, client_id: input?.clientId ?? "idnest-admin-client" },
  );
  authzMocks.auditConsentEvent.mockResolvedValue(undefined);
  authzMocks.bootstrapFirstSystemAdmin.mockResolvedValue(null);

  return decideConsent("cc_1");
}

beforeEach(() => {
  process.env.HYDRA_ADMIN_URL = "http://hydra-admin";
  process.env.KRATOS_ADMIN_URL = "http://kratos-admin";
  process.env.AUTHZ_DATABASE_URL = "postgres://authz";
  delete process.env.CONSENT_GATE_MODE;
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
});

describe("remembered offline consent", () => {
  it("allows remembered offline_access consent for a flagged first-party client", async () => {
    const decision = await decide({ clientId: "example-user-client" });

    expect(decision.canAutoAccept).toBe(true);
    expect(decision.autoAcceptReason).toBe("remembered_first_party_offline_access_consent");
    expect(decision.reasons).toContain("high_risk_request");
  });

  it("allows remembered admin offline_access consent for a flagged first-party client", async () => {
    const decision = await decide({ clientId: "idnest-admin-client" });

    expect(decision.canAutoAccept).toBe(true);
    expect(decision.autoAcceptReason).toBe("remembered_first_party_offline_access_consent");
    expect(decision.reasons).toContain("high_risk_request");
  });

  it("prompts first-time offline_access consent when no prior approval exists", async () => {
    const decision = await decide({ hasApproval: false });

    expect(decision.canAutoAccept).toBe(false);
    expect(decision.autoAcceptReason).toBeUndefined();
    expect(decision.reasons).toContain("no_prior_approval");
    expect(decision.reasons).toContain("high_risk_request");
  });

  it("keeps unflagged first-party offline_access consent high-risk even with a prior approval", async () => {
    const decision = await decide({ clientId: "product-client", rememberOfflineAccess: false });

    expect(decision.canAutoAccept).toBe(false);
    expect(decision.autoAcceptReason).toBeUndefined();
    expect(decision.reasons).toContain("high_risk_request");
  });

  it("keeps flagged partner or third-party offline_access consent high-risk prompts", async () => {
    const partnerDecision = await decide({ clientId: "partner-client", trustTier: "partner" });
    expect(partnerDecision.canAutoAccept).toBe(false);
    expect(partnerDecision.autoAcceptReason).toBeUndefined();

    const thirdPartyDecision = await decide({ clientId: "third-party-client", trustTier: "third_party" });
    expect(thirdPartyDecision.canAutoAccept).toBe(false);
    expect(thirdPartyDecision.autoAcceptReason).toBeUndefined();
  });

  it("keeps flagged first-party requests with custom scopes or unregistered audiences high-risk prompts", async () => {
    const customScopeDecision = await decide({ scopes: ["openid", "email", "offline_access", "admin.extra"] });
    expect(customScopeDecision.canAutoAccept).toBe(false);
    expect(customScopeDecision.autoAcceptReason).toBeUndefined();

    const unregisteredAudienceDecision = await decide({
      audiences: ["other-api"],
      registeredAudiences: ["idnest-admin"],
    });
    expect(unregisteredAudienceDecision.canAutoAccept).toBe(false);
    expect(unregisteredAudienceDecision.autoAcceptReason).toBeUndefined();
  });

  it("allows flagged first-party requests with multiple registered audiences", async () => {
    const decision = await decide({
      audiences: ["api-a", "api-b"],
      registeredAudiences: ["api-a", "api-b", "api-c"],
    });

    expect(decision.canAutoAccept).toBe(true);
    expect(decision.autoAcceptReason).toBe("remembered_first_party_offline_access_consent");
  });

  it("still auto-accepts normal low-risk remembered consent", async () => {
    const decision = await decide({
      clientId: "product-client",
      scopes: ["openid", "profile", "email"],
      audiences: ["product-api"],
    });

    expect(decision.canAutoAccept).toBe(true);
    expect(decision.autoAcceptReason).toBe("remembered_low_risk_consent");
  });

  it("allows only registered audiences for the remembered offline_access exception", () => {
    const loaded = {
      client: {
        client_id: "example-user-client",
        audience: ["example-users"],
        metadata: { remember_offline_access: true },
      },
      trustTier: "first_party",
      scopes: ["email", "offline_access", "openid", "profile"],
      audiences: ["example-users"],
    } as LoadedConsent;

    expect(isRememberedOfflineAccessAllowed(loaded)).toBe(true);
    expect(isRememberedOfflineAccessAllowed({ ...loaded, audiences: ["other-api"] })).toBe(false);
  });

  it("does not apply observe-mode access bypass to the Idnest admin client", async () => {
    process.env.CONSENT_GATE_MODE = "observe";

    const productDecision = await decide({
      clientId: "example-user-client",
      hasAccess: false,
      hasApproval: false,
    });
    expect(productDecision.observeOnly).toBe(true);
    expect(productDecision.hasAccess).toBe(true);

    const adminDecision = await decide({
      clientId: "idnest-admin-client",
      hasAccess: false,
      hasApproval: false,
    });
    expect(adminDecision.observeOnly).toBe(false);
    expect(adminDecision.hasAccess).toBe(false);
    expect(adminDecision.reasons).toContain("missing_client_access_grant");
  });

  it("bootstraps the first allowlisted administrator before enforcing admin consent", async () => {
    process.env.ADMIN_BOOTSTRAP_EMAILS = "other@example.com, ADA@example.com";
    authzMocks.bootstrapFirstSystemAdmin.mockResolvedValue({
      id: "grant-1",
      identity_id: "kratos-id-1",
      client_id: "idnest-admin-client",
      role: "system-admin",
      created_at: "now",
    });

    const decision = await decide({
      clientId: "idnest-admin-client",
      hasAccess: true,
      hasApproval: false,
    });

    expect(authzMocks.bootstrapFirstSystemAdmin).toHaveBeenCalledWith(pool, {
      identityId: "kratos-id-1",
      clientId: "idnest-admin-client",
      grantedBy: "bootstrap-email",
    });
    expect(decision.hasAccess).toBe(true);
  });
});
