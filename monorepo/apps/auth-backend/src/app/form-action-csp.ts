import type { HydraClient } from "@idnest/shared-types";
import { getHydraPublicUrl, getKratosPublicUrl } from "./config";

const OIDC_AUTHORIZE_ORIGINS = [
  "https://accounts.google.com",
  "https://accounts.youtube.com",
  "https://appleid.apple.com",
] as const;

export interface AuthCspOptions {
  kratosPublicUrl?: string;
  hydraPublicUrl?: string;
  assetOrigins?: string[];
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** HTTPS origins from a Hydra client's redirect_uris. Credentials and fragments are ignored. */
export function clientRedirectOrigins(redirectUris: string[] | undefined): string[] {
  const origins: string[] = [];
  for (const value of redirectUris ?? []) {
    try {
      const url = new URL(value);
      if (url.username || url.password) continue;
      if (url.protocol !== "https:") continue;
      origins.push(url.origin);
    } catch {
      // Skip malformed redirect URIs.
    }
  }
  return unique(origins);
}

export function clientRedirectOriginsFromClient(client: Pick<HydraClient, "redirect_uris">): string[] {
  return clientRedirectOrigins(client.redirect_uris);
}

export function platformFormActionSources(options: AuthCspOptions = {}): string[] {
  const kratos = originOf(options.kratosPublicUrl ?? getKratosPublicUrl());
  const hydra = originOf(options.hydraPublicUrl ?? getHydraPublicUrl());
  return unique(["'self'", kratos, hydra, ...OIDC_AUTHORIZE_ORIGINS]);
}

function assetOriginList(options: AuthCspOptions): string[] {
  if (options.assetOrigins) return options.assetOrigins.filter(Boolean);
  return (process.env.AUTH_ASSET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Browser CSP for auth HTML. `clientOrigins` are the current OAuth client's
 * redirect_uri origins; they are not read from AUTH_RETURN_TO_ALLOWED_ORIGINS.
 */
export function buildAuthCsp(clientOrigins: string[] = [], options: AuthCspOptions = {}): string {
  const kratos = originOf(options.kratosPublicUrl ?? getKratosPublicUrl());
  const assetOrigins = assetOriginList(options);
  const formAction = unique([...platformFormActionSources(options), ...clientOrigins]);
  return [
    "default-src 'self'",
    `connect-src 'self'${kratos ? ` ${kratos}` : ""}`,
    `img-src 'self' data:${assetOrigins.length ? ` ${assetOrigins.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action ${formAction.join(" ")}`,
  ].join("; ");
}
