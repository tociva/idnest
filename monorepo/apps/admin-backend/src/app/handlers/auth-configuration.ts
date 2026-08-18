import {
  archiveOAuthClientAuthConfig,
  createAuthBrand,
  createAuthPolicy,
  getAuthBrand,
  getAuthzPool,
  getAuthPolicy,
  listAuthBrands,
  listAuthBrandVersions,
  listAuthPolicies,
  listAuthPolicyVersions,
  listOAuthClientAuthConfigs,
  listOAuthClientAuthConfigVersions,
  recordAuthAuditEvent,
  updateAuthBrand,
  updateAuthPolicy,
  upsertOAuthClientAuthConfig,
} from "@idnest/authz-store";
import {
  DEFAULT_AUTH_POLICY_NAME,
  type AuthBrandDefinition,
  type AuthBrandStatus,
  type AuthClientConfigStatus,
  type AuthPolicyDefinition,
  type ConsentMode,
  type IdentityGate,
} from "@idnest/shared-types";
import {
  getAuthAssetAllowedOrigins,
  getAuthzDatabaseUrl,
  getHydraAdminUrl,
} from "../config";
import { errorBody, type HandlerResult } from "./types";

type JsonObject = Record<string, unknown>;

interface ActorInput {
  actor?: string | null;
}

interface ResourceInput extends ActorInput {
  id?: string;
  body?: JsonObject;
}

interface MappingInput extends ActorInput {
  clientId?: string;
  body?: JsonObject;
}

const BRAND_STATUSES = new Set<AuthBrandStatus>(["draft", "active", "disabled", "archived"]);
const CONFIG_STATUSES = new Set<AuthClientConfigStatus>(["active", "disabled", "archived"]);
const CONSENT_MODES = new Set<ConsentMode>([
  "always-show",
  "skip-for-first-party",
  "follow-hydra",
]);
const COLOR = /^#[0-9a-f]{6}$/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RADIUS = /^(?:0|(?:[0-9]|[12][0-9]|3[0-2])(?:px|rem|em))$/;

function database() {
  return getAuthzPool(getAuthzDatabaseUrl());
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(
  input: JsonObject,
  key: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const normalized = value.trim();
  if (!normalized && options.required) throw new Error(`${key} is required`);
  if (normalized.length > (options.max ?? 500)) throw new Error(`${key} is too long`);
  return normalized || undefined;
}

function bool(input: JsonObject, key: string): boolean {
  if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return input[key];
}

function stringList(input: JsonObject, key: string, maxItems = 50): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${key} must be an array with at most ${maxItems} entries`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${key} entries must be non-empty strings`);
    }
    if (item.trim().length > 254) throw new Error(`${key} entries are too long`);
    return item.trim();
  });
  return [...new Set(result)];
}

function optionalWebUrl(
  input: JsonObject,
  key: string,
  allowedOrigins: string[] | null = null,
): string | undefined {
  const value = text(input, key, { max: 2048 });
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTPS URL or a root-relative path`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${key} must be an absolute HTTPS URL or a root-relative path`);
  }
  if (allowedOrigins) {
    const allowed = new Set(allowedOrigins);
    if (allowed.size === 0 || !allowed.has(url.origin)) {
      throw new Error(`${key} origin is not approved`);
    }
  }
  return url.toString();
}

