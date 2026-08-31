import type { AuthPolicyDefinition, KratosSession } from "@idnest/shared-types";
import { describe, expect, it } from "vitest";
import {
  evaluateAuthenticationPolicy,
  requestedKratosAal,
  shouldRequireFreshLogin,
} from "../authentication-policy";

const policy: AuthPolicyDefinition = {
  name: "Public Access",
  passwordEnabled: false,
  passkeyEnabled: false,
  allowedOidcProviders: ["google"],
  totpEnabled: false,
  minimumAal: "aal1",
  registrationMode: "enabled",
  identityGate: "public",
  allowedEmailDomains: [],
  allowedEmails: [],
  requireVerifiedEmail: true,
  forceReauthentication: false,
  sessionMaximumAgeSeconds: 3600,
};

function session(overrides: Partial<KratosSession> = {}): KratosSession {
  return {
    id: "session-1",
    active: true,
    authenticated_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    authenticator_assurance_level: "aal1",
    authentication_methods: [
      {
        method: "oidc",
        provider: "google",
        aal: "aal1",
        completed_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    identity: {
      id: "identity-1",
      traits: { email: "ada@example.com" },
      verifiable_addresses: [
        { via: "email", value: "ada@example.com", verified: true },
      ],
      state: "active",
    },
    ...overrides,
  };
}

describe("evaluateAuthenticationPolicy", () => {
  it("accepts an active, verified, fresh Google session", () => {
    const decision = evaluateAuthenticationPolicy(session(), policy, {
      expectedSubject: "ada@example.com",
      now: Date.parse("2026-01-01T00:10:00.000Z"),
    });
    expect(decision).toEqual({
      allowed: true,
      acr: "aal1",
      amr: ["oidc:google"],
    });
  });

  it("rejects an unverified address and a stale session", () => {
    const unverified = session({
      identity: {
        id: "identity-1",
        traits: { email: "ada@example.com" },
        verifiable_addresses: [
          { via: "email", value: "ada@example.com", verified: false },
        ],
      },
    });
    expect(evaluateAuthenticationPolicy(unverified, policy).code).toBe("email_not_verified");
    expect(
      evaluateAuthenticationPolicy(session(), policy, {
        now: Date.parse("2026-01-01T02:00:00.000Z"),
      }).code,
    ).toBe("reauthentication_required");
  });

  it("enforces subject, provider, domain, and AAL policy", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    expect(
      evaluateAuthenticationPolicy(session(), policy, { expectedSubject: "identity-2", now }).code,
    ).toBe("subject_mismatch");
    expect(
      evaluateAuthenticationPolicy(
        session(),
        { ...policy, allowedOidcProviders: ["apple"] },
        { now },
      ).code,
    ).toBe("authentication_method_not_allowed");
    expect(
      evaluateAuthenticationPolicy(
        session(),
        { ...policy, allowedEmailDomains: ["company.test"] },
        { now },
      ).code,
    ).toBe("email_domain_not_allowed");
    expect(
      evaluateAuthenticationPolicy(session(), { ...policy, minimumAal: "aal2" }, { now }).code,
    ).toBe("aal2_required");
  });
});

describe("shouldRequireFreshLogin", () => {
  it("honors policy, prompt, and max_age=0", () => {
    expect(shouldRequireFreshLogin(policy, {})).toBe(false);
    expect(shouldRequireFreshLogin({ ...policy, forceReauthentication: true }, {})).toBe(true);
    expect(shouldRequireFreshLogin(policy, { prompt: ["login"] })).toBe(true);
    expect(shouldRequireFreshLogin(policy, { maxAge: 0 })).toBe(true);
  });
});

describe("requestedKratosAal", () => {
  const aal2Policy = { ...policy, minimumAal: "aal2" as const, totpEnabled: true };

  it("requests AAL1 for AAL1 policies", () => {
    expect(requestedKratosAal(null, policy)).toBe("aal1");
    expect(requestedKratosAal(session(), policy)).toBe("aal1");
  });

  it("starts AAL2 policies at AAL1 when no session exists yet", () => {
    expect(requestedKratosAal(null, aal2Policy)).toBe("aal1");
    expect(requestedKratosAal(undefined, aal2Policy)).toBe("aal1");
    expect(
      requestedKratosAal(session({ active: false }), aal2Policy),
    ).toBe("aal1");
  });

  it("requests aal2 only when an active session is already present", () => {
    expect(requestedKratosAal(session(), aal2Policy)).toBe("aal2");
    expect(
      requestedKratosAal(
        session({ authenticator_assurance_level: "aal2" }),
        aal2Policy,
      ),
    ).toBe("aal2");
  });
});
