import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delegationDiscoveryDocument } from "../delegation-router";

const original = new Map<string, string | undefined>();

beforeEach(() => {
  original.set("AUTH_BASE_URL", process.env.AUTH_BASE_URL);
  original.set("DELEGATION_TOKEN_ISSUER", process.env.DELEGATION_TOKEN_ISSUER);
});

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
});

describe("delegation discovery", () => {
  it("advertises the structured-context v2 contract", () => {
    process.env.AUTH_BASE_URL = "https://identity.example.test";
    process.env.DELEGATION_TOKEN_ISSUER = "https://identity.example.test/delegation";

    expect(delegationDiscoveryDocument()).toMatchObject({
      issuer: "https://identity.example.test/delegation",
      jwks_uri: "https://identity.example.test/auth/v1/delegation/jwks",
      delegated_access_signing_alg_values_supported: ["ES256"],
      idnest_delegation_contract_version: 2,
      authorization_details_types_supported: ["urn:idnest:delegation"],
      authorization_context_formats_supported: ["json-object"],
    });
  });
});
