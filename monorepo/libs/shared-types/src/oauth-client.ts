export type OAuthClientType = "spa" | "web" | "service" | "native" | "custom";
export type KnownOAuthClientType = Exclude<OAuthClientType, "custom">;

export interface OAuthClientProfile {
  type: KnownOAuthClientType;
  label: string;
  description: string;
  grantTypes: readonly string[];
  responseTypes: readonly string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
  requiresRedirectUris: boolean;
  supportsPostLogoutRedirectUris: boolean;
  defaultScope: string;
}

export interface CorsOriginOptions {
  allowHttpLoopback?: boolean;
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1";

/**
 * Normalize an exact browser origin for Hydra client CORS.
 *
 * CORS origins contain only scheme, host and optional port. Paths, credentials,
 * queries, fragments and wildcard hosts are intentionally rejected.
 */
export function normalizeClientCorsOrigin(
  value: string,
  options: CorsOriginOptions = {},
): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("*")) return null;

  // URL canonicalization removes empty query/fragment delimiters and resolves
  // dot segments. Reject those inputs from their original spelling so only an
  // authority and an optional root slash can be accepted as an exact origin.
  if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#\\\s]+\/?$/i.test(trimmed)) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Hydra v26.2.0 persists IPv6 literal origins but does not emit its CORS
    // response headers for them, so do not accept a configuration it cannot enforce.
    if (url.hostname.startsWith("[") && url.hostname.endsWith("]")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol === "http:" && !(options.allowHttpLoopback && isLoopbackHostname(url.hostname))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Suggest exact browser origins from web redirect URIs without copying paths. */
export function clientCorsOriginsFromRedirectUris(
  redirectUris: readonly string[],
  options: CorsOriginOptions = {},
): string[] {
  const origins = new Set<string>();
  for (const redirectUri of redirectUris) {
    try {
      const url = new URL(redirectUri.trim());
      if (url.username || url.password) continue;
      const origin = normalizeClientCorsOrigin(url.origin, options);
      if (origin) origins.add(origin);
    } catch {
      // Native custom schemes and malformed redirect URIs are not browser origins.
    }
  }
  return [...origins];
}

export const OAUTH_CLIENT_PROFILES: Record<KnownOAuthClientType, OAuthClientProfile> = {
  spa: {
    type: "spa",
    label: "Single-page app",
    description: "Browser app using authorization code with PKCE.",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    requiresRedirectUris: true,
    supportsPostLogoutRedirectUris: true,
    defaultScope: "openid profile email offline_access",
  },
  service: {
    type: "service",
    label: "Machine-to-machine",
    description: "Backend service using client credentials.",
    grantTypes: ["client_credentials"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_basic",
    requiresRedirectUris: false,
    supportsPostLogoutRedirectUris: false,
    defaultScope: "",
  },
  web: {
    type: "web",
    label: "Server web app",
    description: "Server-rendered app with a confidential client secret.",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_basic",
    requiresRedirectUris: true,
    supportsPostLogoutRedirectUris: true,
    defaultScope: "openid profile email offline_access",
  },
  native: {
    type: "native",
    label: "Native app",
    description: "Installed app using authorization code with PKCE.",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    requiresRedirectUris: true,
    supportsPostLogoutRedirectUris: false,
    defaultScope: "openid profile email offline_access",
  },
};

export const KNOWN_OAUTH_CLIENT_TYPES: readonly KnownOAuthClientType[] = [
  "spa",
  "service",
  "web",
  "native",
];

export function isKnownOAuthClientType(value: unknown): value is KnownOAuthClientType {
  return typeof value === "string" && KNOWN_OAUTH_CLIENT_TYPES.includes(value as KnownOAuthClientType);
}
