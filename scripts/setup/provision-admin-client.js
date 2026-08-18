// Provision the Idnest Admin console's own Hydra OAuth client.
// Product clients are created and managed through the admin UI.
// Requires Node.js 18+ for built-in fetch.

const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const args = new Set(process.argv.slice(2));
const shouldRepairStaleAdminGrants = args.has("--repair-stale-admin-grants");
const dryRun = args.has("--dry-run");
if (args.has("--help")) {
  console.log(
    "Usage: node scripts/setup/provision-admin-client.js [--repair-stale-admin-grants [--dry-run]]",
  );
  process.exit(0);
}
if (!shouldRepairStaleAdminGrants && dryRun) {
  throw new Error("--dry-run requires --repair-stale-admin-grants.");
}
if (args.size > (shouldRepairStaleAdminGrants ? 1 + Number(dryRun) : 0)) {
  throw new Error("Unknown argument. Use --help for usage.");
}

for (const envFile of [resolve(repoRoot, ".env"), resolve(repoRoot, "monorepo/.env")]) {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

const env = process.env;

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

const HYDRA_ADMIN_URL = env.HYDRA_ADMIN_URL || "http://localhost:4445";
const KRATOS_ADMIN_URL = env.KRATOS_ADMIN_URL || "http://localhost:4434";
const AUTHZ_DATABASE_URL = env.AUTHZ_DATABASE_URL;
const CLIENT_ID = env.ADMIN_OIDC_CLIENT_ID || "idnest-admin-client";
const CLIENT_NAME = env.ADMIN_AUTH_CLIENT_NAME || "Idnest Admin Console";
const CLIENT_AUDIENCE = env.ADMIN_OIDC_AUDIENCE || "idnest-admin";
const CLIENT_SECRET = env.ADMIN_OIDC_CLIENT_SECRET;
const DEFAULT_ADMIN_ORIGIN = "https://admin-dev.idnest.cloud";
const DEFAULT_AUTH_ORIGIN = "https://auth-dev.idnest.cloud";

function csv(value, fallback) {
  const values = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

function originOf(url, fallback) {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

function logoutReturnUri(url) {
  const value = new URL(url);
  value.searchParams.set("sso", "done");
  return value.toString();
}

const adminOrigin = (env.ADMIN_PUBLIC_ORIGIN || DEFAULT_ADMIN_ORIGIN).replace(/\/+$/, "");
const redirectUris = csv(env.ADMIN_OIDC_REDIRECT_URIS, [
  env.ADMIN_OIDC_REDIRECT_URI || `${adminOrigin}/api/admin/auth/callback`,
]);
const postLogoutRedirectUris = csv(env.ADMIN_AUTH_POST_LOGOUT_REDIRECT_URIS, [
  env.ADMIN_AUTH_POST_LOGOUT_REDIRECT || `${adminOrigin}/auth/logout`,
]);
const clientOrigin = env.ADMIN_AUTH_CLIENT_URI || originOf(redirectUris[0], adminOrigin);
const legalOrigin = env.ADMIN_AUTH_LEGAL_URI || env.AUTH_BASE_URL || env.AUTH_URL || DEFAULT_AUTH_ORIGIN;

const CLIENT_PAYLOAD = {
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  grant_types: ["authorization_code"],
  response_types: ["code"],
  scope: env.ADMIN_OIDC_SCOPE || "openid profile email",
  redirect_uris: redirectUris,
  post_logout_redirect_uris: postLogoutRedirectUris,
  token_endpoint_auth_method: "client_secret_basic",
  client_name: CLIENT_NAME,
  client_uri: clientOrigin,
  policy_uri: env.ADMIN_AUTH_POLICY_URI || `${legalOrigin.replace(/\/+$/, "")}/privacy`,
  tos_uri: env.ADMIN_AUTH_TOS_URI || `${legalOrigin.replace(/\/+$/, "")}/terms`,
  contacts: csv(env.ADMIN_AUTH_CONTACTS, ["support@idnest.cloud"]),
  metadata: {
    client_type: "web",
    trust_tier: "first_party",
    consent_version: 1,
    remember_offline_access: false,
    allowed_return_uris: postLogoutRedirectUris.map(logoutReturnUri),
  },
  audience: csv(CLIENT_AUDIENCE, ["idnest-admin"]),
};

const ADMIN_CLIENTS_BASE = `${HYDRA_ADMIN_URL.replace(/\/+$/, "")}/admin/clients`;

async function deleteHydraClient() {
  const res = await fetch(`${ADMIN_CLIENTS_BASE}/${encodeURIComponent(CLIENT_ID)}`, {
    method: "DELETE",
  });

  if (res.ok) {
    console.log(`Client "${CLIENT_ID}" deleted.`);
    return;
  }
  if (res.status === 404) {
    console.log(`Client "${CLIENT_ID}" does not exist.`);
    return;
  }

  throw new Error(`Failed to delete client: ${res.status} ${res.statusText}\n${await res.text()}`);
}

async function createHydraClient() {
  const response = await fetch(ADMIN_CLIENTS_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(CLIENT_PAYLOAD),
  });

  if (!response.ok) {
    throw new Error(`Failed to create client: ${response.status} ${response.statusText}\n${await response.text()}`);
  }

  const created = await response.json();
  console.log(`Client "${created.client_id || CLIENT_ID}" created.`);
}

async function repairStaleAdminGrants() {
  if (!AUTHZ_DATABASE_URL) {
    throw new Error("AUTHZ_DATABASE_URL is required to repair stale admin grants.");
  }
  const { Pool } = require(resolve(repoRoot, "monorepo/node_modules/pg"));
  const pool = new Pool({ connectionString: AUTHZ_DATABASE_URL });
  try {
    const grants = await pool.query(
      `SELECT identity_id
       FROM client_access_grants
       WHERE client_id = $1
         AND role = 'system-admin'
         AND granted_by = 'authz-seed'
         AND revoked_at IS NULL`,
      [CLIENT_ID],
    );
    let repaired = 0;
    for (const { identity_id: identityId } of grants.rows) {
      const identityResponse = await fetch(
        `${KRATOS_ADMIN_URL.replace(/\/+$/, "")}/identities/${encodeURIComponent(identityId)}`,
      );
      if (identityResponse.ok) continue;
      if (identityResponse.status !== 404) {
        throw new Error(
          `Failed to verify seeded administrator ${identityId}: ${identityResponse.status} ${identityResponse.statusText}`,
        );
      }
      if (dryRun) {
        console.log(`Would revoke stale seeded administrator grant for ${identityId}.`);
        repaired += 1;
        continue;
      }
      const result = await pool.query(
        `UPDATE client_access_grants
         SET revoked_at = now(), revoked_by = 'stale-identity-repair'
         WHERE identity_id = $1
           AND client_id = $2
           AND role = 'system-admin'
           AND granted_by = 'authz-seed'
           AND revoked_at IS NULL`,
        [identityId, CLIENT_ID],
      );
      repaired += result.rowCount ?? 0;
      console.log(`Revoked stale seeded administrator grant for ${identityId}.`);
    }
    console.log(
      repaired
        ? `${dryRun ? "Found" : "Repaired"} ${repaired} stale seeded administrator grant${repaired === 1 ? "" : "s"}.`
        : "No stale seeded administrator grants found.",
    );
  } finally {
    await pool.end();
  }
}

(async () => {
  if (shouldRepairStaleAdminGrants) {
    await repairStaleAdminGrants();
    return;
  }
  if (!CLIENT_SECRET) {
    throw new Error("ADMIN_OIDC_CLIENT_SECRET is required to register the confidential admin client.");
  }
  console.log(`Registering admin Hydra client "${CLIENT_ID}" against ${ADMIN_CLIENTS_BASE}`);
  await deleteHydraClient();
  await createHydraClient();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
