import { describe, expect, it } from "vitest";
import type { AdminIdentity } from "../auth/authorize";
import {
  createCsrfToken,
  isAllowedOrigin,
  requireAdminCsrf,
  verifyCsrfToken,
} from "../auth/csrf";

const identity: AdminIdentity = {
  id: "u1",
  traits: { email: "admin@example.com" },
};

describe("admin csrf", () => {
  it("allows only configured origins after normalization", () => {
    expect(isAllowedOrigin("https://admin-local.idnest.cloud/page", ["https://admin-local.idnest.cloud"])).toBe(
      true,
    );
    expect(isAllowedOrigin("https://client.example", ["https://admin-local.idnest.cloud"])).toBe(
      false,
    );
    expect(isAllowedOrigin(undefined, ["https://admin-local.idnest.cloud"])).toBe(false);
  });

  it("allows configured wildcard origins", () => {
    expect(isAllowedOrigin("https://admin.idnest.cloud/page", ["https://*.idnest.cloud"])).toBe(true);
    expect(isAllowedOrigin("https://client.example", ["https://*.idnest.cloud"])).toBe(false);
  });

  it("creates and verifies a token bound to the identity and email", () => {
    const token = createCsrfToken(identity, "Admin@Example.COM", "secret", 1000);
    expect(verifyCsrfToken(token, identity, "admin@example.com", "secret", 1000)).toBe(true);
  });

  it("rejects tampered tokens", () => {
    const token = createCsrfToken(identity, "admin@example.com", "secret", 1000);
    expect(verifyCsrfToken(`${token}x`, identity, "admin@example.com", "secret", 1000)).toBe(false);
  });

  it("rejects tokens for another identity", () => {
    const token = createCsrfToken(identity, "admin@example.com", "secret", 1000);
    expect(
      verifyCsrfToken(token, { id: "u2", traits: { email: "admin@example.com" } }, "admin@example.com", "secret", 1000),
    ).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = createCsrfToken(identity, "admin@example.com", "secret", 1000);
    expect(verifyCsrfToken(token, identity, "admin@example.com", "secret", 3 * 60 * 60 * 1000)).toBe(
      false,
    );
  });

  it("allows unsafe session requests from an allowed origin with X-Admin-CSRF", () => {
    process.env.ADMIN_CORS_ALLOWED_ORIGINS = "https://*.idnest.cloud";
    const token = createCsrfToken(identity, "admin@example.com", "secret");
    process.env.ADMIN_CSRF_SECRET = "secret";
    let statusCode = 0;
    let body: unknown;
    const req = {
      method: "POST",
      adminIdentity: identity,
      adminEmail: "admin@example.com",
      get: (name: string) =>
        name.toLowerCase() === "origin"
          ? "https://admin-local.idnest.cloud/page"
          : name.toLowerCase() === "x-admin-csrf"
            ? token
            : undefined,
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    let called = false;

    requireAdminCsrf()(req as never, res as never, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(statusCode).toBe(0);
    expect(body).toBeUndefined();
    delete process.env.ADMIN_CORS_ALLOWED_ORIGINS;
    delete process.env.ADMIN_CSRF_SECRET;
  });

  it("rejects unsafe session requests without X-Admin-CSRF", () => {
    process.env.ADMIN_CORS_ALLOWED_ORIGINS = "https://admin-local.idnest.cloud";
    let statusCode = 0;
    let body: unknown;
    const req = {
      method: "POST",
      adminIdentity: identity,
      adminEmail: "admin@example.com",
      get: (name: string) =>
        name.toLowerCase() === "origin" ? "https://admin-local.idnest.cloud" : undefined,
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    let called = false;

    requireAdminCsrf()(req as never, res as never, () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: "Invalid CSRF token" });
    delete process.env.ADMIN_CORS_ALLOWED_ORIGINS;
  });

  it("rejects unsafe session requests from a disallowed origin", () => {
    process.env.ADMIN_CORS_ALLOWED_ORIGINS = "https://admin-local.idnest.cloud";
    let statusCode = 0;
    let body: unknown;
    const req = {
      method: "POST",
      adminIdentity: identity,
      adminEmail: "admin@example.com",
      get: (name: string) =>
        name.toLowerCase() === "origin" ? "https://client.example" : undefined,
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    let called = false;

    requireAdminCsrf()(req as never, res as never, () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: "Invalid origin" });
    delete process.env.ADMIN_CORS_ALLOWED_ORIGINS;
  });
});
