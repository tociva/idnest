/**
 * Hydra OAuth client management (Phase 3.4). Talks to the Hydra *admin* API.
 * Mirrors the Hydra client payload shape used by the admin-client bootstrap
 * script so clients created here stay consistent with provisioned clients.
 */
import {
  OAUTH_CLIENT_PROFILES,
  isKnownOAuthClientType,
  normalizeClientCorsOrigin,
  type KnownOAuthClientType,
  type OAuthClientType,
} from "@idnest/shared-types";
import { getAdminOidcClientId, getHydraAdminUrl } from "../config";
import { errorBody, readError, type HandlerResult } from "./types";

const clientsBase = (): string => `${getHydraAdminUrl().replace(/\/+$/, "")}/admin/clients`;

export interface ClientPayload {
  client_id?: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  contacts?: string[];
  metadata?: {
    trust_tier?: "first_party" | "partner" | "third_party";
    consent_version?: number;
    remember_offline_access?: boolean;
    client_type?: OAuthClientType;
    allowed_return_uris?: string[];
    [key: string]: unknown;
  };
  client_type?: OAuthClientType;
  public?: boolean;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  redirect_uris?: string[];
  post_logout_redirect_uris?: string[];
  allowed_cors_origins?: string[];
  audience?: string[];
}

const MAX_CLIENT_ORIGINS = 20;
const CORS_ORIGIN_OPTIONS = { allowHttpLoopback: true } as const;

function normalizeCorsOrigins(values: string[] | undefined): string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > MAX_CLIENT_ORIGINS) {
    throw new Error(`allowed_cors_origins must contain at most ${MAX_CLIENT_ORIGINS} origins`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw new Error("allowed_cors_origins entries must be strings");
    const origin = normalizeClientCorsOrigin(value, CORS_ORIGIN_OPTIONS);
    if (!origin) {
      throw new Error(
        "allowed_cors_origins entries must be exact supported HTTPS or HTTP loopback origins without paths, credentials, queries, fragments, wildcards, or IPv6 literals",
      );
    }
    return origin;
  });
  return [...new Set(normalized)];
}

function normalizeReturnUris(values: string[] | undefined): string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > MAX_CLIENT_ORIGINS) {
    throw new Error(`metadata.allowed_return_uris must contain at most ${MAX_CLIENT_ORIGINS} URLs`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw new Error("metadata.allowed_return_uris entries must be strings");
    try {
      const url = new URL(value.trim());
      if (url.username || url.password || url.hash) throw new Error("invalid");
      if (
        !normalizeClientCorsOrigin(url.origin, {
          allowHttpLoopback: process.env.NODE_ENV !== "production",
        })
      ) {
        throw new Error("invalid");
      }
      return url.toString();
    } catch {
      throw new Error(
        "metadata.allowed_return_uris entries must be exact HTTPS URLs without credentials or fragments",
      );
    }
  });
  return [...new Set(normalized)];
}

/** Required fields for creating a client. */
function validateForCreate(input: ClientPayload): string | null {
  const clientType = resolveClientType(input);
  const profile = getKnownProfile(clientType);
  if (!input.client_id) return "client_id is required";
  if (clientType === "custom") return "client_type=custom is only supported for existing clients";
  if (profile?.requiresRedirectUris && (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0)) {
    return "redirect_uris must be a non-empty array";
  }
  if (clientType === "spa" && (!Array.isArray(input.allowed_cors_origins) || input.allowed_cors_origins.length === 0)) {
    return "allowed_cors_origins must be a non-empty array for SPA clients";
  }
  return null;
}

function normalizedMetadata(input: ClientPayload["metadata"]) {
  return {
    ...input,
    trust_tier: input?.trust_tier ?? "first_party",
    consent_version: input?.consent_version ?? 1,
    remember_offline_access: input?.remember_offline_access === true,
    allowed_return_uris: normalizeReturnUris(input?.allowed_return_uris),
  };
}

