import type {
  AuthBrandDefinition,
  AuthPolicyDefinition,
  OAuthClientAuthConfigSnapshot,
} from "@idnest/shared-types";
import type { Db } from "./db";

export type AuthTransactionStatus =
  | "created"
  | "awaiting-authentication"
  | "completing"
  | "authenticated"
  | "hydra-accepted"
  | "rejected"
  | "expired"
  | "failed";

export interface AuthTransactionRecord {
  id: string;
  token_hash: string;
  hydra_login_challenge_hash: string;
  hydra_login_challenge_ciphertext: string;
  hydra_client_id: string;
  brand_id: string;
  brand_version: number;
  authentication_policy_id: string;
  authentication_policy_version: number;
  mapping_version: number;
  client_config_snapshot: OAuthClientAuthConfigSnapshot;
  brand_snapshot: AuthBrandDefinition;
  policy_snapshot: AuthPolicyDefinition;
  kratos_flow_id?: string | null;
  kratos_flow_issued_at?: string | null;
  subject?: string | null;
  status: AuthTransactionStatus;
  created_at: string;
  expires_at: string;
  completion_started_at?: string | null;
  completed_at?: string | null;
  failure_code?: string | null;
  redirect_to?: string | null;
}

export interface AuthConsentTransactionRecord {
  id: string;
  token_hash: string;
  hydra_consent_challenge_hash: string;
  hydra_consent_challenge_ciphertext: string;
  hydra_login_challenge_hash?: string | null;
  hydra_client_id: string;
  subject: string;
  client_config_snapshot: OAuthClientAuthConfigSnapshot;
  brand_snapshot: AuthBrandDefinition;
  policy_snapshot: AuthPolicyDefinition;
  requested_scopes: string[];
  requested_audiences: string[];
  status: "created" | "completing" | "accepted" | "rejected" | "expired" | "failed";
  created_at: string;
  expires_at: string;
  completion_started_at?: string | null;
  completed_at?: string | null;
  failure_code?: string | null;
  redirect_to?: string | null;
}

const AUTH_TRANSACTION_COLUMNS = `
  id::text, token_hash, hydra_login_challenge_hash, hydra_login_challenge_ciphertext,
  hydra_client_id, brand_id::text, brand_version, authentication_policy_id::text,
  authentication_policy_version, mapping_version, client_config_snapshot, brand_snapshot,
  policy_snapshot, kratos_flow_id, kratos_flow_issued_at::text, subject, status,
  created_at::text, expires_at::text, completion_started_at::text, completed_at::text,
  failure_code, redirect_to
`;

export type AuthFlowBindingReason = "initial" | "account-link-recovery" | "aal2-step-up";

