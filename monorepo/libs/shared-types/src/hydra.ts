/**
 * Hydra consent/login/logout types + runtime guards shared by the auth backend
 * and frontend. Ported from the original Next.js app's
 * `src/app/util/types/hydra-consent.type.ts`.
 */

export interface HydraClient {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  client_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  contacts?: string[];
  audience?: string[];
  redirect_uris?: string[];
  post_logout_redirect_uris?: string[];
  allowed_cors_origins?: string[];
  metadata?: HydraClientMetadata | null;
  [key: string]: unknown;
}

export type HydraClientTrustTier = "first_party" | "partner" | "third_party";

export interface HydraClientMetadata {
  trust_tier?: HydraClientTrustTier;
  consent_version?: number;
  remember_offline_access?: boolean;
  allowed_return_uris?: string[];
  [key: string]: unknown;
}

export interface HydraOpenIdConnectContext {
  acr_values?: string[];
  display?: string;
  id_token_hint_claims?: Record<string, unknown>;
  login_hint?: string;
  max_age?: number;
  prompt?: string[];
  ui_locales?: string[];
  [key: string]: unknown;
}

export interface HydraLoginRequest {
  challenge: string;
  client: HydraClient;
  oidc_context?: HydraOpenIdConnectContext;
  request_url?: string;
  requested_access_token_audience?: string[];
  requested_scope?: string[];
  session_id?: string;
  skip: boolean;
  subject?: string;
  [key: string]: unknown;
}

export interface HydraConsentRequest {
  challenge: string;
  client: HydraClient;
  requested_scope: string[];
  requested_access_token_audience: string[];
  skip: boolean;
  subject: string;
  acr?: string;
  amr?: string[];
  context?: Record<string, unknown>;
  login_challenge?: string;
  login_session_id?: string;
  oidc_context?: HydraOpenIdConnectContext;
  request_url?: string;
  [key: string]: unknown;
}

/** Every Hydra accept/reject endpoint we call returns a redirect target. */
export interface HydraRedirectResponse {
  redirect_to: string;
}

export type HydraConsentResponse = HydraRedirectResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Runtime guard for a Hydra consent request. We only assert the fields the
 * backend actually consumes (subject + the requested scope/audience that drive
 * the grant); Hydra includes many more.
 */
export function isHydraConsentRequest(value: unknown): value is HydraConsentRequest {
  if (!isRecord(value)) return false;
  if (!isRecord(value.client) || typeof value.client.client_id !== "string") return false;
  if (typeof value.subject !== "string") return false;
  if (!isStringArray(value.requested_scope)) return false;
  if (!isStringArray(value.requested_access_token_audience)) return false;
  return true;
}

export function isHydraLoginRequest(value: unknown): value is HydraLoginRequest {
  if (!isRecord(value)) return false;
  if (!isRecord(value.client) || typeof value.client.client_id !== "string") return false;
  if (typeof value.skip !== "boolean") return false;
  if (value.challenge !== undefined && typeof value.challenge !== "string") return false;
  if (value.subject !== undefined && typeof value.subject !== "string") return false;
  if (value.requested_scope !== undefined && !isStringArray(value.requested_scope)) return false;
  if (
    value.requested_access_token_audience !== undefined &&
    !isStringArray(value.requested_access_token_audience)
  ) {
    return false;
  }
  return true;
}

/** Runtime guard for the `{ redirect_to }` responses Hydra returns. */
export function isHydraRedirectResponse(value: unknown): value is HydraRedirectResponse {
  return isRecord(value) && typeof value.redirect_to === "string";
}
