import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ADMIN_ROLE, type AdminSession, type ClientAccessGrant, type Db } from "@idnest/authz-store";
import { authorize, type AdminIdentity } from "../auth/authorize";
import { mockFetchByUrl } from "./helpers";

const KRATOS_ADMIN = "http://kratos:4434";

function adminIdentity(identity: Partial<AdminIdentity> = {}): AdminIdentity {
  return {
    id: "u1",
    traits: { name: "A", email: "admin@example.com" },
    verifiable_addresses: [{ value: "admin@example.com", verified: true, via: "email" }],
    ...identity,
  };
}

function adminSession(session: Partial<AdminSession> = {}): AdminSession {
  return {
    id: "s1",
    identity_id: "u1",
    client_id: "idnest-admin-client",
    role: SYSTEM_ADMIN_ROLE,
    email: "admin@example.com",
    created_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T08:00:00.000Z",
    idle_expires_at: "2026-01-01T00:30:00.000Z",
    revoked_at: null,
    ...session,
  };
}

function adminGrant(grant: Partial<ClientAccessGrant> = {}): ClientAccessGrant {
  return {
    id: "g1",
    identity_id: "u1",
    client_id: "idnest-admin-client",
    role: SYSTEM_ADMIN_ROLE,
    granted_by: "seed",
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    ...grant,
  };
}

function dbWith(input: { session?: AdminSession | null; grant?: ClientAccessGrant | null }): Db {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE admin_sessions")) {
        return { rows: input.session ? [input.session] : [], rowCount: input.session ? 1 : 0 };
      }
      if (sql.includes("FROM client_access_grants")) {
        return { rows: input.grant ? [input.grant] : [], rowCount: input.grant ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Db;
}

const cfg = (db?: Db) => ({
  kratosAdminUrl: KRATOS_ADMIN,
  authzDatabaseUrl: db ? "" : "",
  db,
  adminOidcClientId: "idnest-admin-client",
  adminSessionIdleTtlSeconds: 1800,
});

afterEach(() => vi.unstubAllGlobals());

describe("authorize (admin BFF session authorization)", () => {
  it("rejects requests without an admin session cookie", async () => {
    const res = await authorize(cfg(dbWith({ session: adminSession(), grant: adminGrant() })));
    expect(res).toMatchObject({ ok: false, status: 401, error: "Missing admin session" });
  });

  it("rejects when the admin session store is unavailable", async () => {
    const res = await authorize(cfg(), "session-token");
    expect(res).toMatchObject({ ok: false, status: 401, error: "Admin session store is not configured" });
  });

  it("rejects expired or revoked sessions", async () => {
    const res = await authorize(cfg(dbWith({ session: null, grant: adminGrant() })), "session-token");
    expect(res).toMatchObject({ ok: false, status: 401, error: "Invalid or expired admin session" });
  });

  it("rejects sessions for the wrong client", async () => {
    const res = await authorize(
      cfg(dbWith({ session: adminSession({ client_id: "example-user-client" }), grant: adminGrant() })),
      "session-token",
    );
    expect(res).toMatchObject({ ok: false, status: 403, error: "Invalid admin session client" });
  });

  it("rejects inactive Kratos identities", async () => {
    mockFetchByUrl([
      { match: "/identities/u1", result: { ok: true, json: adminIdentity({ state: "inactive" }) } },
    ]);
    const res = await authorize(
      cfg(dbWith({ session: adminSession(), grant: adminGrant() })),
      "session-token",
    );
    expect(res).toMatchObject({ ok: false, status: 403, error: "Identity is inactive" });
  });

  it("rejects unverified email identities", async () => {
    mockFetchByUrl([
      {
        match: "/identities/u1",
        result: {
          ok: true,
          json: adminIdentity({ verifiable_addresses: [{ value: "admin@example.com", verified: false }] }),
        },
      },
    ]);
    const res = await authorize(
      cfg(dbWith({ session: adminSession(), grant: adminGrant() })),
      "session-token",
    );
    expect(res).toMatchObject({ ok: false, status: 403, error: "Email not verified" });
  });

  it("rejects identities without an active system-admin grant", async () => {
    mockFetchByUrl([
      { match: "/identities/u1", result: { ok: true, json: adminIdentity() } },
    ]);
    const res = await authorize(
      cfg(dbWith({ session: adminSession(), grant: adminGrant({ role: "user" }) })),
      "session-token",
    );
    expect(res).toMatchObject({ ok: false, status: 403, error: "Not authorized" });
  });

  it("allows valid sessions for identities with an active system-admin grant", async () => {
    mockFetchByUrl([
      { match: "/identities/u1", result: { ok: true, json: adminIdentity() } },
    ]);
    const res = await authorize(
      cfg(dbWith({ session: adminSession(), grant: adminGrant() })),
      "session-token",
    );
    expect(res).toMatchObject({
      ok: true,
      authMode: "bff-session",
      email: "admin@example.com",
      role: SYSTEM_ADMIN_ROLE,
    });
  });
});