function parseBrandDefinition(input: unknown, status: AuthBrandStatus): AuthBrandDefinition {
  if (!isObject(input)) throw new Error("definition must be an object");
  const key = text(input, "key", { required: true, max: 64 }) as string;
  if (!IDENTIFIER.test(key)) {
    throw new Error("definition.key must be a lowercase, hyphenated identifier");
  }
  const color = (name: string): string => {
    const value = text(input, name, { required: true, max: 7 }) as string;
    if (!COLOR.test(value)) throw new Error(`${name} must be a six-digit hex color`);
    return value.toLowerCase();
  };
  const radius = text(input, "borderRadius", { required: true, max: 8 }) as string;
  if (!RADIUS.test(radius)) throw new Error("borderRadius must be between 0 and 32px/rem/em");
  const fontFamily = text(input, "fontFamily", { required: true, max: 16 });
  if (fontFamily !== "system" && fontFamily !== "roboto") {
    throw new Error("fontFamily must be system or roboto");
  }

  const definition: AuthBrandDefinition = {
    key,
    displayName: text(input, "displayName", { required: true, max: 100 }) as string,
    legalName: text(input, "legalName", { required: true, max: 160 }) as string,
    productName: text(input, "productName", { required: true, max: 100 }) as string,
    logoLightUrl: optionalWebUrl(
      input,
      "logoLightUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    logoDarkUrl: optionalWebUrl(
      input,
      "logoDarkUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    logoCompactUrl: optionalWebUrl(
      input,
      "logoCompactUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    faviconUrl: optionalWebUrl(
      input,
      "faviconUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    backgroundImageUrl: optionalWebUrl(
      input,
      "backgroundImageUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    illustrationUrl: optionalWebUrl(
      input,
      "illustrationUrl",
      status === "active" ? getAuthAssetAllowedOrigins() : null,
    ),
    primaryColor: color("primaryColor"),
    secondaryColor: color("secondaryColor"),
    surfaceColor: color("surfaceColor"),
    textColor: color("textColor"),
    mutedTextColor: color("mutedTextColor"),
    errorColor: color("errorColor"),
    borderRadius: radius,
    fontFamily,
    loginHeading: text(input, "loginHeading", { required: true, max: 120 }) as string,
    loginDescription: text(input, "loginDescription", { required: true, max: 300 }) as string,
    registrationHeading: text(input, "registrationHeading", {
      required: true,
      max: 120,
    }) as string,
    recoveryHeading: text(input, "recoveryHeading", { required: true, max: 120 }) as string,
    consentHeading: text(input, "consentHeading", { required: true, max: 120 }) as string,
    supportUrl: optionalWebUrl(input, "supportUrl"),
    privacyUrl: optionalWebUrl(input, "privacyUrl"),
    termsUrl: optionalWebUrl(input, "termsUrl"),
    copyrightText: text(input, "copyrightText", { max: 160 }),
    defaultLocale: text(input, "defaultLocale", { required: true, max: 16 }) as string,
  };
  if (
    status === "active" &&
    (!definition.supportUrl || !definition.privacyUrl || !definition.termsUrl)
  ) {
    throw new Error("active brands require supportUrl, privacyUrl, and termsUrl");
  }
  return definition;
}

const IDENTITY_GATES = new Set<IdentityGate>([
  "public",
  "invitation",
  "existing-identity",
  "email-allowlist",
  "domain-allowlist",
  "org-membership",
  "custom",
]);

