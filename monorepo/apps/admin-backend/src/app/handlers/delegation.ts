import {
  appendDelegationAuditEvent,
  archiveDelegationActorPolicy,
  createDelegationResource,
  getAuthzPool,
  getDelegationResource,
  listDelegationActorPolicies,
  listDelegationAuditEvents,
  listDelegationGrants,
  listDelegationResources,
  listDelegationResourceVersions,
  revokeDelegationGrantByAdministrator,
  updateDelegationResource,
  upsertDelegationActorPolicy,
} from "@idnest/authz-store";
import {
  canonicalDelegationScopes,
  DELEGATION_EXCHANGE_SCOPE,
  DELEGATION_GRANT_SCOPE,
  delegationScopeSubset,
  isDelegationResourceKey,
  isDelegationStatus,
  type DelegationActorPolicyDefinition,
  type DelegationResourceDefinition,
  type DelegationStatus,
} from "@idnest/shared-types";
import { getAuthzDatabaseUrl, getHydraAdminUrl } from "../config";
import { errorBody, type HandlerResult } from "./types";

type JsonObject = Record<string, unknown>;

interface ResourceInput {
  id?: string;
  body?: JsonObject;
  actor?: string | null;
}

interface ActorPolicyInput extends ResourceInput {
  clientId?: string;
}

interface ActivityInput {
  resourceId?: string;
  limit?: number;
}

interface AdminGrantInput {
  grantId?: string;
  actor?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function database() {
  return getAuthzPool(getAuthzDatabaseUrl());
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(
  input: JsonObject,
  key: string,
  maximum: number,
  required = true,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${key} is too long`);
  return result;
}

function parseStatus(value: unknown, fallback: DelegationStatus): DelegationStatus {
  if (value === undefined) return fallback;
  if (!isDelegationStatus(value)) throw new Error("status is invalid");
  return value;
}

function parseAudience(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error("audience must be an absolute URI up to 512 characters");
  }
  try {
    const normalized = value.trim();
    const parsed = new URL(normalized);
    if (!parsed.protocol || parsed.username || parsed.password || parsed.hash) throw new Error();
    return normalized;
  } catch {
    throw new Error("audience must be an absolute URI without credentials or a fragment");
  }
}

function parseResourceDefinition(value: unknown): DelegationResourceDefinition {
  if (!isObject(value)) throw new Error("definition must be an object");
  const key = text(value, "key", 63) as string;
  if (!isDelegationResourceKey(key)) {
    throw new Error("definition.key must be a lowercase, hyphenated identifier");
  }
  const tokenTtlSeconds = value["tokenTtlSeconds"];
  if (
    typeof tokenTtlSeconds !== "number" ||
    !Number.isInteger(tokenTtlSeconds) ||
    tokenTtlSeconds < 30 ||
    tokenTtlSeconds > 300
  ) {
    throw new Error("definition.tokenTtlSeconds must be an integer from 30 to 300");
  }
  if (typeof value["authorizationContextRequired"] !== "boolean") {
    throw new Error("definition.authorizationContextRequired must be a boolean");
  }
  let allowedScopes: string[];
  try {
    allowedScopes = canonicalDelegationScopes(value["allowedScopes"]);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "allowedScopes is invalid");
  }
  return {
    key,
    displayName: text(value, "displayName", 100) as string,
    audience: parseAudience(value["audience"]),
    authorizerClientId: text(value, "authorizerClientId", 255) as string,
    allowedScopes,
    tokenTtlSeconds,
    authorizationContextRequired: value["authorizationContextRequired"],
  };
}

function parseActorPolicyDefinition(
  value: unknown,
  resourceScopes: string[],
  pathClientId?: string,
): DelegationActorPolicyDefinition {
  if (!isObject(value)) throw new Error("definition must be an object");
  const actorClientId = pathClientId
    ? pathClientId.trim()
    : text(value, "actorClientId", 255) as string;
  if (!actorClientId || actorClientId.length > 255) {
    throw new Error("actorClientId must be a non-empty string up to 255 characters");
  }
  let allowedScopes: string[];
  try {
    allowedScopes = canonicalDelegationScopes(value["allowedScopes"]);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "allowedScopes is invalid");
  }
  if (!delegationScopeSubset(allowedScopes, resourceScopes)) {
    throw new Error("Actor policy scopes must be a subset of the resource scopes");
  }
  return { actorClientId, allowedScopes };
}

function brokerAudience(): string {
  return process.env.DELEGATION_BROKER_AUDIENCE ?? "urn:idnest:delegation";
}

async function requireHydraServiceClient(clientId: string, requiredScope: string): Promise<void> {
  const response = await fetch(
    `${getHydraAdminUrl().replace(/\/+$/, "")}/admin/clients/${encodeURIComponent(clientId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`OAuth client ${clientId} was not found`);
  const client = (await response.json()) as JsonObject;
  const grantTypes = Array.isArray(client["grant_types"])
    ? client["grant_types"].filter((item): item is string => typeof item === "string")
    : [];
  const scopes = typeof client["scope"] === "string"
    ? client["scope"].split(/\s+/).filter(Boolean)
    : [];
  const audiences = Array.isArray(client["audience"])
    ? client["audience"].filter((item): item is string => typeof item === "string")
    : [];
  if (!grantTypes.includes("client_credentials")) {
    throw new Error(`OAuth client ${clientId} must allow client_credentials`);
  }
  if (!scopes.includes(requiredScope)) {
    throw new Error(`OAuth client ${clientId} must allow ${requiredScope}`);
  }
  if (!audiences.includes(brokerAudience())) {
    throw new Error(`OAuth client ${clientId} must allow the delegation broker audience`);
  }
}

function failure(error: unknown): HandlerResult {
  const code = isObject(error) && typeof error["code"] === "string" ? error["code"] : "";
  if (code === "23505") return { status: 409, body: { error: "A matching delegation configuration already exists" } };
  if (error instanceof Error) return { status: 400, body: errorBody(error) };
  return { status: 500, body: { error: "Delegation configuration failed" } };
}

function requireUuid(value: string | undefined, label: string): HandlerResult | null {
  return value && UUID.test(value)
    ? null
    : { status: 400, body: { error: `Invalid ${label}` } };
}

export async function listDelegationResourceConfigurations(): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listDelegationResources(db) };
  } catch (error) {
    return failure(error);
  }
}

