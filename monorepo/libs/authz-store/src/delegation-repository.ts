import type {
  DelegationActorPolicyDefinition,
  DelegationResourceDefinition,
  DelegationStatus,
} from "@idnest/shared-types";
import type { Db } from "./db";

interface DelegationResourceRow {
  id: string;
  resource_key: string;
  display_name: string;
  audience: string;
  authorizer_client_id: string;
  allowed_scopes: string[];
  token_ttl_seconds: number;
  authorization_context_required: boolean;
  status: DelegationStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

interface DelegationActorPolicyRow {
  id: string;
  resource_id: string;
  actor_client_id: string;
  allowed_scopes: string[];
  status: DelegationStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DelegationResourceRecord {
  id: string;
  status: DelegationStatus;
  version: number;
  definition: DelegationResourceDefinition;
  created_at: string;
  updated_at: string;
}

export interface DelegationActorPolicyRecord {
  id: string;
  resource_id: string;
  status: DelegationStatus;
  version: number;
  definition: DelegationActorPolicyDefinition;
  created_at: string;
  updated_at: string;
}

export interface DelegationConfigurationVersion<T> {
  version: number;
  value: T;
  created_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface DelegationGrantRecord {
  id: string;
  resource_id: string;
  resource_key: string;
  audience: string;
  authorizer_client_id: string;
  actor_client_id: string;
  subject_id: string;
  scopes: string[];
  authorization_context: string | null;
  correlation_id: string | null;
  token_ttl_seconds: number;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

export interface DelegationAuditEventRecord {
  id: string;
  grant_id: string | null;
  resource_id: string | null;
  event_type: string;
  subject_id: string | null;
  authorizer_client_id: string | null;
  actor_client_id: string | null;
  scopes: string[];
  result: "success" | "denied" | "error";
  reason: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function resourceOf(row: DelegationResourceRow): DelegationResourceRecord {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    definition: {
      key: row.resource_key,
      displayName: row.display_name,
      audience: row.audience,
      authorizerClientId: row.authorizer_client_id,
      allowedScopes: row.allowed_scopes,
      tokenTtlSeconds: row.token_ttl_seconds,
      authorizationContextRequired: row.authorization_context_required,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function actorPolicyOf(row: DelegationActorPolicyRow): DelegationActorPolicyRecord {
  return {
    id: row.id,
    resource_id: row.resource_id,
    status: row.status,
    version: row.version,
    definition: {
      actorClientId: row.actor_client_id,
      allowedScopes: row.allowed_scopes,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const RESOURCE_SELECT = `
  SELECT id::text, resource_key, display_name, audience, authorizer_client_id,
         allowed_scopes, token_ttl_seconds, authorization_context_required,
         status, version, created_at::text, updated_at::text
  FROM delegation_resources
`;

export async function listDelegationResources(db: Db): Promise<DelegationResourceRecord[]> {
  const result = await db.query<DelegationResourceRow>(
    `${RESOURCE_SELECT} WHERE status <> 'archived' ORDER BY display_name, resource_key`,
  );
  return result.rows.map(resourceOf);
}

export async function getDelegationResource(
  db: Db,
  id: string,
): Promise<DelegationResourceRecord | null> {
  const result = await db.query<DelegationResourceRow>(
    `${RESOURCE_SELECT} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? resourceOf(result.rows[0]) : null;
}

export async function findActiveDelegationResource(
  db: Db,
  locator: string,
): Promise<DelegationResourceRecord | null> {
  const result = await db.query<DelegationResourceRow>(
    `${RESOURCE_SELECT}
     WHERE status = 'active' AND (resource_key = $1 OR audience = $1)
     LIMIT 1`,
    [locator],
  );
  return result.rows[0] ? resourceOf(result.rows[0]) : null;
}

export async function createDelegationResource(
  db: Db,
  input: {
    status: DelegationStatus;
    definition: DelegationResourceDefinition;
    actor?: string | null;
    reason?: string | null;
  },
): Promise<DelegationResourceRecord> {
  const definition = input.definition;
  const result = await db.query<DelegationResourceRow>(
    `WITH resource AS (
       INSERT INTO delegation_resources(
         resource_key, display_name, audience, authorizer_client_id, allowed_scopes,
         token_ttl_seconds, authorization_context_required, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *
     ), history AS (
       INSERT INTO delegation_resource_versions(
         resource_id, version, snapshot, created_by, reason
       )
       SELECT id, version, $9::jsonb, $10, $11 FROM resource
       RETURNING resource_id
     )
     SELECT r.id::text, r.resource_key, r.display_name, r.audience,
            r.authorizer_client_id, r.allowed_scopes, r.token_ttl_seconds,
            r.authorization_context_required, r.status, r.version,
            r.created_at::text, r.updated_at::text
     FROM resource r JOIN history h ON h.resource_id = r.id`,
    [
      definition.key,
      definition.displayName,
      definition.audience,
      definition.authorizerClientId,
      definition.allowedScopes,
      definition.tokenTtlSeconds,
      definition.authorizationContextRequired,
      input.status,
      JSON.stringify(definition),
      input.actor ?? null,
      input.reason ?? null,
    ],
  );
  if (!result.rows[0]) throw new Error("Delegation resource creation failed");
  return resourceOf(result.rows[0]);
}

export async function updateDelegationResource(
  db: Db,
  id: string,
  expectedVersion: number,
  input: {
    status: DelegationStatus;
    definition: DelegationResourceDefinition;
    actor?: string | null;
    reason?: string | null;
  },
): Promise<DelegationResourceRecord | null> {
  const definition = input.definition;
  const result = await db.query<DelegationResourceRow>(
    `WITH resource AS (
       UPDATE delegation_resources
       SET resource_key = $3, display_name = $4, audience = $5,
           authorizer_client_id = $6, allowed_scopes = $7,
           token_ttl_seconds = $8, authorization_context_required = $9,
           status = $10, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2
       RETURNING *
     ), history AS (
       INSERT INTO delegation_resource_versions(
         resource_id, version, snapshot, created_by, reason
       )
       SELECT id, version, $11::jsonb, $12, $13 FROM resource
       RETURNING resource_id
     )
     SELECT r.id::text, r.resource_key, r.display_name, r.audience,
            r.authorizer_client_id, r.allowed_scopes, r.token_ttl_seconds,
            r.authorization_context_required, r.status, r.version,
            r.created_at::text, r.updated_at::text
     FROM resource r JOIN history h ON h.resource_id = r.id`,
    [
      id,
      expectedVersion,
      definition.key,
      definition.displayName,
      definition.audience,
      definition.authorizerClientId,
      definition.allowedScopes,
      definition.tokenTtlSeconds,
      definition.authorizationContextRequired,
      input.status,
      JSON.stringify(definition),
      input.actor ?? null,
      input.reason ?? null,
    ],
  );
  return result.rows[0] ? resourceOf(result.rows[0]) : null;
}

export async function listDelegationResourceVersions(
  db: Db,
  resourceId: string,
): Promise<DelegationConfigurationVersion<DelegationResourceDefinition>[]> {
  const result = await db.query<DelegationConfigurationVersion<DelegationResourceDefinition>>(
    `SELECT version, snapshot AS value, created_by, reason, created_at::text
     FROM delegation_resource_versions
     WHERE resource_id = $1
     ORDER BY version DESC`,
    [resourceId],
  );
  return result.rows;
}

const ACTOR_POLICY_SELECT = `
  SELECT id::text, resource_id::text, actor_client_id, allowed_scopes,
         status, version, created_at::text, updated_at::text
  FROM delegation_actor_policies
`;

export async function listDelegationActorPolicies(
  db: Db,
  resourceId: string,
): Promise<DelegationActorPolicyRecord[]> {
  const result = await db.query<DelegationActorPolicyRow>(
    `${ACTOR_POLICY_SELECT}
     WHERE resource_id = $1 AND status <> 'archived'
     ORDER BY actor_client_id`,
    [resourceId],
  );
  return result.rows.map(actorPolicyOf);
}

export async function findActiveDelegationActorPolicy(
  db: Db,
  resourceId: string,
  actorClientId: string,
): Promise<DelegationActorPolicyRecord | null> {
  const result = await db.query<DelegationActorPolicyRow>(
    `${ACTOR_POLICY_SELECT}
     WHERE resource_id = $1 AND actor_client_id = $2 AND status = 'active'
     LIMIT 1`,
    [resourceId, actorClientId],
  );
  return result.rows[0] ? actorPolicyOf(result.rows[0]) : null;
}

export async function upsertDelegationActorPolicy(
  db: Db,
  input: {
    resourceId: string;
    status: DelegationStatus;
    definition: DelegationActorPolicyDefinition;
    actor?: string | null;
    reason?: string | null;
  },
): Promise<DelegationActorPolicyRecord> {
  const definition = input.definition;
  const result = await db.query<DelegationActorPolicyRow>(
    `WITH policy AS (
       INSERT INTO delegation_actor_policies(
         resource_id, actor_client_id, allowed_scopes, status
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (resource_id, actor_client_id) DO UPDATE
       SET allowed_scopes = EXCLUDED.allowed_scopes,
           status = EXCLUDED.status,
           version = delegation_actor_policies.version + 1,
           updated_at = now()
       RETURNING *
     ), history AS (
       INSERT INTO delegation_actor_policy_versions(
         actor_policy_id, version, snapshot, created_by, reason
       )
       SELECT id, version, $5::jsonb, $6, $7 FROM policy
       RETURNING actor_policy_id
     )
     SELECT p.id::text, p.resource_id::text, p.actor_client_id, p.allowed_scopes,
            p.status, p.version, p.created_at::text, p.updated_at::text
     FROM policy p JOIN history h ON h.actor_policy_id = p.id`,
    [
      input.resourceId,
      definition.actorClientId,
      definition.allowedScopes,
      input.status,
      JSON.stringify(definition),
      input.actor ?? null,
      input.reason ?? null,
    ],
  );
  if (!result.rows[0]) throw new Error("Delegation actor policy update failed");
  return actorPolicyOf(result.rows[0]);
}

export async function archiveDelegationActorPolicy(
  db: Db,
  resourceId: string,
  actorClientId: string,
  actor?: string | null,
): Promise<boolean> {
  const result = await db.query(
    `WITH policy AS (
       UPDATE delegation_actor_policies
       SET status = 'archived', version = version + 1, updated_at = now()
       WHERE resource_id = $1 AND actor_client_id = $2 AND status <> 'archived'
       RETURNING *
     )
     INSERT INTO delegation_actor_policy_versions(
       actor_policy_id, version, snapshot, created_by, reason
     )
     SELECT id, version,
       jsonb_build_object('actorClientId', actor_client_id, 'allowedScopes', allowed_scopes),
       $3, 'Actor policy archived'
     FROM policy`,
    [resourceId, actorClientId, actor ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createDelegationGrant(
  db: Db,
  input: {
    tokenHash: string;
    resourceId: string;
    resourceAudience: string;
    authorizerClientId: string;
    actorClientId: string;
    subjectId: string;
    scopes: string[];
    authorizationContext?: string | null;
    correlationId?: string | null;
    ttlSeconds: number;
    tokenTtlSeconds: number;
  },
): Promise<DelegationGrantRecord> {
  const result = await db.query<DelegationGrantRecord>(
    `INSERT INTO delegation_grants(
       token_hash, resource_id, resource_audience, authorizer_client_id, actor_client_id,
       subject_id, scopes, token_ttl_seconds, authorization_context, correlation_id, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))
     RETURNING id::text, resource_id::text, ''::text AS resource_key,
       resource_audience AS audience, authorizer_client_id, actor_client_id, subject_id,
       scopes, authorization_context, correlation_id, token_ttl_seconds,
       expires_at::text, consumed_at::text, revoked_at::text, revoked_by,
       created_at::text`,
    [
      input.tokenHash,
      input.resourceId,
      input.resourceAudience,
      input.authorizerClientId,
      input.actorClientId,
      input.subjectId,
      input.scopes,
      input.tokenTtlSeconds,
      input.authorizationContext ?? null,
      input.correlationId ?? null,
      input.ttlSeconds,
    ],
  );
  if (!result.rows[0]) throw new Error("Delegation grant creation failed");
  return result.rows[0];
}

export async function consumeDelegationGrant(
  db: Db,
  input: { tokenHash: string; actorClientId: string },
): Promise<DelegationGrantRecord | null> {
  const result = await db.query<DelegationGrantRecord>(
    `WITH consumed AS (
       UPDATE delegation_grants g
       SET consumed_at = now()
       FROM delegation_resources r, delegation_actor_policies p
       WHERE g.token_hash = $1
         AND g.actor_client_id = $2
         AND g.consumed_at IS NULL
         AND g.revoked_at IS NULL
         AND g.expires_at > now()
         AND r.id = g.resource_id
         AND r.status = 'active'
         AND r.audience = g.resource_audience
         AND r.authorizer_client_id = g.authorizer_client_id
         AND (NOT r.authorization_context_required OR g.authorization_context IS NOT NULL)
         AND p.resource_id = r.id
         AND p.actor_client_id = g.actor_client_id
         AND p.status = 'active'
         AND g.scopes <@ r.allowed_scopes
         AND g.scopes <@ p.allowed_scopes
       RETURNING g.*, r.resource_key,
         LEAST(g.token_ttl_seconds, r.token_ttl_seconds) AS effective_token_ttl_seconds
     )
     SELECT id::text, resource_id::text, resource_key, resource_audience AS audience,
       authorizer_client_id, actor_client_id, subject_id, scopes,
       authorization_context, correlation_id, effective_token_ttl_seconds AS token_ttl_seconds,
       expires_at::text, consumed_at::text, revoked_at::text, revoked_by,
       created_at::text
     FROM consumed`,
    [input.tokenHash, input.actorClientId],
  );
  return result.rows[0] ?? null;
}

export async function revokeDelegationGrant(
  db: Db,
  input: { grantId: string; authorizerClientId: string; revokedBy: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE delegation_grants
     SET revoked_at = now(), revoked_by = $3
     WHERE id = $1 AND authorizer_client_id = $2
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [input.grantId, input.authorizerClientId, input.revokedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeDelegationGrantByAdministrator(
  db: Db,
  input: { grantId: string; revokedBy: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE delegation_grants
     SET revoked_at = now(), revoked_by = $2
     WHERE id = $1
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [input.grantId, input.revokedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDelegationGrants(
  db: Db,
  options: { resourceId?: string; limit?: number } = {},
): Promise<DelegationGrantRecord[]> {
  const requestedLimit = Number.isInteger(options.limit) ? options.limit as number : 100;
  const limit = Math.max(1, Math.min(requestedLimit, 500));
  const result = await db.query<DelegationGrantRecord>(
    `SELECT g.id::text, g.resource_id::text, r.resource_key, g.resource_audience AS audience,
       g.authorizer_client_id, g.actor_client_id, g.subject_id, g.scopes,
       g.authorization_context, g.correlation_id, g.token_ttl_seconds,
       g.expires_at::text, g.consumed_at::text, g.revoked_at::text,
       g.revoked_by, g.created_at::text
     FROM delegation_grants g
     JOIN delegation_resources r ON r.id = g.resource_id
     WHERE ($1::uuid IS NULL OR g.resource_id = $1)
     ORDER BY g.created_at DESC
     LIMIT $2`,
    [options.resourceId ?? null, limit],
  );
  return result.rows;
}

export async function appendDelegationAuditEvent(
  db: Db,
  input: {
    grantId?: string | null;
    resourceId?: string | null;
    eventType: string;
    subjectId?: string | null;
    authorizerClientId?: string | null;
    actorClientId?: string | null;
    scopes?: string[];
    result: "success" | "denied" | "error";
    reason?: string | null;
    correlationId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<DelegationAuditEventRecord> {
  const result = await db.query<DelegationAuditEventRecord>(
    `INSERT INTO delegation_audit_events(
       grant_id, resource_id, event_type, subject_id, authorizer_client_id,
       actor_client_id, scopes, result, reason, correlation_id, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING id::text, grant_id::text, resource_id::text, event_type,
       subject_id, authorizer_client_id, actor_client_id, scopes, result,
       reason, correlation_id, metadata, created_at::text`,
    [
      input.grantId ?? null,
      input.resourceId ?? null,
      input.eventType,
      input.subjectId ?? null,
      input.authorizerClientId ?? null,
      input.actorClientId ?? null,
      input.scopes ?? [],
      input.result,
      input.reason ?? null,
      input.correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!result.rows[0]) throw new Error("Delegation audit event creation failed");
  return result.rows[0];
}

export async function listDelegationAuditEvents(
  db: Db,
  options: { resourceId?: string; limit?: number } = {},
): Promise<DelegationAuditEventRecord[]> {
  const requestedLimit = Number.isInteger(options.limit) ? options.limit as number : 100;
  const limit = Math.max(1, Math.min(requestedLimit, 500));
  const result = await db.query<DelegationAuditEventRecord>(
    `SELECT id::text, grant_id::text, resource_id::text, event_type,
       subject_id, authorizer_client_id, actor_client_id, scopes, result,
       reason, correlation_id, metadata, created_at::text
     FROM delegation_audit_events
     WHERE ($1::uuid IS NULL OR resource_id = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [options.resourceId ?? null, limit],
  );
  return result.rows;
}