function parseAuthPolicyDefinition(input: unknown): AuthPolicyDefinition {
  if (!isObject(input)) throw new Error("definition must be an object");
  const name = text(input, "name", { required: true, max: 100 }) as string;
  const providers = stringList(input, "allowedOidcProviders", 20);
  if (providers.some((provider) => !PROVIDER.test(provider))) {
    throw new Error("allowedOidcProviders contains an invalid provider identifier");
  }
  const domains = stringList(input, "allowedEmailDomains").map((domain) => domain.toLowerCase());
  if (
    domains.some(
      (domain) =>
        domain.startsWith(".") ||
        domain.endsWith(".") ||
        !/^[a-z0-9.-]+$/.test(domain) ||
        !domain.includes("."),
    )
  ) {
    throw new Error("allowedEmailDomains contains an invalid domain");
  }
  const emails = stringList(input, "allowedEmails").map((email) => email.toLowerCase());
  if (emails.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new Error("allowedEmails contains an invalid email address");
  }
  const minimumAal = text(input, "minimumAal", { required: true, max: 4 });
  if (minimumAal !== "aal1" && minimumAal !== "aal2") {
    throw new Error("minimumAal must be aal1 or aal2");
  }
  const registrationMode = text(input, "registrationMode", { required: true, max: 20 });
  if (
    registrationMode !== "enabled" &&
    registrationMode !== "disabled" &&
    registrationMode !== "invitation-only"
  ) {
    throw new Error("registrationMode is invalid");
  }
  const identityGate = text(input, "identityGate", { required: true, max: 32 }) as IdentityGate;
  if (!IDENTITY_GATES.has(identityGate)) {
    throw new Error("identityGate is invalid");
  }
  if (identityGate === "public" && registrationMode !== "enabled") {
    throw new Error("public identity gate requires registrationMode enabled");
  }
  if (identityGate === "public" && (emails.length > 0 || domains.length > 0)) {
    throw new Error("public identity gate cannot include email or domain allowlists");
  }
  if (identityGate === "invitation" && registrationMode !== "invitation-only") {
    throw new Error("invitation identity gate requires registrationMode invitation-only");
  }
  if (
    (identityGate === "existing-identity" ||
      identityGate === "org-membership" ||
      identityGate === "custom") &&
    registrationMode !== "disabled"
  ) {
    throw new Error(`${identityGate} identity gate requires registrationMode disabled`);
  }
  if (identityGate === "email-allowlist" && emails.length === 0) {
    throw new Error("email-allowlist identity gate requires at least one allowed email");
  }
  if (identityGate === "domain-allowlist" && domains.length === 0) {
    throw new Error("domain-allowlist identity gate requires at least one allowed domain");
  }
  const maximumAge = input["sessionMaximumAgeSeconds"];
  if (
    typeof maximumAge !== "number" ||
    !Number.isInteger(maximumAge) ||
    maximumAge < 60 ||
    maximumAge > 30 * 24 * 60 * 60
  ) {
    throw new Error("sessionMaximumAgeSeconds must be an integer between 60 and 2592000");
  }
  return {
    name,
    passwordEnabled: bool(input, "passwordEnabled"),
    passkeyEnabled: bool(input, "passkeyEnabled"),
    allowedOidcProviders: providers,
    totpEnabled: bool(input, "totpEnabled"),
    minimumAal,
    registrationMode,
    identityGate,
    allowedEmailDomains: domains,
    allowedEmails: emails,
    requireVerifiedEmail: bool(input, "requireVerifiedEmail"),
    forceReauthentication: bool(input, "forceReauthentication"),
    sessionMaximumAgeSeconds: maximumAge,
  };
}

function parseStatus<T extends string>(
  input: JsonObject,
  allowed: Set<T>,
  fallback?: T,
): T {
  const candidate = text(input, "status", { max: 20 }) ?? fallback;
  if (!candidate || !allowed.has(candidate as T)) throw new Error("status is invalid");
  return candidate as T;
}

function expectedVersion(input: JsonObject): number {
  const value = input["expectedVersion"];
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error("expectedVersion must be a positive integer");
  }
  return Number(value);
}

function conflictAware(err: unknown): HandlerResult {
  const code = isObject(err) && typeof err["code"] === "string" ? err["code"] : "";
  if (code === "23505") return { status: 409, body: { error: "That identifier already exists" } };
  if (code === "23503" || code === "22P02") {
    return { status: 400, body: { error: "A referenced configuration does not exist" } };
  }
  return { status: 500, body: errorBody(err) };
}

function isDatabaseError(err: unknown): boolean {
  return isObject(err) && typeof err["code"] === "string";
}

async function audit(
  eventType: string,
  actor: string | null | undefined,
  metadata: Record<string, unknown>,
  links: { clientId?: string; brandId?: string; authenticationPolicyId?: string } = {},
): Promise<void> {
  const db = database();
  if (!db) return;
  await recordAuthAuditEvent(db, {
    eventType,
    hydraClientId: links.clientId,
    brandId: links.brandId,
    authenticationPolicyId: links.authenticationPolicyId,
    result: "success",
    metadata: { actor: actor ?? "unknown", ...metadata },
  });
}

