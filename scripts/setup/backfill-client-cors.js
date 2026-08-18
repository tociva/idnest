#!/usr/bin/env node
// Backfill exact Hydra allowed_cors_origins for existing SPA clients.
// Dry-run is the default; pass --apply only after reviewing the printed plan.

const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
for (const envFile of [resolve(repoRoot, ".env"), resolve(repoRoot, "monorepo/.env")]) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]] !== undefined) continue;
    const raw = match[2].trim();
    process.env[match[1]] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
}

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const apply = args.includes("--apply");
const clientArg = args.find((arg) => arg.startsWith("--client="));
const onlyClientId = clientArg?.slice("--client=".length) || "";
if (args.includes("--help")) {
  console.log("Usage: node scripts/setup/backfill-client-cors.js [--client=CLIENT_ID] [--apply]");
  process.exit(0);
}
if (args.some((arg) => arg !== "--apply" && !arg.startsWith("--client="))) {
  throw new Error("Unknown argument. Use --help for usage.");
}

const hydraAdminUrl = (process.env.HYDRA_ADMIN_URL || "http://localhost:4445").replace(/\/+$/, "");

function isSpa(client) {
  if (client.metadata?.client_type) return client.metadata.client_type === "spa";
  return (
    client.token_endpoint_auth_method === "none" &&
    (client.grant_types || []).includes("authorization_code")
  );
}

function originFromRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
    const loopback =
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function writableClient(client, origins) {
  const {
    client_secret: _clientSecret,
    registration_access_token: _registrationAccessToken,
    registration_client_uri: _registrationClientUri,
    created_at: _createdAt,
    updated_at: _updatedAt,
    ...payload
  } = client;
  return { ...payload, allowed_cors_origins: origins };
}

async function responseError(response) {
  return (await response.text().catch(() => "")).slice(0, 500) || response.statusText;
}

async function main() {
  const response = await fetch(`${hydraAdminUrl}/admin/clients`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unable to list Hydra clients (${response.status}): ${await responseError(response)}`);
  const clients = await response.json();
  if (!Array.isArray(clients)) throw new Error("Hydra returned an invalid client list");

  const candidates = clients
    .filter((client) => (!onlyClientId || client.client_id === onlyClientId) && isSpa(client))
    .filter((client) => !Array.isArray(client.allowed_cors_origins) || client.allowed_cors_origins.length === 0)
    .map((client) => ({
      client,
      origins: [...new Set((client.redirect_uris || []).map(originFromRedirectUri).filter(Boolean))],
    }));

  if (onlyClientId && !clients.some((client) => client.client_id === onlyClientId)) {
    throw new Error(`Client "${onlyClientId}" was not found`);
  }

  for (const { client, origins } of candidates) {
    console.log(`${apply ? "Applying" : "Would apply"} ${client.client_id}: ${origins.join(", ") || "no valid origins"}`);
    if (!apply || origins.length === 0) continue;
    const update = await fetch(`${hydraAdminUrl}/admin/clients/${encodeURIComponent(client.client_id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(writableClient(client, origins)),
    });
    if (!update.ok) {
      throw new Error(`Unable to update ${client.client_id} (${update.status}): ${await responseError(update)}`);
    }
  }

  console.log(
    candidates.length === 0
      ? "No SPA clients require a CORS backfill."
      : apply
        ? "CORS backfill complete. Configure any clients with no valid derived origins manually."
        : "Dry run only. Re-run with --apply after reviewing every origin.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