export async function getDelegationResourceConfiguration(input: ResourceInput): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const resource = await getDelegationResource(db, input.id as string);
    return resource
      ? { status: 200, body: resource }
      : { status: 404, body: { error: "Delegation resource not found" } };
  } catch (error) {
    return failure(error);
  }
}

export async function listDelegationResourceHistory(input: ResourceInput): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listDelegationResourceVersions(db, input.id as string) };
  } catch (error) {
    return failure(error);
  }
}

export async function createDelegationResourceConfiguration(
  input: ResourceInput,
): Promise<HandlerResult> {
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const body = input.body ?? {};
    const status = parseStatus(body["status"], "active");
    if (status === "archived") throw new Error("A new delegation resource cannot be archived");
    const definition = parseResourceDefinition(body["definition"]);
    await requireHydraServiceClient(definition.authorizerClientId, DELEGATION_GRANT_SCOPE);
    const created = await createDelegationResource(db, {
      status,
      definition,
      actor: input.actor,
      reason: text(body, "reason", 500, false),
    });
    return { status: 201, body: created };
  } catch (error) {
    return failure(error);
  }
}

export async function updateDelegationResourceConfiguration(
  input: ResourceInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const body = input.body ?? {};
    const current = await getDelegationResource(db, input.id as string);
    if (!current) return { status: 404, body: { error: "Delegation resource not found" } };
    const expectedVersion = body["expectedVersion"];
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    const status = parseStatus(body["status"], current.status);
    const definition = parseResourceDefinition(body["definition"] ?? current.definition);
    await requireHydraServiceClient(definition.authorizerClientId, DELEGATION_GRANT_SCOPE);
    const updated = await updateDelegationResource(db, input.id as string, expectedVersion, {
      status,
      definition,
      actor: input.actor,
      reason: text(body, "reason", 500, false),
    });
    return updated
      ? { status: 200, body: updated }
      : { status: 409, body: { error: "Delegation resource changed; reload and retry" } };
  } catch (error) {
    return failure(error);
  }
}

