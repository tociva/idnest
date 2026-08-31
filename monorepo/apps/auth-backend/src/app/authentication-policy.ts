import {
  hasVerifiedEmailAddress,
  normalizeEmailAddress,
  oauthSubjectForKratosUser,
  type AuthPolicyDefinition,
  type KratosSession,
} from "@idnest/shared-types";

export interface AuthenticationPolicyDecision {
  allowed: boolean;
  code?: string;
  description?: string;
  acr?: string;
  amr?: string[];
}

function emailOf(session: KratosSession): string {
  const email = session.identity.traits?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function subjectMatches(session: KratosSession, expectedSubject: string): boolean {
  const expected = normalizeEmailAddress(expectedSubject) ?? expectedSubject;
  return (
    oauthSubjectForKratosUser(session.identity) === expected ||
    session.identity.id === expectedSubject
  );
}

function methodAllowed(
  method: NonNullable<KratosSession["authentication_methods"]>[number],
  policy: AuthPolicyDefinition,
): boolean {
  if (method.aal === "aal2") {
    return policy.totpEnabled || method.method === "webauthn" || method.method === "passkey";
  }
  if (method.method === "password") return policy.passwordEnabled;
  if (method.method === "passkey" || method.method === "webauthn") return policy.passkeyEnabled;
  if (method.method === "oidc") {
    return typeof method.provider === "string" && policy.allowedOidcProviders.includes(method.provider);
  }
  return false;
}

export function evaluateAuthenticationPolicy(
  session: KratosSession,
  policy: AuthPolicyDefinition,
  options: {
    expectedSubject?: string;
    maximumAgeSeconds?: number;
    now?: number;
  } = {},
): AuthenticationPolicyDecision {
  if (!session.active || !session.identity?.id) {
    return { allowed: false, code: "session_inactive", description: "No active identity session was found." };
  }
  if (options.expectedSubject && !subjectMatches(session, options.expectedSubject)) {
    return {
      allowed: false,
      code: "subject_mismatch",
      description: "The active identity does not match the authorization request.",
    };
  }
  const identityState = session.identity["state"];
  if (identityState !== undefined && identityState !== "active") {
    return { allowed: false, code: "identity_disabled", description: "This identity is disabled." };
  }

  const email = emailOf(session);
  if (policy.requireVerifiedEmail && !hasVerifiedEmailAddress(session.identity)) {
    return { allowed: false, code: "email_not_verified", description: "A verified email address is required." };
  }
  if (policy.allowedEmails.length > 0 && !policy.allowedEmails.map((v) => v.toLowerCase()).includes(email)) {
    return { allowed: false, code: "email_not_allowed", description: "This account is not allowed." };
  }
  if (policy.allowedEmailDomains.length > 0) {
    const domain = email.split("@")[1] ?? "";
    const allowed = policy.allowedEmailDomains.map((v) => v.trim().toLowerCase()).includes(domain);
    if (!allowed) {
      return { allowed: false, code: "email_domain_not_allowed", description: "This email domain is not allowed." };
    }
  }

  const aal = session.authenticator_assurance_level ?? "aal1";
  if (policy.minimumAal === "aal2" && aal !== "aal2" && aal !== "aal3") {
    return {
      allowed: false,
      code: "aal2_required",
      description: "Additional authentication is required.",
    };
  }

  const maximumAgeSeconds = Math.min(
    policy.sessionMaximumAgeSeconds,
    options.maximumAgeSeconds ?? policy.sessionMaximumAgeSeconds,
  );
  const authenticatedAt = session.authenticated_at ? Date.parse(session.authenticated_at) : Number.NaN;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(authenticatedAt) || now - authenticatedAt > maximumAgeSeconds * 1000) {
    return {
      allowed: false,
      code: "reauthentication_required",
      description: "Please authenticate again.",
    };
  }

  const methods = session.authentication_methods ?? [];
  const primaryMethods = methods.filter((method) => method.aal !== "aal2");
  if (primaryMethods.length === 0 || !primaryMethods.some((method) => methodAllowed(method, policy))) {
    return {
      allowed: false,
      code: "authentication_method_not_allowed",
      description: "The authentication method is not allowed for this application.",
    };
  }
  if (methods.some((method) => !methodAllowed(method, policy))) {
    const onlySecondaryMismatch = methods
      .filter((method) => !methodAllowed(method, policy))
      .every((method) => method.aal === "aal2" && policy.minimumAal === "aal1");
    if (!onlySecondaryMismatch) {
      return {
        allowed: false,
        code: "authentication_method_not_allowed",
        description: "The authentication method is not allowed for this application.",
      };
    }
  }

  return {
    allowed: true,
    acr: aal,
    amr: [...new Set(methods.map((method) => method.provider ? `${method.method}:${method.provider}` : method.method))],
  };
}

export function shouldRequireFreshLogin(
  policy: AuthPolicyDefinition,
  request: { prompt?: string[]; maxAge?: number },
): boolean {
  return policy.forceReauthentication || request.prompt?.includes("login") === true || request.maxAge === 0;
}

/**
 * Choose the Kratos `aal` query param for a browser login start. Explicitly
 * request AAL1 unless this AAL2 policy already has an active session to step up.
 */
export function requestedKratosAal(
  session: KratosSession | null | undefined,
  policy: AuthPolicyDefinition,
): "aal1" | "aal2" {
  if (policy.minimumAal === "aal2" && session?.active) return "aal2";
  return "aal1";
}
