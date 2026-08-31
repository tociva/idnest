export const DELEGATION_STATUS_VALUES = ["active", "disabled", "archived"] as const;
export type DelegationStatus = (typeof DELEGATION_STATUS_VALUES)[number];

export const DELEGATION_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const DELEGATION_GRANT_TOKEN_TYPE =
  "urn:idnest:params:oauth:token-type:delegation-grant" as const;
export const OAUTH_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token" as const;
export const DELEGATION_AUTHORIZATION_DETAILS_TYPE =
  "urn:idnest:delegation" as const;

export const DELEGATION_GRANT_SCOPE = "delegation.grant" as const;
export const DELEGATION_EXCHANGE_SCOPE = "delegation.exchange" as const;

export interface DelegationResourceDefinition {
  key: string;
  displayName: string;
  audience: string;
  authorizerClientId: string;
  allowedScopes: string[];
  tokenTtlSeconds: number;
  authorizationContextRequired: boolean;
}

export interface DelegationResource {
  id: string;
  status: DelegationStatus;
  version: number;
  definition: DelegationResourceDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationActorPolicyDefinition {
  actorClientId: string;
  allowedScopes: string[];
}

export interface DelegationActorPolicy {
  id: string;
  resourceId: string;
  status: DelegationStatus;
  version: number;
  definition: DelegationActorPolicyDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationGrantRequest {
  resource: string;
  subject: string;
  actorClientId: string;
  scope: string | string[];
  authorizationContext?: string;
  correlationId?: string;
}

export interface DelegationGrantResponse {
  grantId: string;
  exchangeToken: string;
  expiresIn: number;
}

export interface DelegationTokenExchangeResponse {
  access_token: string;
  issued_token_type: typeof OAUTH_ACCESS_TOKEN_TYPE;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface DelegationAuthorizationDetails {
  type: typeof DELEGATION_AUTHORIZATION_DETAILS_TYPE;
  grant_id: string;
  context?: string;
}

export interface DelegatedAccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  act: { sub: string };
  scope: string;
  authorization_details: DelegationAuthorizationDetails[];
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isDelegationStatus(value: unknown): value is DelegationStatus {
  return DELEGATION_STATUS_VALUES.includes(value as DelegationStatus);
}

export function isDelegationScope(value: unknown): value is string {
  return typeof value === "string" && SCOPE_PATTERN.test(value);
}

export function isDelegationResourceKey(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_KEY_PATTERN.test(value);
}

export function canonicalDelegationScopes(value: unknown): string[] {
  if (Array.isArray(value) && value.some((item) => typeof item !== "string")) {
    throw new Error("Delegation scopes must contain only strings");
  }
  const candidates = typeof value === "string"
    ? value.split(/\s+/)
    : Array.isArray(value)
      ? value
      : [];
  const scopes = [...new Set(candidates.map((item) =>
    typeof item === "string" ? item.trim() : "",
  ).filter(Boolean))].sort();
  if (scopes.length === 0 || scopes.length > 50 || scopes.some((scope) => !isDelegationScope(scope))) {
    throw new Error("Delegation scopes must contain 1 to 50 valid scope names");
  }
  return scopes;
}

export function delegationScopeSubset(requested: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((scope) => allowedSet.has(scope));
}
