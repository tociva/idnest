import type { Db } from "./db";

export const AUTHZ_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Rename login_policy* → authentication_policy* for existing databases.
-- Uses search_path-aware to_regclass() because Authz tables live in a
-- dedicated schema (e.g. authz), not necessarily public.
-- Fresh installs skip this block because the old names never existed.
DO $$
DECLARE
  oauth_still_on_login_policy boolean := false;
BEGIN
  oauth_still_on_login_policy :=
    to_regclass('oauth_client_auth_configs') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = to_regclass('oauth_client_auth_configs')
        AND attname = 'login_policy_id'
        AND NOT attisdropped
    );

  -- Recover from a prior failed migrate that created empty/seeded
  -- authentication_* shells while live data remained on login_*.
  IF to_regclass('login_policies') IS NOT NULL
     AND to_regclass('authentication_policies') IS NOT NULL
     AND oauth_still_on_login_policy THEN
    DROP TABLE IF EXISTS authentication_policy_versions;
    DROP TABLE authentication_policies;
  END IF;

  IF to_regclass('login_policies') IS NOT NULL
     AND to_regclass('authentication_policies') IS NULL THEN
    ALTER TABLE login_policies RENAME TO authentication_policies;
  END IF;

  IF to_regclass('login_policy_versions') IS NOT NULL
     AND to_regclass('authentication_policy_versions') IS NULL THEN
    ALTER TABLE login_policy_versions RENAME TO authentication_policy_versions;
  END IF;

  IF to_regclass('authentication_policy_versions') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid = to_regclass('authentication_policy_versions')
         AND attname = 'login_policy_id'
         AND NOT attisdropped
     ) THEN
    ALTER TABLE authentication_policy_versions
      RENAME COLUMN login_policy_id TO authentication_policy_id;
  END IF;

  IF oauth_still_on_login_policy THEN
    ALTER TABLE oauth_client_auth_configs
      RENAME COLUMN login_policy_id TO authentication_policy_id;
  END IF;

  IF to_regclass('auth_transactions') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid = to_regclass('auth_transactions')
         AND attname = 'login_policy_id'
         AND NOT attisdropped
     ) THEN
    ALTER TABLE auth_transactions
      RENAME COLUMN login_policy_id TO authentication_policy_id;
  END IF;

  IF to_regclass('auth_transactions') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid = to_regclass('auth_transactions')
         AND attname = 'login_policy_version'
         AND NOT attisdropped
     ) THEN
    ALTER TABLE auth_transactions
      RENAME COLUMN login_policy_version TO authentication_policy_version;
  END IF;

  IF to_regclass('auth_audit_events') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid = to_regclass('auth_audit_events')
         AND attname = 'login_policy_id'
         AND NOT attisdropped
     ) THEN
    ALTER TABLE auth_audit_events
      RENAME COLUMN login_policy_id TO authentication_policy_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS client_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id text NOT NULL,
  client_id text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  granted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS client_access_grants_active_unique
  ON client_access_grants(identity_id, client_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS client_access_grants_identity_idx
  ON client_access_grants(identity_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS client_access_grants_client_idx
  ON client_access_grants(client_id)
  WHERE revoked_at IS NULL;

UPDATE client_access_grants
SET role = 'system-admin'
WHERE role = 'admin'
  AND client_id = 'idnest-admin-client'
  AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  identity_id text NOT NULL,
  client_id text NOT NULL,
  role text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  request_ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS admin_sessions_token_active_idx
  ON admin_sessions(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_sessions_identity_client_active_idx
  ON admin_sessions(identity_id, client_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_oauth_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_to text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  request_ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS admin_oauth_transactions_active_idx
  ON admin_oauth_transactions(state_hash)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS consent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id text NOT NULL,
  client_id text NOT NULL,
  scope_hash text NOT NULL,
  audience_hash text NOT NULL,
  trust_tier text NOT NULL,
  consent_version integer NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS consent_approvals_active_unique
  ON consent_approvals(identity_id, client_id, scope_hash, audience_hash, trust_tier, consent_version)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS consent_approvals_identity_client_idx
  ON consent_approvals(identity_id, client_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS consent_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id text,
  client_id text,
  event_type text NOT NULL,
  reason text,
  scopes text[] NOT NULL DEFAULT '{}',
  audiences text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_audit_events_identity_idx
  ON consent_audit_events(identity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS consent_audit_events_client_idx
  ON consent_audit_events(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  current_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_brand_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES auth_brands(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, version)
);

CREATE TABLE IF NOT EXISTS authentication_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  current_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authentication_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authentication_policy_id uuid NOT NULL REFERENCES authentication_policies(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (authentication_policy_id, version)
);

CREATE TABLE IF NOT EXISTS oauth_client_auth_configs (
  hydra_client_id text PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES auth_brands(id),
  authentication_policy_id uuid NOT NULL REFERENCES authentication_policies(id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  is_first_party boolean NOT NULL DEFAULT false,
  consent_mode text NOT NULL DEFAULT 'follow-hydra'
    CHECK (consent_mode IN ('always-show', 'skip-for-first-party', 'follow-hydra')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_client_auth_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hydra_client_id text NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_by text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hydra_client_id, version)
);

CREATE TABLE IF NOT EXISTS auth_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  hydra_login_challenge_hash text NOT NULL UNIQUE,
  hydra_login_challenge_ciphertext text NOT NULL,
  hydra_client_id text NOT NULL,
  brand_id uuid NOT NULL REFERENCES auth_brands(id),
  brand_version integer NOT NULL,
  authentication_policy_id uuid NOT NULL REFERENCES authentication_policies(id),
  authentication_policy_version integer NOT NULL,
  mapping_version integer NOT NULL,
  client_config_snapshot jsonb NOT NULL,
  brand_snapshot jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL,
  kratos_flow_id text,
  subject text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created', 'awaiting-authentication', 'completing', 'authenticated',
      'hydra-accepted', 'rejected', 'expired', 'failed'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completion_started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  redirect_to text
);

CREATE INDEX IF NOT EXISTS auth_transactions_expiry_idx
  ON auth_transactions(expires_at)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_transactions_client_created_idx
  ON auth_transactions(hydra_client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_transactions_kratos_flow_idx
  ON auth_transactions(kratos_flow_id)
  WHERE kratos_flow_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_consent_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  hydra_consent_challenge_hash text NOT NULL UNIQUE,
  hydra_consent_challenge_ciphertext text NOT NULL,
  hydra_login_challenge_hash text,
  hydra_client_id text NOT NULL,
  subject text NOT NULL,
  client_config_snapshot jsonb NOT NULL,
  brand_snapshot jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL,
  requested_scopes text[] NOT NULL DEFAULT '{}',
  requested_audiences text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'completing', 'accepted', 'rejected', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completion_started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  redirect_to text
);

CREATE INDEX IF NOT EXISTS auth_consent_transactions_expiry_idx
  ON auth_consent_transactions(expires_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  hydra_client_id text,
  brand_id uuid,
  authentication_policy_id uuid,
  identity_id text,
  result text,
  failure_code text,
  correlation_id text,
  ip_hash text,
  user_agent_category text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_audit_events_client_created_idx
  ON auth_audit_events(hydra_client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_audit_events_identity_created_idx
  ON auth_audit_events(identity_id, created_at DESC);

INSERT INTO auth_brands(key, status)
VALUES
  ('idnest-default', 'active'),
  ('idnest-admin', 'active')
ON CONFLICT (key) DO NOTHING;

INSERT INTO auth_brand_versions(brand_id, version, definition, created_by, reason)
SELECT b.id, 1, seed.definition, 'system', 'Initial trusted brand seed'
FROM (
  VALUES
    ('idnest-default', '{
      "key":"idnest-default","displayName":"Idnest","legalName":"Tociva Technologies",
      "productName":"Idnest","primaryColor":"#2563eb","secondaryColor":"#1d4ed8",
      "surfaceColor":"#ffffff","textColor":"#1f2937","mutedTextColor":"#6b7280",
      "errorColor":"#b91c1c","borderRadius":"16px","fontFamily":"system",
      "loginHeading":"Sign in to continue","loginDescription":"Use your Idnest identity to continue.",
      "registrationHeading":"Create your account","recoveryHeading":"Recover your account",
      "consentHeading":"Review access","supportUrl":"https://idnest.cloud/support",
      "privacyUrl":"/privacy","termsUrl":"/terms","copyrightText":"Tociva Technologies",
      "defaultLocale":"en"
    }'::jsonb),
    ('idnest-admin', '{
      "key":"idnest-admin","displayName":"Idnest Admin","legalName":"Tociva Technologies",
      "productName":"Idnest Admin","primaryColor":"#193b45","secondaryColor":"#102c34",
      "surfaceColor":"#ffffff","textColor":"#142126","mutedTextColor":"#607078",
      "errorColor":"#b42318","borderRadius":"12px","fontFamily":"system",
      "loginHeading":"Sign in to Idnest Admin","loginDescription":"System administrator access only.",
      "registrationHeading":"Registration unavailable","recoveryHeading":"Recover administrator access",
      "consentHeading":"Review Idnest Admin access","supportUrl":"https://idnest.cloud/support",
      "privacyUrl":"/privacy","termsUrl":"/terms",
      "copyrightText":"Tociva Technologies","defaultLocale":"en"
    }'::jsonb)
) AS seed(key, definition)
JOIN auth_brands b ON b.key = seed.key
ON CONFLICT (brand_id, version) DO NOTHING;

-- One-time: rename purpose-based policy display names and migrate definition
-- shape from accessMode → identityGate (schema_migrations version 5).
WITH policy_renames(old_name, new_name, identity_gate) AS (
  VALUES
    ('Open social sign-in', 'Public Social', 'public'),
    ('Open Google sign-in', 'Public Access', 'public'),
    ('Restricted Google sign-in', 'Approved Users', 'existing-identity'),
    ('Invitation-only Google sign-in', 'Invite Only', 'invitation'),
    ('Restricted Google + TOTP sign-in', 'Staff MFA', 'existing-identity'),
    -- Also cover Idnest-owned pre-v3 slug names if a DB skipped that rename.
    ('default-public', 'Public Social', 'public'),
    ('idnest-admin', 'Staff MFA', 'existing-identity')
), current_definitions AS (
  SELECT p.id, p.current_version, pv.definition, renames.new_name, renames.identity_gate
  FROM authentication_policies p
  JOIN policy_renames renames ON renames.old_name = p.name
  JOIN authentication_policy_versions pv
    ON pv.authentication_policy_id = p.id AND pv.version = p.current_version
  WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5)
), renamed_policies AS (
  UPDATE authentication_policies p
  SET name = current_definitions.new_name,
      current_version = p.current_version + 1,
      updated_at = now()
  FROM current_definitions
  WHERE p.id = current_definitions.id
  RETURNING p.id, p.current_version, current_definitions.definition,
            current_definitions.new_name, current_definitions.identity_gate
)
INSERT INTO authentication_policy_versions(
  authentication_policy_id, version, definition, created_by, reason
)
SELECT id, current_version,
       (jsonb_set(
          jsonb_set(definition, '{name}', to_jsonb(new_name), true),
          '{identityGate}', to_jsonb(identity_gate), true
        ) - 'accessMode'),
       'system', 'Renamed to authentication policy with identity gate'
FROM renamed_policies;

-- Backfill identityGate on any remaining policies that still have accessMode
-- but were not renamed above (e.g. admin-created policies).
WITH stale AS (
  SELECT p.id, p.current_version, pv.definition,
         CASE
           WHEN COALESCE(pv.definition->>'accessMode', '') = 'grant-required'
             AND COALESCE(pv.definition->>'registrationMode', '') = 'invitation-only'
             THEN 'invitation'
           WHEN COALESCE(pv.definition->>'accessMode', '') = 'grant-required'
             THEN 'existing-identity'
           WHEN jsonb_array_length(COALESCE(pv.definition->'allowedEmails', '[]'::jsonb)) > 0
             THEN 'email-allowlist'
           WHEN jsonb_array_length(COALESCE(pv.definition->'allowedEmailDomains', '[]'::jsonb)) > 0
             THEN 'domain-allowlist'
           ELSE 'public'
         END AS identity_gate
  FROM authentication_policies p
  JOIN authentication_policy_versions pv
    ON pv.authentication_policy_id = p.id AND pv.version = p.current_version
  WHERE pv.definition ? 'accessMode'
    AND NOT (pv.definition ? 'identityGate')
    AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5)
), bumped AS (
  UPDATE authentication_policies p
  SET current_version = p.current_version + 1, updated_at = now()
  FROM stale
  WHERE p.id = stale.id
  RETURNING p.id, p.current_version, stale.definition, stale.identity_gate
)
INSERT INTO authentication_policy_versions(
  authentication_policy_id, version, definition, created_by, reason
)
SELECT id, current_version,
       (jsonb_set(definition, '{identityGate}', to_jsonb(identity_gate), true) - 'accessMode'),
       'system', 'Migrated accessMode to identityGate'
FROM bumped;

-- Rewrite oauth_client_auth_config_versions snapshots: loginPolicyId → authPolicyId
UPDATE oauth_client_auth_config_versions
SET snapshot = (snapshot - 'loginPolicyId' - 'loginPolicyVersion')
  || jsonb_build_object(
       'authPolicyId', snapshot->'loginPolicyId',
       'authPolicyVersion', COALESCE(snapshot->'loginPolicyVersion', '0'::jsonb)
     )
WHERE snapshot ? 'loginPolicyId'
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5);

-- One-time: drop IdP names from policy identity (schema_migrations version 6).
-- Runs before seed inserts so existing Google-named rows are renamed before
-- intent-named seeds are inserted with ON CONFLICT DO NOTHING.
WITH policy_renames(old_name, new_name) AS (
  VALUES
    ('Public Google', 'Public Access'),
    ('Approved Google', 'Approved Users'),
    ('Invite-only Google', 'Invite Only')
), current_definitions AS (
  SELECT p.id, p.current_version, pv.definition, renames.new_name
  FROM authentication_policies p
  JOIN policy_renames renames ON renames.old_name = p.name
  JOIN authentication_policy_versions pv
    ON pv.authentication_policy_id = p.id AND pv.version = p.current_version
  WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 6)
), renamed_policies AS (
  UPDATE authentication_policies p
  SET name = current_definitions.new_name,
      current_version = p.current_version + 1,
      updated_at = now()
  FROM current_definitions
  WHERE p.id = current_definitions.id
  RETURNING p.id, p.current_version, current_definitions.definition,
            current_definitions.new_name
)
INSERT INTO authentication_policy_versions(
  authentication_policy_id, version, definition, created_by, reason
)
SELECT id, current_version,
       jsonb_set(definition, '{name}', to_jsonb(new_name), true),
       'system', 'Renamed policy to intent-based name without IdP identity'
FROM renamed_policies;

INSERT INTO authentication_policies(name, status)
VALUES
  ('Public Social', 'active'),
  ('Public Access', 'active'),
  ('Approved Users', 'active'),
  ('Invite Only', 'active'),
  ('Staff MFA', 'active')
ON CONFLICT (name) DO NOTHING;

INSERT INTO authentication_policy_versions(
  authentication_policy_id, version, definition, created_by, reason
)
SELECT p.id, 1, seed.definition, 'system', 'Initial authentication policy seed'
FROM (
  VALUES
    ('Public Social', '{
      "name":"Public Social","passwordEnabled":false,"passkeyEnabled":false,
      "allowedOidcProviders":["google","apple"],"totpEnabled":false,"minimumAal":"aal1",
      "registrationMode":"enabled","identityGate":"public","allowedEmailDomains":[],
      "allowedEmails":[],"requireVerifiedEmail":true,"forceReauthentication":false,
      "sessionMaximumAgeSeconds":3600
    }'::jsonb),
    ('Public Access', '{
      "name":"Public Access","passwordEnabled":false,"passkeyEnabled":false,
      "allowedOidcProviders":["google"],"totpEnabled":false,"minimumAal":"aal1",
      "registrationMode":"enabled","identityGate":"public","allowedEmailDomains":[],
      "allowedEmails":[],"requireVerifiedEmail":true,"forceReauthentication":false,
      "sessionMaximumAgeSeconds":3600
    }'::jsonb),
    ('Approved Users', '{
      "name":"Approved Users","passwordEnabled":false,"passkeyEnabled":false,
      "allowedOidcProviders":["google"],"totpEnabled":false,"minimumAal":"aal1",
      "registrationMode":"disabled","identityGate":"existing-identity","allowedEmailDomains":[],
      "allowedEmails":[],"requireVerifiedEmail":true,"forceReauthentication":false,
      "sessionMaximumAgeSeconds":1800
    }'::jsonb),
    ('Invite Only', '{
      "name":"Invite Only","passwordEnabled":false,"passkeyEnabled":false,
      "allowedOidcProviders":["google"],"totpEnabled":false,"minimumAal":"aal1",
      "registrationMode":"invitation-only","identityGate":"invitation","allowedEmailDomains":[],
      "allowedEmails":[],"requireVerifiedEmail":true,"forceReauthentication":false,
      "sessionMaximumAgeSeconds":3600
    }'::jsonb),
    ('Staff MFA', '{
      "name":"Staff MFA","passwordEnabled":false,"passkeyEnabled":false,
      "allowedOidcProviders":["google"],"totpEnabled":true,"minimumAal":"aal2",
      "registrationMode":"disabled","identityGate":"existing-identity","allowedEmailDomains":[],
      "allowedEmails":[],"requireVerifiedEmail":true,"forceReauthentication":false,
      "sessionMaximumAgeSeconds":900
    }'::jsonb)
) AS seed(name, definition)
JOIN authentication_policies p ON p.name = seed.name
ON CONFLICT (authentication_policy_id, version) DO NOTHING;

INSERT INTO oauth_client_auth_configs(
  hydra_client_id, brand_id, authentication_policy_id, status, is_first_party, consent_mode
)
SELECT seed.client_id, b.id, p.id, 'active', true, seed.consent_mode
FROM (
  VALUES
    ('idnest-admin-client', 'idnest-admin', 'Staff MFA', 'skip-for-first-party')
) AS seed(client_id, brand_key, policy_name, consent_mode)
JOIN auth_brands b ON b.key = seed.brand_key
JOIN authentication_policies p ON p.name = seed.policy_name
ON CONFLICT (hydra_client_id) DO NOTHING;

INSERT INTO oauth_client_auth_config_versions(
  hydra_client_id, version, snapshot, created_by, reason
)
SELECT c.hydra_client_id, c.version,
  jsonb_build_object(
    'hydraClientId', c.hydra_client_id,
    'brandId', c.brand_id,
    'authPolicyId', c.authentication_policy_id,
    'status', c.status,
    'isFirstParty', c.is_first_party,
    'consentMode', c.consent_mode,
    'mappingVersion', c.version
  ),
  'system',
  'Initial OAuth client auth configuration seed'
FROM oauth_client_auth_configs c
WHERE c.hydra_client_id = 'idnest-admin-client'
ON CONFLICT (hydra_client_id, version) DO NOTHING;

-- Drop obsolete system-created client placeholders once while preserving
-- administrator-created mappings and the Idnest administration client.
DELETE FROM oauth_client_auth_configs c
WHERE c.hydra_client_id <> 'idnest-admin-client'
  AND EXISTS (
    SELECT 1
    FROM oauth_client_auth_config_versions v
    WHERE v.hydra_client_id = c.hydra_client_id
      AND v.version = 1
      AND v.created_by = 'system'
      AND v.reason = 'Initial OAuth client auth configuration seed'
  )
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4);

DELETE FROM oauth_client_auth_config_versions v
WHERE v.hydra_client_id <> 'idnest-admin-client'
  AND v.version = 1
  AND v.created_by = 'system'
  AND v.reason = 'Initial OAuth client auth configuration seed'
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4);

-- Archive unused non-Idnest brands that came from historical system seeds.
-- Brands attached to active clients remain untouched for administrator review.
UPDATE auth_brands b
SET status = 'archived', updated_at = now()
WHERE b.key NOT IN ('idnest-default', 'idnest-admin')
  AND EXISTS (
    SELECT 1
    FROM auth_brand_versions v
    WHERE v.brand_id = b.id
      AND v.version = 1
      AND v.created_by = 'system'
      AND v.reason = 'Initial trusted brand seed'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM oauth_client_auth_configs c
    WHERE c.brand_id = b.id AND c.status = 'active'
  )
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 7);

INSERT INTO schema_migrations(version, name)
VALUES
  (1, 'auth platform base'),
  (2, 'client-specific branded authentication'),
  (3, 'behavior-based login policy names'),
  (4, 'seed only idnest-admin-client mapping'),
  (5, 'rename login policy to authentication policy'),
  (6, 'intent-based authentication policy names without IdP identity'),
  (7, 'archive unused historical system brands')
ON CONFLICT (version) DO NOTHING;
`;

export async function migrateAuthzSchema(db: Db): Promise<void> {
  await db.query(AUTHZ_SCHEMA_SQL);
}
