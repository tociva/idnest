import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introspectDelegationServiceToken } from "../delegation-hydra";
import { mockFetchByUrl } from "./helpers";

beforeEach(() => {
  process.env.HYDRA_ADMIN_URL = "http://hydra:4445";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HYDRA_ADMIN_URL;
});

describe("Hydra delegation service-token introspection", () => {
  it("normalizes the authenticated service client, scopes, and audiences", async () => {
    const fetchMock = mockFetchByUrl([{ match: "/admin/oauth2/introspect", result: {
      ok: true,
      json: {
        active: true,
        client_id: "automation-client",
        scope: "delegation.exchange records:read",
        aud: ["urn:idnest:delegation"],
        token_use: "access_token",
      },
    } }]);

    await expect(introspectDelegationServiceToken("service-token")).resolves.toEqual({
      clientId: "automation-client",
      scopes: ["delegation.exchange", "records:read"],
      audiences: ["urn:idnest:delegation"],
    });
    const request = fetchMock.mock.calls[0][1];
    expect(String(request?.body)).toBe("token=service-token");
  });

  it("rejects inactive and non-access tokens", async () => {
    mockFetchByUrl([{ match: "/admin/oauth2/introspect", result: {
      ok: true,
      json: { active: false, client_id: "automation-client" },
    } }]);
    await expect(introspectDelegationServiceToken("inactive")).resolves.toBeNull();

    vi.unstubAllGlobals();
    mockFetchByUrl([{ match: "/admin/oauth2/introspect", result: {
      ok: true,
      json: { active: true, client_id: "automation-client", token_use: "refresh_token" },
    } }]);
    await expect(introspectDelegationServiceToken("wrong-use")).resolves.toBeNull();
  });

  it("fails closed when private introspection is unavailable", async () => {
    mockFetchByUrl([{ match: "/admin/oauth2/introspect", result: {
      ok: false,
      status: 503,
    } }]);
    await expect(introspectDelegationServiceToken("service-token")).rejects.toThrow(/503/);
  });
});
