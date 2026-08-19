import { getAuthBaseUrl, getKratosPublicUrl } from "./config";

const OIDC_AUTHORIZE_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://appleid.apple.com",
]);

export interface KratosFormActionOptions {
  kratosPublicUrl?: string;
  authBaseUrl?: string;
}

function kratosPublic(options: KratosFormActionOptions): string {
  return options.kratosPublicUrl ?? getKratosPublicUrl();
}

function authBase(options: KratosFormActionOptions): string {
  return options.authBaseUrl ?? getAuthBaseUrl();
}

/**
 * Trust-check a Kratos flow `ui.action` (public origin + `/self-service/` path).
 */
export function trustedKratosActionUrl(action: string, kratosPublicUrl: string): URL {
  const kratosOrigin = new URL(kratosPublicUrl).origin;
  const url = new URL(action);
  if (url.origin !== kratosOrigin || !url.pathname.startsWith("/self-service/")) {
    throw new Error("Kratos returned an untrusted flow action");
  }
  return url;
}

/**
 * Rewrite a trusted Kratos form action onto this app's origin so the browser
 * POSTs same-origin. Path and query are preserved.
 */
export function browserKratosFormAction(
  action: string,
  options: KratosFormActionOptions = {},
): string {
  const url = trustedKratosActionUrl(action, kratosPublic(options));
  const auth = new URL(authBase(options));
  url.protocol = auth.protocol;
  url.host = auth.host;
  return url.toString();
}

/**
 * Resolve a Kratos POST redirect Location for the 200 continue page.
 * Relative URLs are resolved against the Kratos public origin.
 */
export function parseAllowedKratosContinueUrl(
  location: string,
  options: KratosFormActionOptions = {},
): URL | null {
  const kratosPublicUrl = kratosPublic(options);
  let url: URL;
  try {
    url = new URL(location, kratosPublicUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;

  const kratosOrigin = new URL(kratosPublicUrl).origin;
  const authOrigin = new URL(authBase(options)).origin;
  if (url.origin === authOrigin) return url;
  if (url.origin === kratosOrigin && url.pathname.startsWith("/self-service/")) return url;
  if (OIDC_AUTHORIZE_ORIGINS.has(url.origin)) return url;
  return null;
}
