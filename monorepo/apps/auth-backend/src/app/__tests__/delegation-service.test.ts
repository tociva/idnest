import type {
  Db,
  DelegationActorPolicyRecord,
  DelegationGrantRecord,
  DelegationResourceRecord,
} from "@idnest/authz-store";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeDelegationGrant,
  issueDelegationGrant,
  type DelegationServiceDependencies,
  type DelegationStore,
} from "../delegation-service";
import type { DelegationTokenSigner, DelegatedTokenInput } from "../delegation-token";

const resource: DelegationResourceRecord = {
  id: "resource-1",
  status: "active",
  version: 1,
  definition: {
    key: "ledger-api",
    displayName: "Ledger API",
    audience: "https://api.example.test/ledger",
    authorizerClientId: "resource-authorizer",
    allowedScopes: ["records:read", "records:write"],
    tokenTtlSeconds: 180,
    authorizationContextRequired: true,
  },
  created_at: "then",
  updated_at: "now",
};

const policy: DelegationActorPolicyRecord = {
  id: "policy-1",
  resource_id: resource.id,
  status: "active",
  version: 1,
  definition: {
    actorClientId: "automation-client",
    allowedScopes: ["records:read"],
  },
  created_at: "then",
  updated_at: "now",
};

const grant: DelegationGrantRecord = {
  id: "grant-1",
  resource_id: resource.id,
  resource_key: resource.definition.key,
  audience: resource.definition.audience,
  authorizer_client_id: resource.definition.authorizerClientId,
  actor_client_id: policy.definition.actorClientId,
  subject_id: "subject-1",
  scopes: ["records:read"],
  authorization_context: "opaque-installation-reference",
  correlation_id: "request-1",
  token_ttl_seconds: 180,
  expires_at: "later",
  consumed_at: null,
  revoked_at: null,
  revoked_by: null,
  created_at: "now",
};

function setup(overrides: Partial<DelegationStore> = {}) {
  const store: DelegationStore = {
    findResource: vi.fn(async () => resource),
    findActorPolicy: vi.fn(async () => policy),
    createGrant: vi.fn(async () => grant),
    consumeGrant: vi.fn(async () => grant),
    revokeGrant: vi.fn(async () => true),
    appendAudit: vi.fn(async () => undefined),
    ...overrides,
  };
  const signed: DelegatedTokenInput[] = [];
  const signer: DelegationTokenSigner = {
    sign: vi.fn(async (input) => {
      signed.push(input);
      return "signed-access-token";
    }),
    jwks: vi.fn(async () => ({ keys: [] })),
  };
  const dependencies: DelegationServiceDependencies = {
    transaction: async (work) => work({} as Db),
    signer,
    brokerAudience: "urn:idnest:delegation",
    grantTtlSeconds: 60,
    store,
    createExchangeToken: () => "raw-exchange-token",
    hashExchangeToken: (token) => `hash:${token}`,
  };
  return { dependencies, store, signed };
}

const authorizer = {
  clientId: "resource-authorizer",
  audiences: ["urn:idnest:delegation"],
  scopes: ["delegation.grant"],
};

const actor = {
  clientId: "automation-client",
  audiences: ["urn:idnest:delegation"],
  scopes: ["delegation.exchange"],
};

describe("delegation broker service", () => {
  it("issues a one-time grant bound to resource, actor, subject, and scopes", async () => {
    const { dependencies, store } = setup();
    const result = await issueDelegationGrant(dependencies, authorizer, {
      resource: "ledger-api",
      subject: "subject-1",
      actorClientId: "automation-client",
      scope: "records:read",
      authorizationContext: "opaque-installation-reference",
      correlationId: "request-1",
    });

    expect(result).toEqual({
      grantId: "grant-1",
      exchangeToken: "raw-exchange-token",
      expiresIn: 60,
    });
    expect(store.createGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tokenHash: "hash:raw-exchange-token",
      resourceAudience: "https://api.example.test/ledger",
      actorClientId: "automation-client",
      subjectId: "subject-1",
      scopes: ["records:read"],
      tokenTtlSeconds: 180,
    }));
    expect(store.appendAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "grant.issued",
      result: "success",
    }));
  });

  it("rejects an authorizer that does not own the resource", async () => {
    const { dependencies, store } = setup();
    await expect(issueDelegationGrant(dependencies, {
      ...authorizer,
      clientId: "different-authorizer",
    }, {
      resource: "ledger-api",
      subject: "subject-1",
      actorClientId: "automation-client",
      scope: "records:read",
      authorizationContext: "opaque-reference",
    })).rejects.toMatchObject({ error: "access_denied", status: 403 });
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("requires opaque authorization context when configured", async () => {
    const { dependencies } = setup();
    await expect(issueDelegationGrant(dependencies, authorizer, {
      resource: "ledger-api",
      subject: "subject-1",
      actorClientId: "automation-client",
      scope: "records:read",
    })).rejects.toMatchObject({ error: "invalid_request", status: 400 });
  });

  it("prevents actor policies from expanding resource scopes", async () => {
    const { dependencies } = setup();
    await expect(issueDelegationGrant(dependencies, authorizer, {
      resource: "ledger-api",
      subject: "subject-1",
      actorClientId: "automation-client",
      scope: "records:write",
      authorizationContext: "opaque-reference",
    })).rejects.toMatchObject({ error: "access_denied", status: 403 });
  });

  it("exchanges a grant once and supports scope reduction", async () => {
    const { dependencies, store, signed } = setup();
    const result = await exchangeDelegationGrant(dependencies, actor, {
      subjectToken: "raw-exchange-token",
      resource: resource.definition.audience,
      scope: "records:read",
    });

    expect(store.consumeGrant).toHaveBeenCalledWith(expect.anything(), {
      tokenHash: "hash:raw-exchange-token",
      actorClientId: "automation-client",
    });
    expect(signed[0]).toEqual({
      subject: "subject-1",
      audience: resource.definition.audience,
      actorClientId: "automation-client",
      scopes: ["records:read"],
      grantId: "grant-1",
      authorizationContext: "opaque-installation-reference",
      ttlSeconds: 180,
    });
    expect(result.access_token).toBe("signed-access-token");
    expect(result.expires_in).toBe(180);
  });

  it("returns invalid_grant for expired, revoked, replayed, or wrong-actor grants", async () => {
    const { dependencies } = setup({ consumeGrant: vi.fn(async () => null) });
    await expect(exchangeDelegationGrant(dependencies, actor, {
      subjectToken: "unusable-token",
    })).rejects.toMatchObject({ error: "invalid_grant", status: 400 });
  });

  it("requires a service token with the broker audience and operation scope", async () => {
    const { dependencies } = setup();
    await expect(exchangeDelegationGrant(dependencies, {
      ...actor,
      audiences: ["some-other-api"],
    }, { subjectToken: "token" })).rejects.toMatchObject({
      error: "insufficient_scope",
      status: 403,
    });
    await expect(exchangeDelegationGrant(dependencies, {
      ...actor,
      scopes: [],
    }, { subjectToken: "token" })).rejects.toMatchObject({
      error: "insufficient_scope",
      status: 403,
    });
  });
});