export async function listBrandConfigurations(): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listAuthBrands(db) };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function getBrandConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid brand id" } };
  try {
    const brand = await getAuthBrand(db, input.id);
    return brand
      ? { status: 200, body: brand }
      : { status: 404, body: { error: "Brand not found" } };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function listBrandConfigurationHistory(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid brand id" } };
  try {
    if (!(await getAuthBrand(db, input.id))) {
      return { status: 404, body: { error: "Brand not found" } };
    }
    return { status: 200, body: await listAuthBrandVersions(db, input.id) };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function createBrandConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const body = input.body ?? {};
    const status = parseStatus(body, BRAND_STATUSES, "draft");
    if (status === "archived") throw new Error("A new brand cannot be archived");
    const brand = await createAuthBrand(db, {
      status,
      definition: parseBrandDefinition(body["definition"], status),
      actor: input.actor,
      reason: text(body, "reason", { max: 500 }),
    });
    await audit("auth.brand.created", input.actor, { version: brand.version }, {
      brandId: brand.id,
    });
    return { status: 201, body: brand };
  } catch (err) {
    if (err instanceof Error && !isDatabaseError(err)) return { status: 400, body: errorBody(err) };
    return conflictAware(err);
  }
}

export async function updateBrandConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid brand id" } };
  try {
    const body = input.body ?? {};
    const current = await getAuthBrand(db, input.id);
    if (!current) return { status: 404, body: { error: "Brand not found" } };
    const status = parseStatus(body, BRAND_STATUSES, current.status);
    const definition = parseBrandDefinition(body["definition"] ?? current.definition, status);
    if (definition.key !== current.key) {
      return { status: 400, body: { error: "Brand keys are immutable" } };
    }
    const brand = await updateAuthBrand(db, input.id, expectedVersion(body), {
      status,
      definition,
      actor: input.actor,
      reason: text(body, "reason", { max: 500 }),
    });
    if (!brand) {
      return { status: 409, body: { error: "Brand changed; reload before saving again" } };
    }
    await audit("auth.brand.updated", input.actor, { version: brand.version }, {
      brandId: brand.id,
    });
    return { status: 200, body: brand };
  } catch (err) {
    if (err instanceof Error && !isDatabaseError(err)) return { status: 400, body: errorBody(err) };
    return conflictAware(err);
  }
}

