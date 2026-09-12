export type AuthBrandStatus = "draft" | "active" | "disabled" | "archived";
export type AuthClientConfigStatus = "active" | "disabled" | "archived";
export type ConsentMode = "always-show" | "skip-for-first-party" | "follow-hydra";
export type RegistrationMode = "enabled" | "disabled" | "invitation-only";
export type IdentityGate =
  | "public"
  | "invitation"
  | "existing-identity"
  | "email-allowlist"
  | "domain-allowlist"
  | "org-membership"
  | "custom";
export type AuthenticatorAssuranceLevel = "aal1" | "aal2";

export interface AuthBrandDefinition {
  key: string;
  displayName: string;
  legalName: string;
  productName: string;
  logoLightUrl?: string;
  logoDarkUrl?: string;
  logoCompactUrl?: string;
  faviconUrl?: string;
  backgroundImageUrl?: string;
  illustrationUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  surfaceColor: string;
  textColor: string;
  mutedTextColor: string;
  errorColor: string;
  borderRadius: string;
  fontFamily: "system" | "roboto";
  loginHeading: string;
  loginDescription: string;
  registrationHeading: string;
  recoveryHeading: string;
  consentHeading: string;
  supportUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  copyrightText?: string;
  defaultLocale: string;
}

export interface AuthPolicyDefinition {
  name: string;
  passwordEnabled: boolean;
  passkeyEnabled: boolean;
  allowedOidcProviders: string[];
  totpEnabled: boolean;
  minimumAal: AuthenticatorAssuranceLevel;
  registrationMode: RegistrationMode;
  identityGate: IdentityGate;
  allowedEmailDomains: string[];
  allowedEmails: string[];
  requireVerifiedEmail: boolean;
  forceReauthentication: boolean;
  sessionMaximumAgeSeconds: number;
}

export interface OAuthClientAuthConfigSnapshot {
  hydraClientId: string;
  clientDisplayName?: string;
  clientHomeUrl?: string;
  status: AuthClientConfigStatus;
  isFirstParty: boolean;
  consentMode: ConsentMode;
  brandId: string;
  brandVersion: number;
  authPolicyId: string;
  authPolicyVersion: number;
  mappingVersion: number;
}

export interface ResolvedAuthConfiguration {
  client: OAuthClientAuthConfigSnapshot;
  brand: AuthBrandDefinition;
  policy: AuthPolicyDefinition;
  usedFallback: boolean;
}

export interface PublicAuthPolicy {
  passwordEnabled: boolean;
  passkeyEnabled: boolean;
  allowedOidcProviders: string[];
  totpEnabled: boolean;
  minimumAal: AuthenticatorAssuranceLevel;
  registrationMode: RegistrationMode;
}

export type PublicAuthRecovery =
  | {
      kind: "application_home";
      clientDisplayName: string;
      homeUrl: string;
    }
  | {
      kind: "client_url_not_configured";
      clientDisplayName: string;
    }
  | {
      kind: "request_context_unavailable";
    };

export interface PublicAuthContext {
  transactionId: string;
  client: {
    id: string;
    displayName: string;
  };
  recovery: PublicAuthRecovery;
  brand: AuthBrandDefinition;
  policy: PublicAuthPolicy;
  expiresAt: string;
  /** oauth (default) or privileged settings re-authentication. */
  purpose?: "oauth" | "settings_reauth";
  /** Present when AAL2 is required but no interactive second-factor UI is available. */
  secondaryFactorEnrollmentUrl?: string;
  /** Where to send the browser if settings re-auth is cancelled. */
  settingsResumeUrl?: string;
  /** Optional logout handoff for choosing a different account or provider. */
  switchAccountUrl?: string;
}

export const DEFAULT_IDNEST_BRAND: AuthBrandDefinition = {
  key: "idnest-default",
  displayName: "Idnest",
  legalName: "Tociva Technologies",
  productName: "Idnest",
  primaryColor: "#2563eb",
  secondaryColor: "#1d4ed8",
  surfaceColor: "#ffffff",
  textColor: "#1f2937",
  mutedTextColor: "#6b7280",
  errorColor: "#b91c1c",
  borderRadius: "16px",
  fontFamily: "system",
  loginHeading: "Sign in to continue",
  loginDescription: "Use your Idnest identity to continue.",
  registrationHeading: "Create your account",
  recoveryHeading: "Recover your account",
  consentHeading: "Review access",
  supportUrl: "https://idnest.cloud/support",
  privacyUrl: "https://auth.idnest.cloud/privacy",
  termsUrl: "https://auth.idnest.cloud/terms",
  copyrightText: "Tociva Technologies",
  defaultLocale: "en",
};

export const DEFAULT_AUTH_POLICY_NAME = "Public Social";

export const DEFAULT_AUTH_POLICY: AuthPolicyDefinition = {
  name: DEFAULT_AUTH_POLICY_NAME,
  passwordEnabled: false,
  passkeyEnabled: false,
  allowedOidcProviders: ["google", "apple"],
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

/** Gates that require an explicit client_access_grants row before access is allowed. */
export function identityGateRequiresClientGrant(gate: IdentityGate): boolean {
  return gate !== "public" && gate !== "email-allowlist" && gate !== "domain-allowlist";
}

export function toPublicPolicy(policy: AuthPolicyDefinition): PublicAuthPolicy {
  return {
    passwordEnabled: policy.passwordEnabled,
    passkeyEnabled: policy.passkeyEnabled,
    allowedOidcProviders: [...policy.allowedOidcProviders],
    totpEnabled: policy.totpEnabled,
    minimumAal: policy.minimumAal,
    registrationMode: policy.registrationMode,
  };
}

export function normalizeClientHomeUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function publicAuthRecoveryForClient(
  client: Pick<OAuthClientAuthConfigSnapshot, "clientDisplayName" | "clientHomeUrl" | "hydraClientId">,
  fallbackDisplayName: string,
): PublicAuthRecovery {
  const clientDisplayName =
    client.clientDisplayName?.trim() || fallbackDisplayName.trim() || client.hydraClientId;
  const homeUrl = normalizeClientHomeUrl(client.clientHomeUrl);
  return homeUrl
    ? { kind: "application_home", clientDisplayName, homeUrl }
    : { kind: "client_url_not_configured", clientDisplayName };
}
