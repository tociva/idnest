// Seed the local Idnest Admin authentication policy from ADMIN_BOOTSTRAP_EMAILS.
//
// This is intentionally a local setup-time seed, not runtime synchronization.
// It only replaces the stock Staff MFA mapping that migrations create for the
// admin client. Once the admin mapping points at another policy, future setup
// runs leave administrator-managed allowlists untouched.

const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

for (const envFile of [resolve(repoRoot, ".env"), resolve(repoRoot, "monorepo/.env")]) {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

const env = process.env;
const AUTHZ_DATABASE_URL = env.AUTHZ_DATABASE_URL;
const CLIENT_ID = env.ADMIN_OIDC_CLIENT_ID || "idnest-admin-client";
const SEEDED_ADMIN_POLICY_NAME = "Staff MFA";
const ADMIN_ALLOWLIST_POLICY_NAME = "Idnest Admin Email Allowlist";
const ADMIN_BRAND_KEY = "idnest-admin";

function loadEnvFile(file) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = unquote(match[2].trim());
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function adminBootstrapEmails() {
  const emails = String(env.ADMIN_BOOTSTRAP_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(emails)];
}

function requireValidEmails(emails) {
  if (emails.length === 0) {
    throw new Error("ADMIN_BOOTSTRAP_EMAILS must include at least one email to seed the admin allowlist.");
  }
  const invalid = emails.filter((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
  if (invalid.length > 0) {
    throw new Error(`ADMIN_BOOTSTRAP_EMAILS contains invalid email address(es): ${invalid.join(", ")}`);
  }
}

function adminPolicyDefinition(emails) {
  return {
    name: ADMIN_ALLOWLIST_POLICY_NAME,
    passwordEnabled: false,
    passkeyEnabled: false,
    allowedOidcProviders: ["google"],
    totpEnabled: true,
    minimumAal: "aal2",
    registrationMode: "enabled",
    identityGate: "email-allowlist",
    allowedEmailDomains: [],
    allowedEmails: emails,
    requireVerifiedEmail: true,
    forceReauthentication: false,
    sessionMaximumAgeSeconds: 900,
  };
}

async function currentAdminMapping(client) {
  const result = await client.query(
    `SELECT c.hydra_client_id, c.brand_id::text, c.authentication_policy_id::text,
            c.status, c.is_first_party, c.consent_mode, c.version,
            p.name AS authentication_policy_name
     FROM oauth_client_auth_configs c
     JOIN authentication_policies p ON p.id = c.authentication_policy_id
     WHERE c.hydra_client_id = $1
     LIMIT 1`,
    [CLIENT_ID],
  );
  return result.rows[0] ?? null;
}

async function upsertAllowlistPolicy(client, definition) {
  const existing = await client.query(
    `SELECT p.id::text, p.current_version, p.status, pv.definition
     FROM authentication_policies p
     JOIN authentication_policy_versions pv
       ON pv.authentication_policy_id = p.id AND pv.version = p.current_version
     WHERE p.name = $1
     LIMIT 1`,
    [ADMIN_ALLOWLIST_POLICY_NAME],
  );
  const existingPolicy = existing.rows[0];
  const definitionJson = JSON.stringify(definition);

  if (!existingPolicy) {
    const created = await client.query(
      `WITH policy AS (
         INSERT INTO authentication_policies(name, status)
         VALUES ($1, 'active')
         RETURNING id, current_version
       ), version AS (
         INSERT INTO authentication_policy_versions(
           authentication_policy_id, version, definition, created_by, reason
         )
         SELECT id, current_version, $2::jsonb, 'local-bootstrap',
                'Seed admin email allowlist from ADMIN_BOOTSTRAP_EMAILS'
         FROM policy
         RETURNING authentication_policy_id
       )
       SELECT p.id::text, p.current_version
       FROM policy p
       JOIN version v ON v.authentication_policy_id = p.id`,
      [ADMIN_ALLOWLIST_POLICY_NAME, definitionJson],
    );
    return created.rows[0];
  }

  const existingDefinition = JSON.stringify(existingPolicy.definition);
  if (existingPolicy.status === "active" && existingDefinition === definitionJson) {
    return { id: existingPolicy.id, current_version: existingPolicy.current_version };
  }

  const updated = await client.query(
    `WITH policy AS (
       UPDATE authentication_policies
       SET status = 'active', current_version = current_version + 1, updated_at = now()
       WHERE id = $1
       RETURNING id, current_version
     ), version AS (
       INSERT INTO authentication_policy_versions(
         authentication_policy_id, version, definition, created_by, reason
       )
       SELECT id, current_version, $2::jsonb, 'local-bootstrap',
              'Refresh admin email allowlist from ADMIN_BOOTSTRAP_EMAILS'
       FROM policy
       RETURNING authentication_policy_id
     )
     SELECT p.id::text, p.current_version
     FROM policy p
     JOIN version v ON v.authentication_policy_id = p.id`,
    [existingPolicy.id, definitionJson],
  );
  return updated.rows[0];
}

async function upsertAdminMapping(client, policyId) {
  const brand = await client.query(
    `SELECT id::text
     FROM auth_brands
     WHERE key = $1 AND status = 'active'
     LIMIT 1`,
    [ADMIN_BRAND_KEY],
  );
  const brandId = brand.rows[0]?.id;
  if (!brandId) {
    throw new Error(`Active ${ADMIN_BRAND_KEY} auth brand is not configured.`);
  }

  const config = await client.query(
    `WITH config AS (
       INSERT INTO oauth_client_auth_configs(
         hydra_client_id, brand_id, authentication_policy_id, status, is_first_party, consent_mode
       )
       VALUES ($1, $2, $3, 'active', true, 'skip-for-first-party')
       ON CONFLICT (hydra_client_id) DO UPDATE
       SET brand_id = EXCLUDED.brand_id,
           authentication_policy_id = EXCLUDED.authentication_policy_id,
           status = EXCLUDED.status,
           is_first_party = EXCLUDED.is_first_party,
           consent_mode = EXCLUDED.consent_mode,
           version = oauth_client_auth_configs.version + 1,
           updated_at = now()
       RETURNING *
     ), history AS (
       INSERT INTO oauth_client_auth_config_versions(
         hydra_client_id, version, snapshot, created_by, reason
       )
       SELECT hydra_client_id, version,
         jsonb_build_object(
           'hydraClientId', hydra_client_id,
           'brandId', brand_id,
           'authPolicyId', authentication_policy_id,
           'status', status,
           'isFirstParty', is_first_party,
           'consentMode', consent_mode,
           'mappingVersion', version
         ),
         'local-bootstrap',
         'Map admin client to bootstrap email allowlist policy'
       FROM config
       ON CONFLICT (hydra_client_id, version) DO NOTHING
       RETURNING hydra_client_id
     )
     SELECT hydra_client_id, version FROM config`,
    [CLIENT_ID, brandId, policyId],
  );
  return config.rows[0];
}

async function seedAdminEmailAllowlist() {
  if (!AUTHZ_DATABASE_URL) {
    throw new Error("AUTHZ_DATABASE_URL is required to seed the admin email allowlist.");
  }
  const emails = adminBootstrapEmails();
  requireValidEmails(emails);

  const { Pool } = require(resolve(repoRoot, "monorepo/node_modules/pg"));
  const pool = new Pool({ connectionString: AUTHZ_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mapping = await currentAdminMapping(client);
    if (
      mapping &&
      mapping.authentication_policy_name !== SEEDED_ADMIN_POLICY_NAME
    ) {
      await client.query("COMMIT");
      console.log(
        `Admin auth mapping already uses "${mapping.authentication_policy_name}"; leaving allowlist unchanged.`,
      );
      return;
    }

    const policy = await upsertAllowlistPolicy(client, adminPolicyDefinition(emails));
    await upsertAdminMapping(client, policy.id);
    await client.query("COMMIT");
    console.log(
      `Admin auth mapping seeded with ${emails.length} bootstrap email${emails.length === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedAdminEmailAllowlist().catch((err) => {
  console.error(err);
  process.exit(1);
});
