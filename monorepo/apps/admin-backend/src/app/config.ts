import { randomUUID } from "node:crypto";

/**
 * Server-side configuration for the admin API.
 *
 * Like auth-backend, the Hydra/Kratos *admin* URLs are privileged and must
 * never reach the browser. admin-backend owns the confidential admin OAuth
 * client, creates BFF sessions, and validates Kratos identities server-side.
 */

export const getHydraAdminUrl = (): string => process.env.HYDRA_ADMIN_URL ?? "";
export const getKratosAdminUrl = (): string => process.env.KRATOS_ADMIN_URL ?? "";
export const getAdminOidcClientId = (): string =>
  process.env.ADMIN_OIDC_CLIENT_ID ?? "idnest-admin-client";
export const getAdminOidcAudience = (): string =>
  process.env.ADMIN_OIDC_AUDIENCE ?? "idnest-admin";
export const getAdminOidcClientSecret = (): string =>
  process.env.ADMIN_OIDC_CLIENT_SECRET ?? "";
export const getAdminOidcAuthority = (): string =>
  process.env.ADMIN_OIDC_AUTHORITY ?? process.env.ADMIN_AUTH_AUTHORITY ?? "https://hydra-local.idnest.cloud/";
export const getAdminOidcTokenUrl = (): string => {
  if (process.env.ADMIN_OIDC_TOKEN_URL) return process.env.ADMIN_OIDC_TOKEN_URL;
  const authority = getAdminOidcAuthority().replace(/\/?$/, "/");
  const url = new URL("oauth2/token", authority);
  if (url.hostname === "hydra-local.idnest.cloud") {
    return "http://localhost:4444/oauth2/token";
  }
  return url.toString();
};
export const getAdminOidcScope = (): string =>
  process.env.ADMIN_OIDC_SCOPE ?? "openid profile email";
export const getAdminPublicOrigin = (): string =>
  (process.env.ADMIN_PUBLIC_ORIGIN ?? "https://admin-local.idnest.cloud").replace(/\/+$/, "");
export const getAdminBootstrapEmails = (): string[] =>
  (process.env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
export const getAdminRedirectUri = (): string =>
  process.env.ADMIN_OIDC_REDIRECT_URI ??
  `${getAdminPublicOrigin()}/api/admin/auth/callback`;

/** Public Kratos URL retained for admin session-management calls that need browser-facing URLs. */
export const getKratosPublicUrl = (): string => process.env.KRATOS_PUBLIC_URL ?? "";

/**
 * Kratos public API base for backend-to-Kratos public API calls.
 * Defaults to the public URL, but set KRATOS_INTERNAL_URL to the internal
 * http:// address (e.g. http://localhost:4433) so the call uses direct local
 * HTTP and avoids browser-facing certificate trust requirements in Node.
 */
export const getKratosInternalUrl = (): string =>
  process.env.KRATOS_INTERNAL_URL ?? getKratosPublicUrl();

export const getPort = (): number => Number(process.env.ADMIN_BACKEND_PORT ?? 4100);

export const getAuthzDatabaseUrl = (): string => process.env.AUTHZ_DATABASE_URL ?? "";

/** Comma-separated allowlist of browser origins permitted to call the admin API. */
export const getAdminCorsOrigins = (): string[] =>
  (process.env.ADMIN_CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

/** HTTPS origins from which activated authentication brands may load images. */
export const getAuthAssetAllowedOrigins = (): string[] =>
  (process.env.AUTH_ASSET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

/** HTTPS origins permitted for support, privacy, and terms destinations. */
export const getAuthLinkAllowedOrigins = (): string[] =>
  (process.env.AUTH_LINK_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const fallbackCsrfSecret = randomUUID();

/** Secret used to sign stateless admin CSRF tokens. */
export const getAdminCsrfSecret = (): string =>
  process.env.ADMIN_CSRF_SECRET ?? process.env.KRATOS_CSRF_COOKIE_SECRET ?? fallbackCsrfSecret;

export const getAdminSessionTtlSeconds = (): number =>
  positiveInt(process.env.ADMIN_SESSION_TTL_SECONDS, 8 * 60 * 60);

export const getAdminSessionIdleTtlSeconds = (): number =>
  positiveInt(process.env.ADMIN_SESSION_IDLE_TTL_SECONDS, 30 * 60);

export const getAdminOAuthTransactionTtlSeconds = (): number =>
  positiveInt(process.env.ADMIN_OAUTH_TRANSACTION_TTL_SECONDS, 10 * 60);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
