import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, deleteClient, getClient } from "../handlers/clients";

const integrationEnabled = process.env.HYDRA_CORS_INTEGRATION === "1";
const hydraAdminUrl = process.env.HYDRA_CORS_TEST_ADMIN_URL ?? "";
const hydraPublicUrl = process.env.HYDRA_CORS_TEST_PUBLIC_URL ?? "";
const globalOrigin = "https://hydra.cors.test";
const publicMetadataPaths = [
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/.well-known/jwks.json",
];

const submittedOrigins = [
  "https://CLIENT.example:443/",
  " https://client.example ",
  "https://app.client.example",
  "https://bücher.example",
  "https://client.example:8443",
  "https://192.0.2.10:9443",
  "http://localhost:80",
  "http://localhost:4200",
  "http://tenant.localhost:4300",
  "http://127.1:4400",
];

const storedOrigins = [
  "https://client.example",
  "https://app.client.example",
  "https://xn--bcher-kva.example",
  "https://client.example:8443",
  "https://192.0.2.10:9443",
  "http://localhost",
  "http://localhost:4200",
  "http://tenant.localhost:4300",
  "http://127.0.0.1:4400",
];

const deniedOrigins = [
  "http://client.example",
  "https://client.example:9443",
  "https://other.client.example",
  "https://client.example.evil.test",
  "http://localhost:4201",
  "http://127.0.0.2:4400",
  "https://[2001:db8::1]:9443",
  "http://[::1]:4501",
];

const originalHydraAdminUrl = process.env.HYDRA_ADMIN_URL;
const originalNodeEnv = process.env.NODE_ENV;
const clientId = `cors-integration-${randomUUID()}`;

async function tokenResponse(origin: string): Promise<Response> {
  return fetch(`${hydraPublicUrl.replace(/\/+$/, "")}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({
      client_id: clientId,
      code: "intentionally-invalid-authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }),
  });
}

async function tokenPreflightResponse(origin: string): Promise<Response> {
  return fetch(`${hydraPublicUrl.replace(/\/+$/, "")}/oauth2/token`, {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "POST",
      Origin: origin,
    },
  });
}

async function publicMetadataResponse(path: string, origin: string): Promise<Response> {
  return fetch(`${hydraPublicUrl.replace(/\/+$/, "")}${path}`, {
    headers: { Origin: origin },
  });
}

async function waitForClientCors(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await tokenResponse(origin);
    if (response.headers.get("access-control-allow-origin") === origin) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hydra did not activate the client CORS origin within 10 seconds: ${origin}`);
}

describe.skipIf(!integrationEnabled)("created OAuth client CORS against Hydra", () => {
  beforeAll(async () => {
    if (!hydraAdminUrl || !hydraPublicUrl) {
      throw new Error("HYDRA_CORS_TEST_ADMIN_URL and HYDRA_CORS_TEST_PUBLIC_URL are required");
    }

    process.env.HYDRA_ADMIN_URL = hydraAdminUrl;
    process.env.NODE_ENV = "test";
    const result = await createClient({
      client_id: clientId,
      client_name: "CORS integration test client",
      client_type: "spa",
      redirect_uris: ["https://client.example/callback"],
      allowed_cors_origins: submittedOrigins,
    });
    if (result.status !== 201) {
      throw new Error(`Could not create the Hydra CORS test client: ${JSON.stringify(result.body)}`);
    }
    await waitForClientCors(storedOrigins[0]);
  }, 20_000);

  afterAll(async () => {
    if (hydraAdminUrl) await deleteClient({ client_id: clientId });
    if (originalHydraAdminUrl === undefined) delete process.env.HYDRA_ADMIN_URL;
    else process.env.HYDRA_ADMIN_URL = originalHydraAdminUrl;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("persists every normalized allowed origin on the created Hydra client", async () => {
    const result = await getClient({ client_id: clientId });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      client_id: clientId,
      allowed_cors_origins: storedOrigins,
    });
  });

  it.each(storedOrigins)("allows the exact registered origin: %s", async (origin) => {
    const response = await tokenResponse(origin);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allows the exact non-wildcard global fallback origin", async () => {
    const response = await tokenResponse(globalOrigin);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe(globalOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it.each(deniedOrigins)("does not allow an unregistered near-miss origin: %s", async (origin) => {
    const response = await tokenResponse(origin);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not authorize a client-only origin from an anonymous preflight", async () => {
    const origin = storedOrigins[0];
    const preflight = await tokenPreflightResponse(origin);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const actual = await tokenResponse(deniedOrigins[0]);
    expect(actual.headers.get("access-control-allow-origin")).toBeNull();
    expect(actual.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it.each(publicMetadataPaths)(
    "keeps public metadata on the exact global fallback before gateway handling: %s",
    async (path) => {
      const globallyAllowed = await publicMetadataResponse(path, globalOrigin);
      expect(globallyAllowed.status).toBe(200);
      expect(globallyAllowed.headers.get("access-control-allow-origin")).toBe(globalOrigin);

      const unregistered = await publicMetadataResponse(path, deniedOrigins[0]);
      expect(unregistered.status).toBe(200);
      expect(unregistered.headers.get("access-control-allow-origin")).toBeNull();
      expect(unregistered.headers.get("access-control-allow-credentials")).toBeNull();
    },
  );
});
