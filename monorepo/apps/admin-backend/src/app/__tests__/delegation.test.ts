import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetchByUrl } from "./helpers";

const store = vi.hoisted(() => ({
  getAuthzPool: vi.fn(() => ({ query: vi.fn() })),
  listDelegationResources: vi.fn(async () => []),
  getDelegationResource: vi.fn(),
  listDelegationResourceVersions: vi.fn(async () => []),
  createDelegationResource: vi.fn(),
  updateDelegationResource: vi.fn(),
  listDelegationActorPolicies: vi.fn(async () => []),
  upsertDelegationActorPolicy: vi.fn(),
  archiveDelegationActorPolicy: vi.fn(async () => true),
  listDelegationGrants: vi.fn(async () => []),
  listDelegationAuditEvents: vi.fn(async () => []),
  revokeDelegationGrantByAdministrator: vi.fn(async () => true),
  appendDelegationAuditEvent: vi.fn(async () => ({})),
}));

vi.mock("@idnest/authz-store", () => store);

import {
  createDelegationResourceConfiguration,
  putDelegationActorPolicyConfiguration,
  revokeDelegationGrantAsAdministrator,
} from "../handlers/delegation";

const resourceId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const resource = {
  id: resourceId,
  status: "active" as const,
  version: 1,
  definition: {
    key: "ledger-api",
    displayName: "Ledger API",
    audience: "https://api.example.test/ledger",
    authorizerClientId: "resource-authorizer",
    allowedScopes: ["records:read"],
    tokenTtlSeconds: 180,
    authorizationContextRequired: true,
  },
  created_at: "then",
  updated_at: "now",
};

beforeEach(() => {
  process.env.AUTHZ_DATABASE_URL = "postgres://authz";
  process.env.HYDRA_ADMIN_URL = "http://hydra:4445";
  process.env.DELEGATION_BROKER_AUDIENCE = "urn:idnest:delegation";
  store.getDelegationResource.mockResolvedValue(resource);
  store.createDelegationResource.mockResolvedValue(resource);
  store.upsertDelegationActorPolicy.mockResolvedValue({
    id: "policy-1",
    resource_id: resourceId,
    status: "active",
    version: 1,
    definition: { actorClientId: "automation-client", allowedScopes: ["records:read"] },
    created_at: "now",
    updated_at: "now",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.AUTHZ_DATABASE_URL;
  delete process.env.HYDRA_ADMIN_URL;
  delete process.env.DELEGATION_BROKER_AUDIENCE;
});

describe("delegation administration", () => {
  it("creates a generic resource after checking its Hydra authorizer client", async () => {
    const fetchMock = mockFetchByUrl([{ match: "/admin/clients/resource-authorizer", result: {
      ok: true,
      json: {
        client_id: "resource-authorizer",
        grant_types: ["client_credentials"],
        scope: "delegation.grant",
        audience: ["urn:idnest:delegation"],
      },
    } }]);

    const result = await createDelegationResourceConfiguration({
      actor: "admin-1",
      body: { status: "active", definition: resource.definition },
    });

    expect(result).toMatchObject({ status: 201, body: resource });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://hydra:4445/admin/clients/resource-authorizer",
      expect.anything(),
    );
    expect(store.createDelegationResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: "admin-1", definition: resource.definition }),
    );
  });

  it("rejects invalid scopes before writing configuration", async () => {
    const result = await createDelegationResourceConfiguration({
      body: {
        definition: { ...resource.definition, allowedScopes: ["not a valid scope"] },
      },
    });
    expect(result).toMatchObject({ status: 400 });
    expect(store.createDelegationResource).not.toHaveBeenCalled();
  });

  it("checks actor service capability and enforces resource scope subsets", async () => {
    mockFetchByUrl([{ match: "/admin/clients/automation-client", result: {
      ok: true,
      json: {
        client_id: "automation-client",
        grant_types: ["client_credentials"],
        scope: "delegation.exchange",
        audience: ["urn:idnest:delegation"],
      },
    } }]);
    const accepted = await putDelegationActorPolicyConfiguration({
      id: resourceId,
      clientId: "automation-client",
      actor: "admin-1",
      body: {
        status: "active",
        definition: { allowedScopes: ["records:read"] },
      },
    });
    expect(accepted.status).toBe(200);
    expect(store.upsertDelegationActorPolicy).toHaveBeenCalled();

    const rejected = await putDelegationActorPolicyConfiguration({
      id: resourceId,
      clientId: "automation-client",
      body: {
        status: "active",
        definition: { allowedScopes: ["records:write"] },
      },
    });
    expect(rejected).toMatchObject({
      status: 400,
      body: { error: "Actor policy scopes must be a subset of the resource scopes" },
    });
  });

  it("revokes pending grants and writes an administrator audit event", async () => {
    const result = await revokeDelegationGrantAsAdministrator({
      grantId,
      actor: "admin-1",
    });
    expect(result).toEqual({ status: 200, body: { revoked: true, id: grantId } });
    expect(store.revokeDelegationGrantByAdministrator).toHaveBeenCalledWith(
      expect.anything(),
      { grantId, revokedBy: "admin-1" },
    );
    expect(store.appendDelegationAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "grant.admin-revoked" }),
    );
  });
});