export async function archiveBrandConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid brand id" } };
  try {
    const current = await getAuthBrand(db, input.id);
    if (!current) return { status: 404, body: { error: "Brand not found" } };
    if (current.key === "idnest-default") {
      return { status: 403, body: { error: "The fallback brand cannot be archived" } };
    }
    const mappings = await listOAuthClientAuthConfigs(db);
    if (mappings.some((mapping) => mapping.brand_id === input.id && mapping.status === "active")) {
      return {
        status: 409,
        body: { error: "Disable or remap active OAuth clients before archiving this brand" },
      };
    }
    const updated = await updateAuthBrand(db, input.id, current.version, {
      status: "archived",
      definition: current.definition,
      actor: input.actor,
      reason: "Archived from the administration console",
    });
    if (!updated) return { status: 409, body: { error: "Brand changed; reload and retry" } };
    await audit("auth.brand.archived", input.actor, {}, { brandId: input.id });
    return { status: 200, body: { archived: true, id: input.id } };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function listPolicyConfigurations(): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listAuthPolicies(db) };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function getPolicyConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid policy id" } };
  try {
    const policy = await getAuthPolicy(db, input.id);
    return policy
      ? { status: 200, body: policy }
      : { status: 404, body: { error: "Policy not found" } };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function listPolicyConfigurationHistory(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid policy id" } };
  try {
    if (!(await getAuthPolicy(db, input.id))) {
      return { status: 404, body: { error: "Policy not found" } };
    }
    return { status: 200, body: await listAuthPolicyVersions(db, input.id) };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function createPolicyConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const body = input.body ?? {};
    const status = parseStatus(body, BRAND_STATUSES, "draft");
    if (status === "archived") throw new Error("A new policy cannot be archived");
    const policy = await createAuthPolicy(db, {
      status,
      definition: parseAuthPolicyDefinition(body["definition"]),
      actor: input.actor,
      reason: text(body, "reason", { max: 500 }),
    });
    await audit("auth.authentication-policy.created", input.actor, { version: policy.version }, {
      authenticationPolicyId: policy.id,
    });
    return { status: 201, body: policy };
  } catch (err) {
    if (err instanceof Error && !isDatabaseError(err)) return { status: 400, body: errorBody(err) };
    return conflictAware(err);
  }
}

export async function updatePolicyConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid policy id" } };
  try {
    const body = input.body ?? {};
    const current = await getAuthPolicy(db, input.id);
    if (!current) return { status: 404, body: { error: "Policy not found" } };
    const status = parseStatus(body, BRAND_STATUSES, current.status);
    const definition = parseAuthPolicyDefinition(body["definition"] ?? current.definition);
    if (definition.name !== current.name) {
      return { status: 400, body: { error: "Policy names are immutable" } };
    }
    const policy = await updateAuthPolicy(db, input.id, expectedVersion(body), {
      status,
      definition,
      actor: input.actor,
      reason: text(body, "reason", { max: 500 }),
    });
    if (!policy) {
      return { status: 409, body: { error: "Policy changed; reload before saving again" } };
    }
    await audit("auth.authentication-policy.updated", input.actor, { version: policy.version }, {
      authenticationPolicyId: policy.id,
    });
    return { status: 200, body: policy };
  } catch (err) {
    if (err instanceof Error && !isDatabaseError(err)) return { status: 400, body: errorBody(err) };
    return conflictAware(err);
  }
}

export async function archivePolicyConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  if (!input.id || !UUID.test(input.id)) return { status: 400, body: { error: "Invalid policy id" } };
  try {
    const current = await getAuthPolicy(db, input.id);
    if (!current) return { status: 404, body: { error: "Policy not found" } };
    if (current.name === DEFAULT_AUTH_POLICY_NAME) {
      return { status: 403, body: { error: "The fallback policy cannot be archived" } };
    }
    const mappings = await listOAuthClientAuthConfigs(db);
    if (
      mappings.some(
        (mapping) =>
          mapping.authentication_policy_id === input.id && mapping.status === "active",
      )
    ) {
      return {
        status: 409,
        body: { error: "Disable or remap active OAuth clients before archiving this policy" },
      };
    }
    const updated = await updateAuthPolicy(db, input.id, current.version, {
      status: "archived",
      definition: current.definition,
      actor: input.actor,
      reason: "Archived from the administration console",
    });
    if (!updated) return { status: 409, body: { error: "Policy changed; reload and retry" } };
    await audit(
      "auth.authentication-policy.archived",
      input.actor,
      {},
      { authenticationPolicyId: input.id },
    );
    return { status: 200, body: { archived: true, id: input.id } };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function listClientAuthConfigurations(): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listOAuthClientAuthConfigs(db) };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function getClientAuthConfiguration(input: MappingInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  const clientId = input.clientId?.trim();
  if (!clientId) return { status: 400, body: { error: "clientId is required" } };
  try {
    const config = (await listOAuthClientAuthConfigs(db)).find(
      (candidate) => candidate.hydra_client_id === clientId,
    );
    return config
      ? { status: 200, body: config }
      : { status: 404, body: { error: "Client mapping not found" } };
  } catch (err) {
    return conflictAware(err);
  }
}

