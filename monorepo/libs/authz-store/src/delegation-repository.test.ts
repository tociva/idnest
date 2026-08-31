import { describe, expect, it } from "vitest";
import type { Db } from "./db";
import {
  consumeDelegationGrant,
  createDelegationGrant,
  createDelegationResource,
  upsertDelegationActorPolicy,
} from "./delegation-repository";

describe("delegation repository", () => {
  it("creates product-neutral resources with an immutable history snapshot", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return {
          rows: [{
            id: "r1",
            resource_key: values[0],
            display_name: values[1],
            audience: values[2],
            authorizer_client_id: values[3],
            allowed_scopes: values[4],
            token_ttl_seconds: values[5],
            authorization_context_required: values[6],
            status: values[7],
            version: 1,
            created_at: "now",
            updated_at: "now",
          }],
        };
      },
    } as unknown as Db;

    const resource = await createDelegationResource(db, {
      status: "active",
      definition: {
        key: "ledger-api",
        displayName: "Ledger API",
        audience: "https://api.example.test/ledger",
        authorizerClientId: "resource-authorizer",
        allowedScopes: ["records:read"],
        tokenTtlSeconds: 180,
        authorizationContextRequired: true,
      },
      actor: "admin-1",
    });

    expect(resource.definition.key).toBe("ledger-api");
    expect(calls[0].sql).toContain("delegation_resource_versions");
    expect(calls[0].values[9]).toBe("admin-1");
  });

  it("versions actor policy updates", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return {
          rows: [{
            id: "p1",
            resource_id: values[0],
            actor_client_id: values[1],
            allowed_scopes: values[2],
            status: values[3],
            version: 2,
            created_at: "then",
            updated_at: "now",
          }],
        };
      },
    } as unknown as Db;

    const policy = await upsertDelegationActorPolicy(db, {
      resourceId: "r1",
      status: "active",
      definition: { actorClientId: "automation-client", allowedScopes: ["records:read"] },
      actor: "admin-1",
    });

    expect(policy.version).toBe(2);
    expect(calls[0].sql).toContain("ON CONFLICT (resource_id, actor_client_id)");
    expect(calls[0].sql).toContain("delegation_actor_policy_versions");
  });

  it("persists only the supplied exchange-token hash", async () => {
    const valuesSeen: unknown[][] = [];
    const db = {
      query: async (_sql: string, values: unknown[]) => {
        valuesSeen.push(values);
        return {
          rows: [{
            id: "g1",
            resource_id: "r1",
            resource_key: "",
            audience: "",
            authorizer_client_id: "resource-authorizer",
            actor_client_id: "automation-client",
            subject_id: "subject-1",
            scopes: ["records:read"],
            authorization_context: null,
            correlation_id: null,
            token_ttl_seconds: 0,
            expires_at: "later",
            consumed_at: null,
            revoked_at: null,
            revoked_by: null,
            created_at: "now",
          }],
        };
      },
    } as unknown as Db;

    await createDelegationGrant(db, {
      tokenHash: "sha256-value",
      resourceId: "r1",
      resourceAudience: "https://api.example.test/ledger",
      authorizerClientId: "resource-authorizer",
      actorClientId: "automation-client",
      subjectId: "subject-1",
      scopes: ["records:read"],
      ttlSeconds: 60,
      tokenTtlSeconds: 180,
    });

    expect(valuesSeen[0][0]).toBe("sha256-value");
    expect(valuesSeen[0]).not.toContain("raw-exchange-token");
  });

  it("atomically consumes one active grant for its bound actor", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      },
    } as unknown as Db;

    expect(await consumeDelegationGrant(db, {
      tokenHash: "sha256-value",
      actorClientId: "automation-client",
    })).toBeNull();

    expect(calls[0].sql).toContain("g.consumed_at IS NULL");
    expect(calls[0].sql).toContain("g.expires_at > now()");
    expect(calls[0].sql).toContain("r.audience = g.resource_audience");
    expect(calls[0].sql).toContain("g.scopes <@ p.allowed_scopes");
    expect(calls[0].values).toEqual(["sha256-value", "automation-client"]);
  });
});
