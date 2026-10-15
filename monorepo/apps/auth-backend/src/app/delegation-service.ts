import {
  appendDelegationAuditEvent,
  consumeDelegationGrant,
  createDelegationGrant,
  findActiveDelegationActorPolicy,
  findActiveDelegationResource,
  opaqueHash,
  revokeDelegationGrant,
  type Db,
  type DelegationActorPolicyRecord,
  type DelegationGrantRecord,
  type DelegationResourceRecord,
} from "@idnest/authz-store";
import {
  canonicalDelegationScopes,
  DELEGATION_EXCHANGE_SCOPE,
  DELEGATION_GRANT_SCOPE,
  delegationScopeSubset,
  type DelegationAuthorizationContext,
  type DelegationGrantRequest,
  type DelegationGrantResponse,
  type DelegationTokenExchangeResponse,
} from "@idnest/shared-types";
import { randomBytes } from "node:crypto";
import type { DelegationServicePrincipal } from "./delegation-hydra";
import type { DelegationTokenSigner } from "./delegation-token";

const MAXIMUM_AUTHORIZATION_CONTEXT_BYTES = 2_048;
const MAXIMUM_AUTHORIZATION_CONTEXT_DEPTH = 8;
const MAXIMUM_AUTHORIZATION_CONTEXT_KEYS = 64;
const MAXIMUM_AUTHORIZATION_CONTEXT_KEY_LENGTH = 128;
const MAXIMUM_AUTHORIZATION_CONTEXT_TYPE_LENGTH = 255;
const MAXIMUM_CONTEXT_PROFILE_VERSION = 2_147_483_647;
const UNSAFE_AUTHORIZATION_CONTEXT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const AUTHORIZATION_CONTEXT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export class DelegationProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DelegationStore {
  findResource(db: Db, locator: string): Promise<DelegationResourceRecord | null>;
  findActorPolicy(
    db: Db,
    resourceId: string,
    actorClientId: string,
  ): Promise<DelegationActorPolicyRecord | null>;
  createGrant(
    db: Db,
    input: Parameters<typeof createDelegationGrant>[1],
  ): Promise<DelegationGrantRecord>;
  consumeGrant(
    db: Db,
    input: Parameters<typeof consumeDelegationGrant>[1],
  ): Promise<DelegationGrantRecord | null>;
  revokeGrant(
    db: Db,
    input: Parameters<typeof revokeDelegationGrant>[1],
  ): Promise<boolean>;
  appendAudit(
    db: Db,
    input: Parameters<typeof appendDelegationAuditEvent>[1],
  ): Promise<unknown>;
}

const defaultStore: DelegationStore = {
  findResource: findActiveDelegationResource,
  findActorPolicy: findActiveDelegationActorPolicy,
  createGrant: createDelegationGrant,
  consumeGrant: consumeDelegationGrant,
  revokeGrant: revokeDelegationGrant,
  appendAudit: appendDelegationAuditEvent,
};

export interface DelegationServiceDependencies {
  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>;
  signer: DelegationTokenSigner;
  brokerAudience: string;
  grantTtlSeconds: number;
  store?: DelegationStore;
  createExchangeToken?: () => string;
  hashExchangeToken?: (token: string) => string;
}

function protocol(error: string, status: number, message: string): never {
  throw new DelegationProtocolError(error, status, message);
}