export async function listClientAuthConfigurationHistory(
  input: MappingInput,
): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  const clientId = input.clientId?.trim();
  if (!clientId) return { status: 400, body: { error: "clientId is required" } };
  try {
    const versions = await listOAuthClientAuthConfigVersions(db, clientId);
    return versions.length > 0
      ? { status: 200, body: versions }
      : { status: 404, body: { error: "Client mapping not found" } };
  } catch (err) {
    return conflictAware(err);
  }
}

async function hydraClientExists(clientId: string): Promise<boolean | null> {
  try {
    const response = await fetch(
      `${getHydraAdminUrl().replace(/\/+$/, "")}/admin/clients/${encodeURIComponent(clientId)}`,
    );
    if (response.status === 404) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

export async function putClientAuthConfiguration(input: MappingInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  const clientId = input.clientId?.trim();
  if (!clientId || clientId.length > 255) {
    return { status: 400, body: { error: "clientId is required" } };
  }
  try {
    const body = input.body ?? {};
    const brandId = text(body, "brandId", { required: true, max: 36 }) as string;
    const authPolicyId = text(body, "authPolicyId", { required: true, max: 36 }) as string;
    if (!UUID.test(brandId) || !UUID.test(authPolicyId)) {
      return { status: 400, body: { error: "brandId and authPolicyId must be valid UUIDs" } };
    }
    const existence = await hydraClientExists(clientId);
    if (existence === false) return { status: 404, body: { error: "Hydra client not found" } };
    if (existence === null) {
      return { status: 503, body: { error: "Hydra admin API is unavailable" } };
    }
    const status = parseStatus(body, CONFIG_STATUSES, "active");
    if (status === "archived") {
      return { status: 400, body: { error: "Use DELETE to archive a client mapping" } };
    }
    const consentMode = text(body, "consentMode", { required: true, max: 32 });
    if (!consentMode || !CONSENT_MODES.has(consentMode as ConsentMode)) {
      return { status: 400, body: { error: "consentMode is invalid" } };
    }
    const [brand, policy] = await Promise.all([
      getAuthBrand(db, brandId),
      getAuthPolicy(db, authPolicyId),
    ]);
    if (!brand || !policy) {
      return {
        status: 400,
        body: { error: "The selected brand or authentication policy does not exist" },
      };
    }
    if (status === "active" && (brand.status !== "active" || policy.status !== "active")) {
      return {
        status: 400,
        body: { error: "Active mappings require an active brand and authentication policy" },
      };
    }
    const isFirstParty = bool(body, "isFirstParty");
    if (consentMode === "skip-for-first-party" && !isFirstParty) {
      return {
        status: 400,
        body: { error: "skip-for-first-party requires isFirstParty to be enabled" },
      };
    }
    const config = await upsertOAuthClientAuthConfig(db, {
      hydraClientId: clientId,
      brandId,
      authPolicyId,
      status,
      isFirstParty,
      consentMode: consentMode as ConsentMode,
      actor: input.actor,
      reason: text(body, "reason", { max: 500 }),
    });
    await audit("auth.client-brand.changed", input.actor, { version: config.version }, {
      clientId,
      brandId,
      authenticationPolicyId: authPolicyId,
    });
    return { status: 200, body: config };
  } catch (err) {
    if (err instanceof Error && !isDatabaseError(err)) return { status: 400, body: errorBody(err) };
    return conflictAware(err);
  }
}

export async function deleteClientAuthConfiguration(input: MappingInput): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  const clientId = input.clientId?.trim();
  if (!clientId) return { status: 400, body: { error: "clientId is required" } };
  try {
    const archived = await archiveOAuthClientAuthConfig(db, clientId);
    if (!archived) return { status: 404, body: { error: "Client mapping not found" } };
    await audit("auth.client-brand.archived", input.actor, {}, { clientId });
    return { status: 200, body: { archived: true, clientId } };
  } catch (err) {
    return conflictAware(err);
  }
}
