/**
 * Server-side configuration. The Hydra/Kratos *admin* URLs are privileged and
 * must never be shipped to or echoed back to the browser - they are read from
 * the environment here and used only inside backend handlers.
 */
import { createPrivateKey } from "node:crypto";

export const getHydraAdminUrl = (): string => process.env.HYDRA_ADMIN_URL ?? "";

/**
 * Hydra *public* origin the browser is redirected to after login/consent.
 * Must be the issuer URL (port 443), not HYDRA_ADMIN_URL (admin port).
 */
export const getHydraPublicUrl = (): string =>
  process.env.HYDRA_URLS_SELF_ISSUER ?? "";

export const getKratosAdminUrl = (): string => process.env.KRATOS_ADMIN_URL ?? "";

/**
 * Kratos *public* base URL. Used server-side to start the browser login flow,
 * read the flow's CSRF token, and run whoami / logout on the user's behalf
 * (the browser's `ory_kratos_session` cookie is forwarded — see kratos-public).
 */
export const getKratosPublicUrl = (): string =>
  process.env.KRATOS_PUBLIC_URL ?? "http://localhost:4433";

/**
 * Kratos *public* API base used for this backend's own server-to-server calls
 * (load flow, whoami, logout, error lookup). Defaults to the browser-facing
 * URL, but should be set to the internal http:// address (e.g.
 * http://localhost:4433) so backend calls use direct local HTTP and do not
 * depend on the browser-facing certificate being trusted by Node.
 *
 * This must NOT be used for anything the browser navigates to — those still
 * use getKratosPublicUrl(), since the browser can only reach the public host.
 */
export const getKratosInternalUrl = (): string =>
  process.env.KRATOS_INTERNAL_URL ?? getKratosPublicUrl();

/**
 * This service's own public origin (e.g. https://auth.idnest.cloud). Used to
 * build the `return_to` URL Kratos sends the browser back to after login.
 */
export const getAuthBaseUrl = (): string =>
  (process.env.AUTH_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const getPort = (): number => Number(process.env.AUTH_BACKEND_PORT ?? 4000);

/** Transitional platform-level origins for standalone return destinations. */
export const getReturnToOrigins = (): string[] =>
  [process.env.AUTH_RETURN_TO_ALLOWED_ORIGINS, process.env.ADMIN_PUBLIC_ORIGIN]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const getAuthzDatabaseUrl = (): string => process.env.AUTHZ_DATABASE_URL ?? "";

export const isDelegationEnabled = (): boolean =>
  process.env.DELEGATION_ENABLED === "true";

export const getDelegationIssuer = (): string =>
  (process.env.DELEGATION_TOKEN_ISSUER ?? `${getAuthBaseUrl()}/delegation`).replace(/\/$/, "");

export const getDelegationBrokerAudience = (): string =>
  process.env.DELEGATION_BROKER_AUDIENCE ?? "urn:idnest:delegation";

export const getDelegationGrantTtlSeconds = (): number =>
  positiveInt(process.env.DELEGATION_GRANT_TTL_SECONDS, 60);

export const getDelegationSigningKeyId = (): string =>
  process.env.DELEGATION_SIGNING_KEY_ID ?? "delegation-es256-1";

export const getDelegationSigningPrivateKey = (): string => {
  const encoded = process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64 ?? "";
  if (!encoded) return "";
  return Buffer.from(encoded, "base64").toString("utf8");
};

export type AuthBrandingMode = "off" | "observe" | "enforce";

export const getAuthBrandingMode = (): AuthBrandingMode => {
  const mode = process.env.AUTH_BRANDING_MODE;
  return mode === "off" || mode === "observe" ? mode : "enforce";
};

export const getAuthTransactionTtlSeconds = (): number =>
  positiveInt(process.env.AUTH_TRANSACTION_TTL_SECONDS, 10 * 60);

export const getAuthTransactionEncryptionSecret = (): string =>
  requiredProductionSecret(
    process.env.AUTH_TRANSACTION_SECRET ??
      process.env.AUTH_TRANSACTION_ENCRYPTION_SECRET ??
      process.env.CONSENT_ACTION_SECRET ??
      process.env.KRATOS_CSRF_COOKIE_SECRET ??
      "development-only-auth-transaction-secret",
    "AUTH_TRANSACTION_SECRET",
  );

export const getAuthAuditHashSecret = (): string =>
  process.env.AUTH_AUDIT_HASH_SECRET ?? getAuthTransactionEncryptionSecret();

export const getStrictUnmappedClients = (): boolean =>
  process.env.AUTH_STRICT_UNMAPPED_CLIENTS === "true" ||
  process.env.AUTH_UNMAPPED_CLIENT_MODE === "reject";

export const getAuthUiBasePath = (): string =>
  (process.env.AUTH_UI_BASE_PATH ?? "/auth").replace(/\/+$/, "");

export type ConsentGateMode = "observe" | "enforce";

export const getConsentGateMode = (): ConsentGateMode =>
  process.env.CONSENT_GATE_MODE === "observe" ? "observe" : "enforce";

export const getConsentActionSecret = (): string =>
  requiredProductionSecret(
    process.env.CONSENT_ACTION_SECRET ??
      process.env.KRATOS_CSRF_COOKIE_SECRET ??
      "dev-consent-action-secret",
    "CONSENT_ACTION_SECRET",
  );

export const getAdminOidcClientId = (): string =>
  process.env.ADMIN_OIDC_CLIENT_ID ?? "idnest-admin-client";

export const getAdminBootstrapEmails = (): string[] =>
  (process.env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

export function validateAuthRuntimeConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  getAuthTransactionEncryptionSecret();
  getConsentActionSecret();
  if (getAuthBrandingMode() !== "off" && !getAuthzDatabaseUrl()) {
    throw new Error("AUTHZ_DATABASE_URL is required when trusted authentication is enabled");
  }
  if (!getHydraAdminUrl()) throw new Error("HYDRA_ADMIN_URL is required");
  if (!getKratosAdminUrl()) throw new Error("KRATOS_ADMIN_URL is required");
  if (isDelegationEnabled()) {
    if (!getAuthzDatabaseUrl()) {
      throw new Error("AUTHZ_DATABASE_URL is required when delegated authorization is enabled");
    }
    if (!getDelegationIssuer().startsWith("https://")) {
      throw new Error("DELEGATION_TOKEN_ISSUER must use HTTPS in production");
    }
    if (!getDelegationSigningPrivateKey().includes("BEGIN PRIVATE KEY")) {
      throw new Error("DELEGATION_SIGNING_PRIVATE_KEY_B64 must contain a PKCS#8 private key");
    }
    try {
      const key = createPrivateKey(getDelegationSigningPrivateKey());
      if (
        key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      ) {
        throw new Error("wrong key type");
      }
    } catch {
      throw new Error("DELEGATION_SIGNING_PRIVATE_KEY_B64 must contain a P-256 private key");
    }
    if (!getDelegationBrokerAudience().trim()) {
      throw new Error("DELEGATION_BROKER_AUDIENCE must not be empty");
    }
    if (!getDelegationSigningKeyId().trim() || getDelegationSigningKeyId().length > 128) {
      throw new Error("DELEGATION_SIGNING_KEY_ID must contain 1 to 128 characters");
    }
    if (getDelegationGrantTtlSeconds() > 300) {
      throw new Error("DELEGATION_GRANT_TTL_SECONDS must not exceed 300");
    }
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredProductionSecret(value: string, name: string): string {
  if (process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters`);
  }
  return value;
}
