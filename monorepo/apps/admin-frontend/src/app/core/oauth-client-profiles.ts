import {
  KNOWN_OAUTH_CLIENT_TYPES,
  OAUTH_CLIENT_PROFILES,
  isKnownOAuthClientType,
  type KnownOAuthClientType,
  type OAuthClientType,
  type OAuthClientProfile,
} from "@idnest/shared-types";
import type { HydraClient } from "./admin-types";

export interface ScopeOption {
  value: string;
  label: string;
}

export interface OAuthClientProfileView extends OAuthClientProfile {
  scopeOptions: readonly ScopeOption[];
  audiencePlaceholder: string;
  redirectPlaceholder: string;
}

const OIDC_SCOPE_OPTIONS: readonly ScopeOption[] = [
  { value: "openid", label: "OpenID" },
  { value: "profile", label: "Profile" },
  { value: "email", label: "Email" },
  { value: "offline_access", label: "Offline access" },
];

const API_SCOPE_OPTIONS: readonly ScopeOption[] = [
  { value: "resource.read", label: "Resource read" },
  { value: "resource.write", label: "Resource write" },
  { value: "resource.manage", label: "Resource manage" },
];

export const CLIENT_PROFILE_VIEWS: Record<KnownOAuthClientType, OAuthClientProfileView> = {
  spa: {
    ...OAUTH_CLIENT_PROFILES.spa,
    scopeOptions: OIDC_SCOPE_OPTIONS,
    audiencePlaceholder: "example-api",
    redirectPlaceholder: "https://client.example/auth/callback",
  },
  service: {
    ...OAUTH_CLIENT_PROFILES.service,
    scopeOptions: API_SCOPE_OPTIONS,
    audiencePlaceholder: "example-api",
    redirectPlaceholder: "",
  },
  web: {
    ...OAUTH_CLIENT_PROFILES.web,
    scopeOptions: OIDC_SCOPE_OPTIONS,
    audiencePlaceholder: "example-api",
    redirectPlaceholder: "https://client.example/auth/callback",
  },
  native: {
    ...OAUTH_CLIENT_PROFILES.native,
    scopeOptions: OIDC_SCOPE_OPTIONS,
    audiencePlaceholder: "example-api",
    redirectPlaceholder: "com.example.app:/auth/callback",
  },
};

export const CLIENT_PROFILE_OPTIONS: readonly OAuthClientProfileView[] = KNOWN_OAUTH_CLIENT_TYPES.map(
  (type) => CLIENT_PROFILE_VIEWS[type],
);

export function getKnownClientProfile(type: OAuthClientType): OAuthClientProfileView | null {
  return isKnownOAuthClientType(type) ? CLIENT_PROFILE_VIEWS[type] : null;
}

export function getOAuthClientTypeLabel(type: OAuthClientType): string {
  return getKnownClientProfile(type)?.label ?? "Custom / legacy";
}

export function inferOAuthClientType(client: HydraClient): OAuthClientType {
  const metadataType = client.metadata?.client_type;
  if (isKnownOAuthClientType(metadataType)) return metadataType;
  if (metadataType === "custom") return "custom";

  const grantTypes = new Set(client.grant_types ?? []);
  const responseTypes = new Set(client.response_types ?? []);
  const authMethod = client.token_endpoint_auth_method;

  if (grantTypes.has("client_credentials") && !grantTypes.has("authorization_code")) return "service";
  if (grantTypes.has("authorization_code") && responseTypes.has("code") && authMethod === "none") return "spa";
  if (
    grantTypes.has("authorization_code") &&
    responseTypes.has("code") &&
    authMethod === "client_secret_basic"
  ) {
    return "web";
  }

  if (grantTypes.size === 0 && authMethod === "none") return "spa";
  if (grantTypes.size === 0 && authMethod === "client_secret_basic" && (client.redirect_uris ?? []).length > 0) {
    return "web";
  }

  return "custom";
}
