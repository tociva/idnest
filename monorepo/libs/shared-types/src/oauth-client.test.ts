import { describe, expect, it } from "vitest";
import {
  clientCorsOriginsFromRedirectUris,
  normalizeClientCorsOrigin,
} from "./oauth-client";

describe("OAuth client browser origins", () => {
  it("normalizes exact HTTPS origins", () => {
    expect(normalizeClientCorsOrigin(" https://client.example:8443 ")).toBe(
      "https://client.example:8443",
    );
  });

  it("rejects paths, credentials, wildcards, queries, and fragments", () => {
    expect(normalizeClientCorsOrigin("https://client.example/callback")).toBeNull();
    expect(normalizeClientCorsOrigin("https://user:secret@client.example")).toBeNull();
    expect(normalizeClientCorsOrigin("https://*.example.com")).toBeNull();
    expect(normalizeClientCorsOrigin("https://client.example?tenant=one")).toBeNull();
    expect(normalizeClientCorsOrigin("https://client.example/#fragment")).toBeNull();
  });

  it("allows HTTP only for explicitly enabled loopback development origins", () => {
    expect(normalizeClientCorsOrigin("http://localhost:4200")).toBeNull();
    expect(
      normalizeClientCorsOrigin("http://localhost:4200", { allowHttpLoopback: true }),
    ).toBe("http://localhost:4200");
    expect(
      normalizeClientCorsOrigin("http://127.0.0.1:4200", { allowHttpLoopback: true }),
    ).toBe("http://127.0.0.1:4200");
    expect(
      normalizeClientCorsOrigin("http://client.example", { allowHttpLoopback: true }),
    ).toBeNull();
  });

  it("derives unique web origins from redirect URIs", () => {
    expect(
      clientCorsOriginsFromRedirectUris(
        [
          "https://client.example/auth/callback",
          "https://client.example/login/return",
          "http://localhost:4200/callback",
          "com.example.app:/callback",
        ],
        { allowHttpLoopback: true },
      ),
    ).toEqual(["https://client.example", "http://localhost:4200"]);
  });
});
