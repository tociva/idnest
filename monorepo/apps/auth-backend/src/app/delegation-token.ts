import type { DelegatedAccessTokenClaims } from "@idnest/shared-types";
import { importPKCS8, SignJWT, type JWK } from "jose";
import { createPublicKey, randomUUID } from "node:crypto";
import {
  getDelegationIssuer,
  getDelegationSigningKeyId,
  getDelegationSigningPrivateKey,
} from "./config";

export interface DelegatedTokenInput {
  subject: string;
  audience: string;
  actorClientId: string;
  scopes: string[];
  grantId: string;
  authorizationContext?: string | null;
  ttlSeconds: number;
}

export interface DelegationTokenSigner {
  sign(input: DelegatedTokenInput): Promise<string>;
  jwks(): Promise<{ keys: JWK[] }>;
}

export class Es256DelegationTokenSigner implements DelegationTokenSigner {
  private keyPromise: ReturnType<typeof importPKCS8> | null = null;

  private key(): ReturnType<typeof importPKCS8> {
    const pem = getDelegationSigningPrivateKey();
    if (!pem) throw new Error("Delegation signing key is not configured");
    this.keyPromise ??= importPKCS8(pem, "ES256");
    return this.keyPromise;
  }

  async sign(input: DelegatedTokenInput): Promise<string> {
    const issuer = getDelegationIssuer();
    const now = Math.floor(Date.now() / 1000);
    const details = {
      type: "urn:idnest:delegation" as const,
      grant_id: input.grantId,
      ...(input.authorizationContext ? { context: input.authorizationContext } : {}),
    };
    const claims: Omit<DelegatedAccessTokenClaims, "iss" | "sub" | "aud" | "iat" | "nbf" | "exp" | "jti"> = {
      client_id: input.actorClientId,
      act: { sub: input.actorClientId },
      scope: input.scopes.join(" "),
      authorization_details: [details],
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: getDelegationSigningKeyId(), typ: "at+jwt" })
      .setIssuer(issuer)
      .setSubject(input.subject)
      .setAudience(input.audience)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + input.ttlSeconds)
      .setJti(randomUUID())
      .sign(await this.key());
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const key = createPublicKey(getDelegationSigningPrivateKey()).export({ format: "jwk" }) as JWK;
    return {
      keys: [{
        ...key,
        kid: getDelegationSigningKeyId(),
        alg: "ES256",
        use: "sig",
      }],
    };
  }
}
