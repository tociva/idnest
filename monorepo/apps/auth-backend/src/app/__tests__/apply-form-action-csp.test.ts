import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { KratosFlow } from "@idnest/shared-types";

const storeMocks = vi.hoisted(() => ({
  findAuthConsentTransactionByTokenHash: vi.fn(),
  findAuthTransactionByTokenHash: vi.fn(),
  getAuthzPool: vi.fn(),
}));

const hydraMocks = vi.hoisted(() => ({
  getHydraClient: vi.fn(),
}));

const kratosMocks = vi.hoisted(() => ({
  getLoginFlow: vi.fn(),
}));

vi.mock("@idnest/authz-store", () => storeMocks);
vi.mock("../hydra-admin", () => hydraMocks);
vi.mock("../kratos-public", () => kratosMocks);

import { applyHtmlFormActionCsp, clientOriginsFromLoginFlow } from "../apply-form-action-csp";

const originalEnv = { ...process.env };

const boundFlow: KratosFlow = {
  id: "flow-1",
  ui: {
    action: "https://kratos-dev.idnest.cloud/self-service/login?flow=flow-1",
    method: "POST",
    nodes: [],
  },
  return_to: "https://auth-dev.idnest.cloud/oauth2/login/complete?transaction=tok-123",
};

beforeEach(() => {
  process.env.AUTH_BASE_URL = "https://auth-dev.idnest.cloud";
  process.env.AUTHZ_DATABASE_URL = "postgres://authz:test@db.invalid:5432/authz";
  process.env.KRATOS_PUBLIC_URL = "https://kratos-dev.idnest.cloud";
  process.env.HYDRA_ADMIN_URL = "https://hydra-dev.idnest.cloud:4445";
  process.env.HYDRA_URLS_SELF_ISSUER = "https://hydra-dev.idnest.cloud/";
  process.env.AUTH_RETURN_TO_ALLOWED_ORIGINS = "https://admin-dev.idnest.cloud";
  storeMocks.getAuthzPool.mockReturnValue({});
  storeMocks.findAuthTransactionByTokenHash.mockResolvedValue({
    hydra_client_id: "dsa-app",
  });
  hydraMocks.getHydraClient.mockResolvedValue({
    client_id: "dsa-app",
    redirect_uris: ["https://app-dev.digitalsmartads.com/auth/callback"],
  });
  kratosMocks.getLoginFlow.mockResolvedValue(boundFlow);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("apply form-action CSP", () => {
  it("resolves the bound Hydra client's redirect origin from a login flow", async () => {
    await expect(clientOriginsFromLoginFlow(boundFlow)).resolves.toEqual([
      "https://app-dev.digitalsmartads.com",
    ]);
  });

  it("sets form-action with the client origin on SPA login HTML", async () => {
    const headers: Record<string, string> = {};
    const req = {
      path: "/auth/login",
      query: { flow: "flow-1" },
    } as unknown as Request;
    const res = {
      set(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
    } as unknown as Response;

    await applyHtmlFormActionCsp(req, res);

    const csp = headers["content-security-policy"];
    expect(csp).toContain("form-action");
    expect(csp).toContain("https://app-dev.digitalsmartads.com");
    expect(csp).toContain("https://accounts.google.com");
    expect(csp).toContain("https://hydra-dev.idnest.cloud");
    expect(csp).not.toContain(":4445");
    expect(csp).not.toContain("https://admin-dev.idnest.cloud");
  });

  it("keeps platform-only CSP when the login flow is not bound to a Hydra client", async () => {
    const headers: Record<string, string> = {};
    kratosMocks.getLoginFlow.mockResolvedValue({
      ...boundFlow,
      return_to: "https://auth-dev.idnest.cloud/settings",
    });
    const req = {
      path: "/auth/login",
      query: { flow: "flow-1" },
    } as unknown as Request;
    const res = {
      set(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
    } as unknown as Response;

    await applyHtmlFormActionCsp(req, res);

    expect(headers["content-security-policy"]).toContain("form-action");
    expect(headers["content-security-policy"]).not.toContain("https://app-dev.digitalsmartads.com");
    expect(hydraMocks.getHydraClient).not.toHaveBeenCalled();
  });
});