export async function createAuthTransaction(
  db: Db,
  input: {
    tokenHash: string;
    challengeHash: string;
    challengeCiphertext: string;
    hydraClientId: string;
    brandId: string;
    brandVersion: number;
    authPolicyId: string;
    authPolicyVersion: number;
    mappingVersion: number;
    clientConfigSnapshot: OAuthClientAuthConfigSnapshot;
    brandSnapshot: AuthBrandDefinition;
    policySnapshot: AuthPolicyDefinition;
    ttlSeconds: number;
  },
): Promise<AuthTransactionRecord> {
  const res = await db.query<AuthTransactionRecord>(
    `INSERT INTO auth_transactions(
       token_hash, hydra_login_challenge_hash, hydra_login_challenge_ciphertext,
       hydra_client_id, brand_id, brand_version, authentication_policy_id,
       authentication_policy_version, mapping_version, client_config_snapshot,
       brand_snapshot, policy_snapshot, status, expires_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
       'created', now() + ($13 * interval '1 second')
     )
     ON CONFLICT (hydra_login_challenge_hash) DO UPDATE
     SET token_hash = EXCLUDED.token_hash,
         hydra_login_challenge_ciphertext = EXCLUDED.hydra_login_challenge_ciphertext,
         hydra_client_id = EXCLUDED.hydra_client_id,
         brand_id = EXCLUDED.brand_id,
         brand_version = EXCLUDED.brand_version,
         authentication_policy_id = EXCLUDED.authentication_policy_id,
         authentication_policy_version = EXCLUDED.authentication_policy_version,
         mapping_version = EXCLUDED.mapping_version,
         client_config_snapshot = EXCLUDED.client_config_snapshot,
         brand_snapshot = EXCLUDED.brand_snapshot,
         policy_snapshot = EXCLUDED.policy_snapshot,
         kratos_flow_id = NULL,
         kratos_flow_issued_at = NULL,
         subject = NULL,
         status = 'created',
         created_at = now(),
         expires_at = EXCLUDED.expires_at,
         completion_started_at = NULL,
         completed_at = NULL,
         failure_code = NULL,
         redirect_to = NULL
     WHERE auth_transactions.status IN ('created', 'awaiting-authentication', 'failed', 'expired')
     RETURNING ${AUTH_TRANSACTION_COLUMNS}`,
    [
      input.tokenHash,
      input.challengeHash,
      input.challengeCiphertext,
      input.hydraClientId,
      input.brandId,
      input.brandVersion,
      input.authPolicyId,
      input.authPolicyVersion,
      input.mappingVersion,
      JSON.stringify(input.clientConfigSnapshot),
      JSON.stringify(input.brandSnapshot),
      JSON.stringify(input.policySnapshot),
      input.ttlSeconds,
    ],
  );
  if (!res.rows[0]) throw new Error("This Hydra login challenge has already been completed");
  return res.rows[0];
}

export async function findAuthTransactionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `SELECT ${AUTH_TRANSACTION_COLUMNS}
     FROM auth_transactions
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

export async function findAuthTransactionByChallengeHash(
  db: Db,
  challengeHash: string,
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `SELECT ${AUTH_TRANSACTION_COLUMNS}
     FROM auth_transactions
     WHERE hydra_login_challenge_hash = $1
     LIMIT 1`,
    [challengeHash],
  );
  return res.rows[0] ?? null;
}

export async function findAuthTransactionById(
  db: Db,
  id: string,
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `SELECT ${AUTH_TRANSACTION_COLUMNS}
     FROM auth_transactions
     WHERE id::text = $1
     LIMIT 1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function findAuthTransactionByKratosFlowId(
  db: Db,
  flowId: string,
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `SELECT ${AUTH_TRANSACTION_COLUMNS}
     FROM auth_transactions
     WHERE kratos_flow_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [flowId],
  );
  return res.rows[0] ?? null;
}

export async function bindAuthTransactionFlow(
  db: Db,
  tokenHash: string,
  flowId: string,
  options: { reason: AuthFlowBindingReason; issuedAt: string },
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `UPDATE auth_transactions
     SET kratos_flow_id = $2,
         kratos_flow_issued_at = $3::timestamptz,
         status = 'awaiting-authentication'
     WHERE token_hash = $1
       AND expires_at > now()
       AND status IN ('created', 'awaiting-authentication')
       AND (
         kratos_flow_id IS NULL
         OR kratos_flow_id = $2
         OR (
           $4::text = 'account-link-recovery'
           AND status = 'awaiting-authentication'
           AND subject IS NULL
           AND kratos_flow_issued_at IS NOT NULL
           AND $3::timestamptz > kratos_flow_issued_at
         )
         OR (
           $4::text = 'aal2-step-up'
           AND status = 'awaiting-authentication'
           AND $3::timestamptz >= COALESCE(kratos_flow_issued_at, '-infinity'::timestamptz)
         )
       )
     RETURNING ${AUTH_TRANSACTION_COLUMNS}`,
    [tokenHash, flowId, options.issuedAt, options.reason],
  );
  return res.rows[0] ?? null;
}

export async function claimAuthTransactionCompletion(
  db: Db,
  tokenHash: string,
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `UPDATE auth_transactions
     SET status = 'completing', completion_started_at = now()
     WHERE token_hash = $1
       AND expires_at > now()
       AND status IN ('created', 'awaiting-authentication', 'authenticated')
     RETURNING ${AUTH_TRANSACTION_COLUMNS}`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

/**
 * After primary (AAL1) auth, release a claimed transaction so the browser can
 * complete an AAL2 step-up against the same opaque transaction token.
 * Clears `kratos_flow_id` so the next login flow can bind.
 */
export async function releaseAuthTransactionForStepUp(
  db: Db,
  input: { id: string; subject: string },
): Promise<AuthTransactionRecord | null> {
  const res = await db.query<AuthTransactionRecord>(
    `UPDATE auth_transactions
     SET status = 'awaiting-authentication',
         subject = $2,
         kratos_flow_id = NULL,
         kratos_flow_issued_at = NULL,
         completion_started_at = NULL,
         failure_code = NULL,
         redirect_to = NULL,
         completed_at = NULL
     WHERE id = $1
       AND expires_at > now()
       AND status = 'completing'
     RETURNING ${AUTH_TRANSACTION_COLUMNS}`,
    [input.id, input.subject],
  );
  return res.rows[0] ?? null;
}

export async function setAuthTransactionResult(
  db: Db,
  input: {
    id: string;
    status: "authenticated" | "hydra-accepted" | "rejected" | "failed" | "expired";
    subject?: string | null;
    failureCode?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE auth_transactions
     SET status = $2,
         subject = COALESCE($3, subject),
         failure_code = $4,
         redirect_to = NULL,
         completed_at = CASE
           WHEN $2 IN ('hydra-accepted', 'rejected', 'expired') THEN now()
           ELSE completed_at
         END
     WHERE id = $1`,
    [
      input.id,
      input.status,
      input.subject ?? null,
      input.failureCode ?? null,
    ],
  );
}

