import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, deleteClient, getClient, updateClient } from "../handlers/clients";
import { mockFetchByUrl } from "./helpers";

beforeEach(() => {
  process.env.HYDRA_ADMIN_URL = "http://hydra:4445";
  process.env.ADMIN_OIDC_CLIENT_ID = "idnest-admin-client";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ADMIN_OIDC_CLIENT_ID;
});

describe("oauth client management", () => {
  it("gets a client by id", async () => {
    mockFetchByUrl([
      { match: "/admin/clients/app1", result: { ok: true, json: { client_id: "app1" } } },
    ]);
    expect(await getClient({ client_id: "app1" })).toMatchObject({
      status: 200,
      body: { client_id: "app1" },
    });
  });

  it("returns 404 when getting a missing client", async () => {
    mockFetchByUrl([{ match: "/admin/clients/none", result: { ok: false, status: 404 } }]);
    expect(await getClient({ client_id: "none" })).toMatchObject({ status: 404 });
  });

  it("creates a public client with PKCE (auth_method=none) and 201", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients", result: { ok: true, status: 201, json: { client_id: "app1" } } },
    ]);
    const res = await createClient({
      client_id: "app1",
      public: true,
      redirect_uris: ["https://app1/callback"],
      allowed_cors_origins: ["https://app1"],
    });
    expect(res.status).toBe(201);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toContain("authorization_code");
    expect(body.allowed_cors_origins).toEqual(["https://app1"]);
  });

  it("normalizes and deduplicates SPA browser origins", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients", result: { ok: true, status: 201, json: { client_id: "spa" } } },
    ]);
    const res = await createClient({
      client_id: "spa",
      client_type: "spa",
      redirect_uris: ["https://client.example/callback"],
      allowed_cors_origins: ["https://client.example/", " https://client.example "],
      metadata: {
        allowed_return_uris: ["https://client.example/account/security"],
      },
    });

    expect(res.status).toBe(201);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.allowed_cors_origins).toEqual(["https://client.example"]);
    expect(body.metadata.allowed_return_uris).toEqual([
      "https://client.example/account/security",
    ]);
  });

  it("rejects missing, wildcard, and path-based SPA browser origins", async () => {
    const fetchMock = mockFetchByUrl([]);
    const base = {
      client_id: "spa",
      client_type: "spa" as const,
      redirect_uris: ["https://client.example/callback"],
    };

    expect(await createClient(base)).toMatchObject({ status: 400 });
    expect(await createClient({ ...base, allowed_cors_origins: ["https://*.example.com"] })).toMatchObject({
      status: 400,
    });
    expect(await createClient({ ...base, allowed_cors_origins: ["https://client.example/callback"] })).toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-loopback HTTP origins in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await createClient({
        client_id: "spa",
        client_type: "spa",
        redirect_uris: ["https://client.example/callback"],
        allowed_cors_origins: ["http://localhost:4200"],
      });
      expect(res).toMatchObject({ status: 400 });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("creates a machine-to-machine client without redirect URIs", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients", result: { ok: true, status: 201, json: { client_id: "example-service" } } },
    ]);
    const res = await createClient({
      client_id: "example-service",
      client_name: "Example Service",
      client_type: "service",
      scope: "resource.read resource.write resource.manage",
      audience: ["example-api"],
    });

    expect(res.status).toBe(201);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      client_id: "example-service",
      client_name: "Example Service",
      grant_types: ["client_credentials"],
      response_types: ["code"],
      scope: "resource.read resource.write resource.manage",
      redirect_uris: [],
      post_logout_redirect_uris: [],
      audience: ["example-api"],
      token_endpoint_auth_method: "client_secret_basic",
      metadata: { client_type: "service" },
    });
  });

  it("rejects browser origins for non-browser client profiles", async () => {
    const fetchMock = mockFetchByUrl([]);
    const res = await createClient({
      client_id: "service-with-cors",
      client_type: "service",
      allowed_cors_origins: ["https://client.example"],
    });
    expect(res).toMatchObject({
      status: 400,
      body: { error: "allowed_cors_origins is only supported for SPA or custom clients" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires redirect URIs for interactive client profiles", async () => {
    const fetchMock = mockFetchByUrl([]);
    const res = await createClient({ client_id: "example-spa", client_type: "spa" });

    expect(res).toMatchObject({
      status: 400,
      body: { error: "redirect_uris must be a non-empty array" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults confidential clients to client_secret_basic", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients", result: { ok: true, status: 201, json: {} } },
    ]);
    await createClient({ client_id: "svc", redirect_uris: ["https://svc/cb"] });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("preserves remember_offline_access for first-party clients on create", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients", result: { ok: true, status: 201, json: {} } },
    ]);
    await createClient({
      client_id: "app1",
      redirect_uris: ["https://app1/cb"],
      metadata: {
        trust_tier: "first_party",
        consent_version: 1,
        remember_offline_access: true,
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.metadata).toMatchObject({
      trust_tier: "first_party",
      consent_version: 1,
      remember_offline_access: true,
    });
  });

  it("rejects remember_offline_access for non-first-party clients on create", async () => {
    const fetchMock = mockFetchByUrl([]);
    const res = await createClient({
      client_id: "partner-app",
      redirect_uris: ["https://partner/cb"],
      metadata: {
        trust_tier: "partner",
        consent_version: 1,
        remember_offline_access: true,
      },
    });

    expect(res).toMatchObject({
      status: 400,
      body: { error: "remember_offline_access is only allowed for first_party clients" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects creation with missing required fields (400)", async () => {
    mockFetchByUrl([]);
    expect(await createClient({ client_id: "x" })).toMatchObject({ status: 400 });
    expect(await createClient({ redirect_uris: ["https://x/cb"] })).toMatchObject({ status: 400 });
  });

  it("updates a client via PUT", async () => {
    mockFetchByUrl([{ match: "/admin/clients/app1", result: { ok: true, json: { client_id: "app1" } } }]);
    expect(await updateClient({ client_id: "app1", redirect_uris: ["https://app1/cb"] })).toMatchObject({
      status: 200,
    });
  });

  it("preserves custom protocol fields on update", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients/legacy", result: { ok: true, json: { client_id: "legacy" } } },
    ]);
    await updateClient({
      client_id: "legacy",
      client_type: "custom",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      redirect_uris: ["https://legacy/callback"],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      redirect_uris: ["https://legacy/callback"],
    });
  });

  it("preserves remember_offline_access for first-party clients on update", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/admin/clients/app1", result: { ok: true, json: { client_id: "app1" } } },
    ]);
    await updateClient({
      client_id: "app1",
      redirect_uris: ["https://app1/cb"],
      metadata: {
        trust_tier: "first_party",
        consent_version: 2,
        remember_offline_access: true,
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.metadata).toMatchObject({
      trust_tier: "first_party",
      consent_version: 2,
      remember_offline_access: true,
    });
  });

  it("rejects remember_offline_access for non-first-party clients on update", async () => {
    const fetchMock = mockFetchByUrl([]);
    const res = await updateClient({
      client_id: "third-party-app",
      redirect_uris: ["https://third-party/cb"],
      metadata: {
        trust_tier: "third_party",
        consent_version: 1,
        remember_offline_access: true,
      },
    });

    expect(res).toMatchObject({
      status: 400,
      body: { error: "remember_offline_access is only allowed for first_party clients" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects updates to the admin OAuth client", async () => {
    const fetchMock = mockFetchByUrl([]);
    expect(
      await updateClient({
        client_id: "idnest-admin-client",
        redirect_uris: ["https://admin-local.idnest.cloud/auth/callback"],
      }),
    ).toMatchObject({
      status: 403,
      body: { error: "The admin OAuth client cannot be edited" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when deleting a missing client", async () => {
    mockFetchByUrl([{ match: "/admin/clients/none", result: { ok: false, status: 404 } }]);
    expect(await deleteClient({ client_id: "none" })).toMatchObject({ status: 404 });
  });

  it("rejects deletion of the admin OAuth client", async () => {
    const fetchMock = mockFetchByUrl([]);
    expect(await deleteClient({ client_id: "idnest-admin-client" })).toMatchObject({
      status: 403,
      body: { error: "The admin OAuth client cannot be deleted" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