function validateClientBrowserConfiguration(input: ClientPayload): string | null {
  try {
    const clientType = resolveClientType(input);
    const origins = normalizeCorsOrigins(input.allowed_cors_origins);
    const returnUris = normalizeReturnUris(input.metadata?.allowed_return_uris);
    if (clientType === "spa" && origins.length === 0) {
      return "allowed_cors_origins must be a non-empty array for SPA clients";
    }
    if (clientType !== "spa" && clientType !== "custom" && origins.length > 0) {
      return "allowed_cors_origins is only supported for SPA or custom clients";
    }
    if ((clientType === "service" || clientType === "native") && returnUris.length > 0) {
      return "allowed_return_uris is only supported for browser-based clients";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid browser client configuration";
  }
}

function validateRememberOfflineAccess(input: ClientPayload): string | null {
  const metadata = normalizedMetadata(input.metadata);
  if (metadata.remember_offline_access === true && metadata.trust_tier !== "first_party") {
    return "remember_offline_access is only allowed for first_party clients";
  }
  return null;
}

function getKnownProfile(clientType: OAuthClientType) {
  return isKnownOAuthClientType(clientType) ? OAUTH_CLIENT_PROFILES[clientType] : null;
}

function normalizeClientType(value: unknown): OAuthClientType | null {
  if (isKnownOAuthClientType(value)) return value;
  return value === "custom" ? "custom" : null;
}

function hasOnlyClientCredentials(input: ClientPayload): boolean {
  const grants = new Set(input.grant_types ?? []);
  return grants.has("client_credentials") && !grants.has("authorization_code");
}

function resolveClientType(input: ClientPayload): OAuthClientType {
  const explicitType = normalizeClientType(input.client_type);
  if (explicitType) return explicitType;

  const metadataType = normalizeClientType(input.metadata?.client_type);
  if (metadataType) return metadataType;

  if (hasOnlyClientCredentials(input)) return "service";
  if (input.public === true) return "spa";
  return "web";
}

function resolveKnownType(input: ClientPayload): KnownOAuthClientType | null {
  const clientType = resolveClientType(input);
  return isKnownOAuthClientType(clientType) ? clientType : null;
}

function normalizedProtocolList(input: string[] | undefined, fallback: readonly string[]): string[] {
  return Array.isArray(input) && input.length > 0 ? input : [...fallback];
}

function toHydraPayload(input: ClientPayload) {
  const knownType = resolveKnownType(input);
  const profile = knownType ? OAUTH_CLIENT_PROFILES[knownType] : null;
  const metadata = normalizedMetadata(input.metadata);
  if (knownType) {
    metadata.client_type = knownType;
  }

  const grantTypes = profile
    ? [...profile.grantTypes]
    : normalizedProtocolList(input.grant_types, OAUTH_CLIENT_PROFILES.web.grantTypes);
  const responseTypes = profile
    ? [...profile.responseTypes]
    : normalizedProtocolList(input.response_types, OAUTH_CLIENT_PROFILES.web.responseTypes);
  const tokenEndpointAuthMethod =
    profile?.tokenEndpointAuthMethod ??
    input.token_endpoint_auth_method ??
    (input.public === true ? "none" : "client_secret_basic");

  return {
    client_id: input.client_id,
    client_name: input.client_name ?? input.client_id,
    grant_types: grantTypes,
    response_types: responseTypes,
    scope: input.scope ?? profile?.defaultScope ?? OAUTH_CLIENT_PROFILES.web.defaultScope,
    redirect_uris: profile?.requiresRedirectUris === false ? [] : input.redirect_uris ?? [],
    post_logout_redirect_uris:
      profile?.supportsPostLogoutRedirectUris === false ? [] : input.post_logout_redirect_uris ?? [],
    allowed_cors_origins: normalizeCorsOrigins(input.allowed_cors_origins),
    audience: input.audience ?? [],
    client_uri: input.client_uri || undefined,
    logo_uri: input.logo_uri || undefined,
    policy_uri: input.policy_uri || undefined,
    tos_uri: input.tos_uri || undefined,
    contacts: input.contacts ?? [],
    metadata,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
}

function isProtectedAdminClient(clientId: string | undefined): boolean {
  return clientId === getAdminOidcClientId();
}

export async function listClients(): Promise<HandlerResult> {
  try {
    const res = await fetch(clientsBase());
    if (!res.ok) {
      return { status: 500, body: { error: `Failed to list clients: ${await readError(res)}` } };
    }
    return { status: 200, body: await res.json() };
  } catch (err) {
    return { status: 500, body: errorBody(err) };
  }
}

export interface ClientIdInput {
  client_id?: string;
}

export async function getClient(input: ClientIdInput): Promise<HandlerResult> {
  try {
    if (!input.client_id) return { status: 400, body: { error: "client_id is required" } };
    const res = await fetch(`${clientsBase()}/${encodeURIComponent(input.client_id)}`);
    if (res.status === 404) return { status: 404, body: { error: "Client not found" } };
    if (!res.ok) {
      return { status: 500, body: { error: `Failed to get client: ${await readError(res)}` } };
    }
    return { status: 200, body: await res.json() };
  } catch (err) {
    return { status: 500, body: errorBody(err) };
  }
}

export async function createClient(input: ClientPayload): Promise<HandlerResult> {
  try {
    const invalid = validateForCreate(input);
    if (invalid) return { status: 400, body: { error: invalid } };
    const invalidBrowserConfiguration = validateClientBrowserConfiguration(input);
    if (invalidBrowserConfiguration) return { status: 400, body: { error: invalidBrowserConfiguration } };
    const invalidPolicy = validateRememberOfflineAccess(input);
    if (invalidPolicy) return { status: 400, body: { error: invalidPolicy } };
    const res = await fetch(clientsBase(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toHydraPayload(input)),
    });
    if (!res.ok) {
      return { status: 500, body: { error: `Failed to create client: ${await readError(res)}` } };
    }
    return { status: 201, body: await res.json() };
  } catch (err) {
    return { status: 500, body: errorBody(err) };
  }
}

export async function updateClient(input: ClientPayload): Promise<HandlerResult> {
  try {
    if (!input.client_id) return { status: 400, body: { error: "client_id is required" } };
    if (isProtectedAdminClient(input.client_id)) {
      return { status: 403, body: { error: "The admin OAuth client cannot be edited" } };
    }
    const invalidBrowserConfiguration = validateClientBrowserConfiguration(input);
    if (invalidBrowserConfiguration) return { status: 400, body: { error: invalidBrowserConfiguration } };
    const invalidPolicy = validateRememberOfflineAccess(input);
    if (invalidPolicy) return { status: 400, body: { error: invalidPolicy } };
    const res = await fetch(`${clientsBase()}/${encodeURIComponent(input.client_id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toHydraPayload(input)),
    });
    if (res.status === 404) return { status: 404, body: { error: "Client not found" } };
    if (!res.ok) {
      return { status: 500, body: { error: `Failed to update client: ${await readError(res)}` } };
    }
    return { status: 200, body: await res.json() };
  } catch (err) {
    return { status: 500, body: errorBody(err) };
  }
}

export async function deleteClient(input: ClientIdInput): Promise<HandlerResult> {
  try {
    if (!input.client_id) return { status: 400, body: { error: "client_id is required" } };
    if (isProtectedAdminClient(input.client_id)) {
      return { status: 403, body: { error: "The admin OAuth client cannot be deleted" } };
    }
    const res = await fetch(`${clientsBase()}/${encodeURIComponent(input.client_id)}`, {
      method: "DELETE",
    });
    if (res.status === 404) return { status: 404, body: { error: "Client not found" } };
    if (!res.ok) {
      return { status: 500, body: { error: `Failed to delete client: ${await readError(res)}` } };
    }
    return { status: 200, body: { deleted: true, client_id: input.client_id } };
  } catch (err) {
    return { status: 500, body: errorBody(err) };
  }
}