const CONSENT_TRANSACTION_COLUMNS = `
  id::text, token_hash, hydra_consent_challenge_hash, hydra_consent_challenge_ciphertext,
  hydra_login_challenge_hash, hydra_client_id, subject, client_config_snapshot,
  brand_snapshot, policy_snapshot, requested_scopes, requested_audiences, status,
  created_at::text, expires_at::text, completion_started_at::text, completed_at::text,
  failure_code, redirect_to
`;

export async function createAuthConsentTransaction(
  db: Db,
  input: {
    tokenHash: string;
    challengeHash: string;
    challengeCiphertext: string;
    loginChallengeHash?: string | null;
    hydraClientId: string;
    subject: string;
    clientConfigSnapshot: OAuthClientAuthConfigSnapshot;
    brandSnapshot: AuthBrandDefinition;
    policySnapshot: AuthPolicyDefinition;
    requestedScopes: string[];
    requestedAudiences: string[];
    ttlSeconds: number;
  },
): Promise<AuthConsentTransactionRecord> {
  const res = await db.query<AuthConsentTransactionRecord>(
    `INSERT INTO auth_consent_transactions(
       token_hash, hydra_consent_challenge_hash, hydra_consent_challenge_ciphertext,
       hydra_login_challenge_hash, hydra_client_id, subject, client_config_snapshot,
       brand_snapshot, policy_snapshot, requested_scopes, requested_audiences, expires_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11,
       now() + ($12 * interval '1 second')
     )
     ON CONFLICT (hydra_consent_challenge_hash) DO UPDATE
     SET token_hash = EXCLUDED.token_hash,
         status = 'created',
         created_at = now(),
         expires_at = EXCLUDED.expires_at,
         completion_started_at = NULL,
         completed_at = NULL,
         failure_code = NULL,
         redirect_to = NULL
     WHERE auth_consent_transactions.status IN ('created', 'failed', 'expired')
     RETURNING ${CONSENT_TRANSACTION_COLUMNS}`,
    [
      input.tokenHash,
      input.challengeHash,
      input.challengeCiphertext,
      input.loginChallengeHash ?? null,
      input.hydraClientId,
      input.subject,
      JSON.stringify(input.clientConfigSnapshot),
      JSON.stringify(input.brandSnapshot),
      JSON.stringify(input.policySnapshot),
      input.requestedScopes,
      input.requestedAudiences,
      input.ttlSeconds,
    ],
  );
  if (!res.rows[0]) throw new Error("This Hydra consent challenge has already been completed");
  return res.rows[0];
}