function requirePrincipal(
  principal: DelegationServicePrincipal | null,
  requiredScope: string,
  audience: string,
): DelegationServicePrincipal {
  if (!principal) protocol("invalid_token", 401, "A valid service access token is required");
  if (!principal.audiences.includes(audience)) {
    protocol("insufficient_scope", 403, "The service token has the wrong audience");
  }
  if (!principal.scopes.includes(requiredScope)) {
    protocol("insufficient_scope", 403, `The service token requires ${requiredScope}`);
  }
  return principal;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    protocol("invalid_request", 400, `${name} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

function optionalBoundedText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, name, maximum);
}

function invalidAuthorizationContext(): never {
  protocol(
    "invalid_request",
    400,
    "authorizationContext must be a bounded JSON object with a canonical type",
  );
}

function validateJsonValue(value: unknown, depth: number, keyCount: { value: number }): void {
  if (depth > MAXIMUM_AUTHORIZATION_CONTEXT_DEPTH) invalidAuthorizationContext();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidAuthorizationContext();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAXIMUM_AUTHORIZATION_CONTEXT_KEYS) invalidAuthorizationContext();
    for (const item of value) validateJsonValue(item, depth + 1, keyCount);
    return;
  }
  if (typeof value !== "object") invalidAuthorizationContext();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidAuthorizationContext();
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) invalidAuthorizationContext();
  keyCount.value += keys.length;
  if (keyCount.value > MAXIMUM_AUTHORIZATION_CONTEXT_KEYS) invalidAuthorizationContext();
  for (const key of keys) {
    if (
      !key ||
      key.length > MAXIMUM_AUTHORIZATION_CONTEXT_KEY_LENGTH ||
      UNSAFE_AUTHORIZATION_CONTEXT_KEYS.has(key)
    ) invalidAuthorizationContext();
    validateJsonValue((value as Record<string, unknown>)[key], depth + 1, keyCount);
  }
}

function authorizationContext(value: unknown): DelegationAuthorizationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidAuthorizationContext();
  }
  validateJsonValue(value, 0, { value: 0 });
  const type = (value as Record<string, unknown>)["type"];
  if (
    typeof type !== "string" ||
    !type.trim() ||
    type !== type.trim() ||
    type.length > MAXIMUM_AUTHORIZATION_CONTEXT_TYPE_LENGTH ||
    !AUTHORIZATION_CONTEXT_TYPE_PATTERN.test(type)
  ) invalidAuthorizationContext();
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalidAuthorizationContext();
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAXIMUM_AUTHORIZATION_CONTEXT_BYTES
  ) {
    invalidAuthorizationContext();
  }
  return JSON.parse(serialized) as DelegationAuthorizationContext;
}

export async function issueDelegationGrant(
  dependencies: DelegationServiceDependencies,
  principalInput: DelegationServicePrincipal | null,
  request: DelegationGrantRequest,
): Promise<DelegationGrantResponse> {
  const principal = requirePrincipal(
    principalInput,
    DELEGATION_GRANT_SCOPE,
    dependencies.brokerAudience,
  );
  const resourceLocator = boundedText(request.resource, "resource", 512);
  const subject = boundedText(request.subject, "subject", 255);
  const actorClientId = boundedText(request.actorClientId, "actorClientId", 255);
  const hasAuthorizationContext = request.authorizationContext !== undefined;
  const hasContextProfileVersion = request.contextProfileVersion !== undefined;
  if (hasAuthorizationContext !== hasContextProfileVersion) {
    protocol(
      "invalid_request",
      400,
      "authorizationContext and contextProfileVersion must be supplied together",
    );
  }
  const context = hasAuthorizationContext
    ? authorizationContext(request.authorizationContext)
    : undefined;
  const contextProfileVersion = request.contextProfileVersion;
  if (
    hasContextProfileVersion &&
    (
      !Number.isSafeInteger(contextProfileVersion) ||
      (contextProfileVersion as number) < 1 ||
      (contextProfileVersion as number) > MAXIMUM_CONTEXT_PROFILE_VERSION
    )
  ) {
    protocol("invalid_request", 400, "contextProfileVersion must be a positive integer");
  }
  const correlationId = optionalBoundedText(request.correlationId, "correlationId", 255);
  let scopes: string[];
  try {
    scopes = canonicalDelegationScopes(request.scope);
  } catch {
    protocol("invalid_scope", 400, "One or more requested scopes are invalid");
  }

  const store = dependencies.store ?? defaultStore;
  const exchangeToken = (dependencies.createExchangeToken ??
    (() => randomBytes(32).toString("base64url")))();
  const tokenHash = (dependencies.hashExchangeToken ?? opaqueHash)(exchangeToken);
  const grantTtlSeconds = Math.max(1, Math.min(dependencies.grantTtlSeconds, 300));

  return dependencies.transaction(async (db) => {
    const resource = await store.findResource(db, resourceLocator);
    if (!resource) protocol("invalid_target", 400, "The requested resource is not active");
    if (resource.definition.authorizerClientId !== principal.clientId) {
      protocol("access_denied", 403, "This client cannot authorize the requested resource");
    }
    if (!delegationScopeSubset(scopes, resource.definition.allowedScopes)) {
      protocol("invalid_scope", 400, "Requested scopes are not enabled for this resource");
    }
    if (resource.definition.authorizationContextRequired && !context) {
      protocol(
        "invalid_request",
        400,
        "authorizationContext and contextProfileVersion are required for this resource",
      );
    }
    const policy = await store.findActorPolicy(db, resource.id, actorClientId);
    if (!policy || !delegationScopeSubset(scopes, policy.definition.allowedScopes)) {
      protocol("access_denied", 403, "The actor is not allowed to receive the requested scopes");
    }

    const grant = await store.createGrant(db, {
      tokenHash,
      resourceId: resource.id,
      resourceAudience: resource.definition.audience,
      authorizerClientId: principal.clientId,
      actorClientId,
      subjectId: subject,
      scopes,
      authorizationContext: context,
      contextProfileVersion,
      correlationId,
      ttlSeconds: grantTtlSeconds,
      tokenTtlSeconds: resource.definition.tokenTtlSeconds,
    });
    await store.appendAudit(db, {
      grantId: grant.id,
      resourceId: resource.id,
      eventType: "grant.issued",
      subjectId: subject,
      authorizerClientId: principal.clientId,
      actorClientId,
      scopes,
      result: "success",
      correlationId,
    });
    return {
      grantId: grant.id,
      exchangeToken,
      expiresIn: grantTtlSeconds,
    };
  });
}

export async function exchangeDelegationGrant(
  dependencies: DelegationServiceDependencies,
  principalInput: DelegationServicePrincipal | null,
  input: { subjectToken: string; resource?: string; scope?: string },
): Promise<DelegationTokenExchangeResponse> {
  const principal = requirePrincipal(
    principalInput,
    DELEGATION_EXCHANGE_SCOPE,
    dependencies.brokerAudience,
  );
  const subjectToken = boundedText(input.subjectToken, "subject_token", 1024);
  const requestedResource = optionalBoundedText(input.resource, "resource", 512);
  const store = dependencies.store ?? defaultStore;
  const tokenHash = (dependencies.hashExchangeToken ?? opaqueHash)(subjectToken);

  return dependencies.transaction(async (db) => {
    const grant = await store.consumeGrant(db, {
      tokenHash,
      actorClientId: principal.clientId,
    });
    if (!grant) protocol("invalid_grant", 400, "The delegation grant is invalid or expired");
    if (requestedResource && requestedResource !== grant.audience) {
      protocol("invalid_target", 400, "The requested resource does not match the grant");
    }

    let scopes = grant.scopes;
    if (input.scope) {
      try {
        scopes = canonicalDelegationScopes(input.scope);
      } catch {
        protocol("invalid_scope", 400, "One or more requested scopes are invalid");
      }
      if (!delegationScopeSubset(scopes, grant.scopes)) {
        protocol("invalid_scope", 400, "Token exchange can only reduce the granted scopes");
      }
    }

    const accessToken = await dependencies.signer.sign({
      subject: grant.subject_id,
      audience: grant.audience,
      actorClientId: principal.clientId,
      authorizerClientId: grant.authorizer_client_id,
      scopes,
      grantId: grant.id,
      authorizationContext: grant.authorization_context,
      contextProfileVersion: grant.context_profile_version,
      ttlSeconds: grant.token_ttl_seconds,
    });
    await store.appendAudit(db, {
      grantId: grant.id,
      resourceId: grant.resource_id,
      eventType: "grant.exchanged",
      subjectId: grant.subject_id,
      authorizerClientId: grant.authorizer_client_id,
      actorClientId: principal.clientId,
      scopes,
      result: "success",
      correlationId: grant.correlation_id,
    });
    return {
      access_token: accessToken,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: grant.token_ttl_seconds,
      scope: scopes.join(" "),
    };
  });
}

export async function revokePendingDelegationGrant(
  dependencies: DelegationServiceDependencies,
  principalInput: DelegationServicePrincipal | null,
  grantId: string,
): Promise<void> {
  const principal = requirePrincipal(
    principalInput,
    DELEGATION_GRANT_SCOPE,
    dependencies.brokerAudience,
  );
  boundedText(grantId, "grantId", 255);
  const store = dependencies.store ?? defaultStore;
  await dependencies.transaction(async (db) => {
    const revoked = await store.revokeGrant(db, {
      grantId,
      authorizerClientId: principal.clientId,
      revokedBy: principal.clientId,
    });
    if (!revoked) protocol("invalid_grant", 404, "The pending delegation grant was not found");
    await store.appendAudit(db, {
      grantId,
      eventType: "grant.revoked",
      authorizerClientId: principal.clientId,
      result: "success",
    });
  });
}