export async function archiveDelegationResourceConfiguration(
  input: ResourceInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const current = await getDelegationResource(db, input.id as string);
    if (!current) return { status: 404, body: { error: "Delegation resource not found" } };
    const updated = await updateDelegationResource(db, current.id, current.version, {
      status: "archived",
      definition: current.definition,
      actor: input.actor,
      reason: "Archived from the administration console",
    });
    return updated
      ? { status: 200, body: { archived: true, id: current.id } }
      : { status: 409, body: { error: "Delegation resource changed; reload and retry" } };
  } catch (error) {
    return failure(error);
  }
}

export async function listDelegationActorPolicyConfigurations(
  input: ResourceInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return { status: 200, body: await listDelegationActorPolicies(db, input.id as string) };
  } catch (error) {
    return failure(error);
  }
}

export async function putDelegationActorPolicyConfiguration(
  input: ActorPolicyInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const body = input.body ?? {};
    const resource = await getDelegationResource(db, input.id as string);
    if (!resource) return { status: 404, body: { error: "Delegation resource not found" } };
    const status = parseStatus(body["status"], "active");
    if (status === "archived") throw new Error("Use DELETE to archive an actor policy");
    const definition = parseActorPolicyDefinition(
      body["definition"],
      resource.definition.allowedScopes,
      input.clientId,
    );
    await requireHydraServiceClient(definition.actorClientId, DELEGATION_EXCHANGE_SCOPE);
    const policy = await upsertDelegationActorPolicy(db, {
      resourceId: resource.id,
      status,
      definition,
      actor: input.actor,
      reason: text(body, "reason", 500, false),
    });
    return { status: 200, body: policy };
  } catch (error) {
    return failure(error);
  }
}

export async function archiveDelegationActorPolicyConfiguration(
  input: ActorPolicyInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.id, "delegation resource id");
  if (invalid) return invalid;
  if (!input.clientId) return { status: 400, body: { error: "Actor client id is required" } };
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const archived = await archiveDelegationActorPolicy(
      db,
      input.id as string,
      input.clientId,
      input.actor,
    );
    return archived
      ? { status: 200, body: { archived: true, clientId: input.clientId } }
      : { status: 404, body: { error: "Delegation actor policy not found" } };
  } catch (error) {
    return failure(error);
  }
}

export async function listDelegationGrantActivity(input: ActivityInput): Promise<HandlerResult> {
  if (input.resourceId && !UUID.test(input.resourceId)) {
    return { status: 400, body: { error: "Invalid delegation resource id" } };
  }
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return {
      status: 200,
      body: await listDelegationGrants(db, {
        resourceId: input.resourceId,
        limit: input.limit,
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function listDelegationAuditActivity(input: ActivityInput): Promise<HandlerResult> {
  if (input.resourceId && !UUID.test(input.resourceId)) {
    return { status: 400, body: { error: "Invalid delegation resource id" } };
  }
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    return {
      status: 200,
      body: await listDelegationAuditEvents(db, {
        resourceId: input.resourceId,
        limit: input.limit,
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeDelegationGrantAsAdministrator(
  input: AdminGrantInput,
): Promise<HandlerResult> {
  const invalid = requireUuid(input.grantId, "delegation grant id");
  if (invalid) return invalid;
  const db = database();
  if (!db) return { status: 503, body: { error: "AUTHZ_DATABASE_URL is not configured" } };
  try {
    const actor = input.actor ?? "unknown-administrator";
    const revoked = await revokeDelegationGrantByAdministrator(db, {
      grantId: input.grantId as string,
      revokedBy: actor,
    });
    if (!revoked) return { status: 404, body: { error: "Pending delegation grant not found" } };
    await appendDelegationAuditEvent(db, {
      grantId: input.grantId,
      eventType: "grant.admin-revoked",
      result: "success",
      metadata: { actor },
    });
    return { status: 200, body: { revoked: true, id: input.grantId } };
  } catch (error) {
    return failure(error);
  }
}
