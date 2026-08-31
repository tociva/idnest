import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAuthRuntimeConfiguration } from "../config";

const managedKeys = [
  "NODE_ENV",
  "HYDRA_ADMIN_URL",
  "KRATOS_ADMIN_URL",
  "AUTH_BRANDING_MODE",
  "AUTHZ_DATABASE_URL",
  "CONSENT_ACTION_SECRET",
  "AUTH_TRANSACTION_SECRET",
  "DELEGATION_ENABLED",
  "DELEGATION_TOKEN_ISSUER",
  "DELEGATION_BROKER_AUDIENCE",
  "DELEGATION_GRANT_TTL_SECONDS",
  "DELEGATION_SIGNING_KEY_ID",
  "DELEGATION_SIGNING_PRIVATE_KEY_B64",
] as const;
const original = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of managedKeys) original.set(key, process.env[key]);
  process.env.NODE_ENV = "production";
  process.env.HYDRA_ADMIN_URL = "http://hydra:4445";
  process.env.KRATOS_ADMIN_URL = "http://kratos:4434";
  process.env.AUTH_BRANDING_MODE = "off";
  process.env.AUTHZ_DATABASE_URL = "postgres://authz:test@db:5432/authz";
  process.env.CONSENT_ACTION_SECRET = "c".repeat(32);
  process.env.AUTH_TRANSACTION_SECRET = "t".repeat(32);
  process.env.DELEGATION_TOKEN_ISSUER = "https://identity.example.test/delegation";
  process.env.DELEGATION_BROKER_AUDIENCE = "urn:idnest:delegation";
  process.env.DELEGATION_GRANT_TTL_SECONDS = "60";
  process.env.DELEGATION_SIGNING_KEY_ID = "test-key-1";
});

afterEach(() => {
  for (const key of managedKeys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
});

function privateKey(curve: "prime256v1" | "secp384r1"): string {
  const { privateKey: value } = generateKeyPairSync("ec", {
    namedCurve: curve,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return Buffer.from(value, "utf8").toString("base64");
}

describe("delegation runtime configuration", () => {
  it("does not require a delegation key while the broker is disabled", () => {
    process.env.DELEGATION_ENABLED = "false";
    delete process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64;
    expect(() => validateAuthRuntimeConfiguration()).not.toThrow();
  });

  it("accepts a dedicated P-256 signing key while enabled", () => {
    process.env.DELEGATION_ENABLED = "true";
    process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64 = privateKey("prime256v1");
    expect(() => validateAuthRuntimeConfiguration()).not.toThrow();
  });

  it("rejects a signing key on the wrong elliptic curve", () => {
    process.env.DELEGATION_ENABLED = "true";
    process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64 = privateKey("secp384r1");
    expect(() => validateAuthRuntimeConfiguration()).toThrow(/P-256/);
  });
});
