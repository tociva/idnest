import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { Es256DelegationTokenSigner } from "../delegation-token";

afterEach(() => {
  delete process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64;
  delete process.env.DELEGATION_SIGNING_KEY_ID;
  delete process.env.DELEGATION_TOKEN_ISSUER;
});

describe("delegated access token signing", () => {
  it("issues a short-lived ES256 at+jwt with subject, actor, audience, and grant claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    process.env.DELEGATION_SIGNING_PRIVATE_KEY_B64 = Buffer.from(
      await exportPKCS8(privateKey),
      "utf8",
    ).toString("base64");
    process.env.DELEGATION_SIGNING_KEY_ID = "test-key-1";
    process.env.DELEGATION_TOKEN_ISSUER = "https://identity.example.test/delegation";

    const signer = new Es256DelegationTokenSigner();
    const token = await signer.sign({
      subject: "opaque-subject",
      audience: "https://api.example.test/ledger",
      actorClientId: "automation-client",
      scopes: ["records:read"],
      grantId: "grant-1",
      authorizationContext: "opaque-installation-reference",
      ttlSeconds: 120,
    });

    const verified = await jwtVerify(token, publicKey, {
      issuer: "https://identity.example.test/delegation",
      audience: "https://api.example.test/ledger",
    });
    expect(verified.protectedHeader).toMatchObject({
      alg: "ES256",
      kid: "test-key-1",
      typ: "at+jwt",
    });
    expect(verified.payload).toMatchObject({
      sub: "opaque-subject",
      client_id: "automation-client",
      act: { sub: "automation-client" },
      scope: "records:read",
      authorization_details: [{
        type: "urn:idnest:delegation",
        grant_id: "grant-1",
        context: "opaque-installation-reference",
      }],
    });
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(120);

    const jwks = await signer.jwks();
    expect(jwks.keys[0]).toMatchObject({ kid: "test-key-1", alg: "ES256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});
