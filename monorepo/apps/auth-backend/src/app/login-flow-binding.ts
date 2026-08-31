/**
 * Pure helpers for binding branded login flows to either an OAuth transaction
 * or a privileged settings re-authentication handoff.
 */
import {
  normalizeEmailAddress,
  type KratosFlow,
} from "@idnest/shared-types";

export const KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID = 1010016;

export type AuthFlowBindingReason = "initial" | "account-link-recovery" | "aal2-step-up";

export interface LoginFlowBindingClassification {
  reason: AuthFlowBindingReason;
  issuedAt: string;
  kratosMessageId?: number;
  accountLink?: {
    provider: string;
    duplicateEmail: string;
  };
}

function validIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function flowReturnToCandidates(flow: KratosFlow): string[] {
  const candidates: string[] = [];
  if (flow.return_to) candidates.push(flow.return_to);
  if (flow.request_url) {
    try {
      const nested = new URL(flow.request_url).searchParams.get("return_to");
      if (nested) candidates.push(nested);
    } catch {
      // Ignore malformed request_url; callers treat the flow as unbound.
    }
  }
  return candidates;
}

export function transactionTokenFromFlow(
  flow: KratosFlow,
  authBaseUrl: string,
): string | null {
  const authOrigin = new URL(authBaseUrl).origin;
  for (const candidate of flowReturnToCandidates(flow)) {
    try {
      const url = new URL(candidate);
      if (url.origin !== authOrigin || url.pathname !== "/oauth2/login/complete") continue;
      const token = url.searchParams.get("transaction");
      if (token) return token;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function isAal2StepUpFlow(flow: KratosFlow): boolean {
  try {
    return new URL(flow.request_url ?? "").searchParams.get("aal") === "aal2";
  } catch {
    return false;
  }
}

export function kratosFlowIssuedAt(flow: KratosFlow): string | null {
  return validIsoTimestamp(flow.issued_at);
}

function accountLinkContext(context: unknown): LoginFlowBindingClassification["accountLink"] | null {
  if (!context || typeof context !== "object") return null;
  const record = context as Record<string, unknown>;
  const provider = record.provider;
  const duplicateIdentifier = record.duplicateIdentifier ?? record.duplicate_identifier;
  if (typeof provider !== "string" || provider.trim().length === 0) return null;
  const duplicateEmail = normalizeEmailAddress(duplicateIdentifier);
  if (!duplicateEmail) return null;
  return { provider: provider.trim().toLowerCase(), duplicateEmail };
}

function accountLinkLoginContext(flow: KratosFlow): LoginFlowBindingClassification["accountLink"] | null {
  for (const message of flow.ui.messages ?? []) {
    if (
      message.id === KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID &&
      message.type === "info"
    ) {
      const context = accountLinkContext(message.context);
      if (context) return context;
    }
  }
  return null;
}

export function classifyLoginFlowBinding(
  flow: KratosFlow,
  authBaseUrl: string,
  options: { now?: number } = {},
): LoginFlowBindingClassification | null {
  const issuedAt = kratosFlowIssuedAt(flow);
  if (!issuedAt) return null;

  if (isAal2StepUpFlow(flow)) {
    return { reason: "aal2-step-up", issuedAt };
  }

  const expiresAt = validIsoTimestamp(flow.expires_at);
  const now = options.now ?? Date.now();
  const accountLink = accountLinkLoginContext(flow);
  if (
    expiresAt &&
    Date.parse(expiresAt) > now &&
    accountLink &&
    transactionTokenFromFlow(flow, authBaseUrl)
  ) {
    return {
      reason: "account-link-recovery",
      issuedAt,
      kratosMessageId: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
      accountLink,
    };
  }

  return { reason: "initial", issuedAt };
}

/**
 * Kratos interrupts privileged settings (e.g. TOTP enroll) with a refresh login
 * whose return_to points back at settings — not an OAuth completion URL.
 */
export function isSettingsPrivilegedReauthFlow(
  flow: KratosFlow,
  options: { authBaseUrl: string; kratosPublicUrl: string },
): boolean {
  const authOrigin = new URL(options.authBaseUrl).origin;
  const kratosOrigin = new URL(options.kratosPublicUrl).origin;
  for (const candidate of flowReturnToCandidates(flow)) {
    try {
      const url = new URL(candidate);
      if (
        url.origin === authOrigin &&
        (url.pathname === "/settings" || url.pathname === "/settings/return")
      ) {
        return true;
      }
      if (
        url.origin === kratosOrigin &&
        (url.pathname === "/self-service/settings" ||
          url.pathname.startsWith("/self-service/settings/"))
      ) {
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

export function settingsResumeUrlFromFlow(
  flow: KratosFlow,
  options: { authBaseUrl: string; kratosPublicUrl: string },
): string {
  const authOrigin = new URL(options.authBaseUrl).origin;
  const kratosOrigin = new URL(options.kratosPublicUrl).origin;
  for (const candidate of flowReturnToCandidates(flow)) {
    try {
      const url = new URL(candidate);
      if (
        url.origin === authOrigin &&
        (url.pathname === "/settings" || url.pathname === "/settings/return")
      ) {
        return candidate;
      }
      if (
        url.origin === kratosOrigin &&
        (url.pathname === "/self-service/settings" ||
          url.pathname.startsWith("/self-service/settings/"))
      ) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return new URL("/settings", `${options.authBaseUrl}/`).toString();
}
