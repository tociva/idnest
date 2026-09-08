import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, deleteClient, replaceClientSecret } from "../handlers/clients";

const integrationEnabled = process.env.HYDRA_SECRET_INTEGRATION === "1";
const hydraAdminUrl = process.env.HYDRA_SECRET_TEST_ADMIN_URL ?? "";
const hydraPublicUrl = process.env.HYDRA_SECRET_TEST_PUBLIC_URL ?? "";
const clientId = `secret-replacement-integration-${randomUUID()}`;

const originalHydraAdminUrl = process.env.HYDRA_ADMIN_URL;
const originalAuthzDatabaseUrl = process.env.AUTHZ_DATABASE_URL;
let originalSecret = "";

function secretFrom(body: unknown): string {
  if (!body || typeof body !== "object" || !("client_secret" in body)) return "";
  const secret = (body as { client_secret?: unknown }).client_secret;
  return typeof secret === "string" ? secret : "";
}

async function requestClientCredentials(secret: string): Promise<Response> {
  return fetch(`${hydraPublicUrl.replace(/\/+$/, "")}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
}

describe.skipIf(!integrationEnabled)("OAuth client secret replacement against Hydra", () => {
  beforeAll(async () => {
    if (!hydraAdminUrl || !hydraPublicUrl) {
      throw new Error("HYDRA_SECRET_TEST_ADMIN_URL and HYDRA_SECRET_TEST_PUBLIC_URL are required");
    }

    process.env.HYDRA_ADMIN_URL = hydraAdminUrl;
    delete process.env.AUTHZ_DATABASE_URL;
    const result = await createClient({
      client_id: clientId,
      client_name: "Secret replacement integration test client",
      client_type: "service",
    });
    originalSecret = secretFrom(result.body);
    if (result.status !== 201 || !originalSecret) {
      throw new Error(`Could not create the Hydra secret test client (status ${result.status})`);
    }
  }, 20_000);

  afterAll(async () => {
    if (hydraAdminUrl) await deleteClient({ client_id: clientId });
    if (originalHydraAdminUrl === undefined) delete process.env.HYDRA_ADMIN_URL;
    else process.env.HYDRA_ADMIN_URL = originalHydraAdminUrl;
    if (originalAuthzDatabaseUrl === undefined) delete process.env.AUTHZ_DATABASE_URL;
    else process.env.AUTHZ_DATABASE_URL = originalAuthzDatabaseUrl;
  });

  it("immediately revokes the old secret and accepts the replacement", async () => {
    expect((await requestClientCredentials(originalSecret)).status).toBe(200);

    const replacement = await replaceClientSecret({ client_id: clientId });
    const newSecret = secretFrom(replacement.body);
    expect(replacement.status).toBe(200);
    expect(newSecret).not.toBe("");
    expect(newSecret).not.toBe(originalSecret);

    expect((await requestClientCredentials(originalSecret)).status).toBe(401);
    expect((await requestClientCredentials(newSecret)).status).toBe(200);
  });
});