export async function findAuthConsentTransactionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<AuthConsentTransactionRecord | null> {
  const res = await db.query<AuthConsentTransactionRecord>(
    `SELECT ${CONSENT_TRANSACTION_COLUMNS}
     FROM auth_consent_transactions
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

export async function claimAuthConsentTransaction(
  db: Db,
  tokenHash: string,
): Promise<AuthConsentTransactionRecord | null> {
  const res = await db.query<AuthConsentTransactionRecord>(
    `UPDATE auth_consent_transactions
     SET status = 'completing', completion_started_at = now()
     WHERE token_hash = $1 AND expires_at > now() AND status = 'created'
     RETURNING ${CONSENT_TRANSACTION_COLUMNS}`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

export async function setAuthConsentTransactionResult(
  db: Db,
  input: {
    id: string;
    status: "accepted" | "rejected" | "failed" | "expired";
    failureCode?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE auth_consent_transactions
     SET status = $2, failure_code = $3, redirect_to = NULL,
         completed_at = CASE WHEN $2 IN ('accepted', 'rejected', 'expired') THEN now() ELSE completed_at END
     WHERE id = $1`,
    [input.id, input.status, input.failureCode ?? null],
  );
}

export async function expireAuthTransactions(db: Db): Promise<number> {
  const auth = await db.query(
    `UPDATE auth_transactions SET status = 'expired', completed_at = now()
     WHERE expires_at <= now()
       AND status IN ('created', 'awaiting-authentication', 'authenticated', 'failed')`,
  );
  const consent = await db.query(
    `UPDATE auth_consent_transactions SET status = 'expired', completed_at = now()
     WHERE expires_at <= now() AND status IN ('created', 'failed')`,
  );
  return (auth.rowCount ?? 0) + (consent.rowCount ?? 0);
}

export async function deleteExpiredAuthTransactions(db: Db, retentionDays = 7): Promise<number> {
  const consent = await db.query(
    `DELETE FROM auth_consent_transactions
     WHERE expires_at < now() - ($1 * interval '1 day')`,
    [retentionDays],
  );
  const auth = await db.query(
    `DELETE FROM auth_transactions
     WHERE expires_at < now() - ($1 * interval '1 day')`,
    [retentionDays],
  );
  return (auth.rowCount ?? 0) + (consent.rowCount ?? 0);
}

export async function recordAuthAuditEvent(
  db: Db,
  input: {
    eventType: string;
    hydraClientId?: string | null;
    brandId?: string | null;
    authenticationPolicyId?: string | null;
    identityId?: string | null;
    result?: string | null;
    failureCode?: string | null;
    correlationId?: string | null;
    ipHash?: string | null;
    userAgentCategory?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO auth_audit_events(
       event_type, hydra_client_id, brand_id, authentication_policy_id, identity_id,
       result, failure_code, correlation_id, ip_hash, user_agent_category, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      input.eventType,
      input.hydraClientId ?? null,
      input.brandId ?? null,
      input.authenticationPolicyId ?? null,
      input.identityId ?? null,
      input.result ?? null,
      input.failureCode ?? null,
      input.correlationId ?? null,
      input.ipHash ?? null,
      input.userAgentCategory ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
