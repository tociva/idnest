import { describe, expect, it } from "vitest";
import {
  clientCorsOriginsFromRedirectUris,
  normalizeClientCorsOrigin,
} from "./oauth-client";

describe("OAuth client browser origins", () => {
  describe("normalizeClientCorsOrigin", () => {
    it.each([
      ["domain", "https://client.example", "https://client.example"],
      ["root slash", "https://client.example/", "https://client.example"],
      ["surrounding whitespace", " https://client.example:8443 ", "https://client.example:8443"],
      ["host casing", "HTTPS://CLIENT.EXAMPLE", "https://client.example"],
      ["default HTTPS port", "https://client.example:443", "https://client.example"],
      ["custom HTTPS port", "https://client.example:8443", "https://client.example:8443"],
      ["subdomain", "https://app.eu.client.example", "https://app.eu.client.example"],
      ["IPv4 host", "https://192.0.2.10:8443", "https://192.0.2.10:8443"],
      ["internationalized host", "https://bücher.example", "https://xn--bcher-kva.example"],
    ])("normalizes an exact HTTPS origin with %s", (_label, value, expected) => {
      expect(normalizeClientCorsOrigin(value)).toBe(expected);
    });

    it.each([
      ["localhost", "http://localhost:4200", "http://localhost:4200"],
      ["localhost default port", "http://localhost:80", "http://localhost"],
      ["localhost subdomain", "http://tenant.localhost:4200", "http://tenant.localhost:4200"],
      ["IPv4 loopback", "http://127.0.0.1:4200", "http://127.0.0.1:4200"],
      ["short IPv4 loopback", "http://127.1:4200", "http://127.0.0.1:4200"],
    ])("normalizes an explicitly enabled HTTP loopback origin with %s", (_label, value, expected) => {
      expect(normalizeClientCorsOrigin(value, { allowHttpLoopback: true })).toBe(expected);
    });

    it.each([
      ["empty input", ""],
      ["whitespace-only input", "   "],
      ["malformed URL", "not a URL"],
      ["relative URL", "/callback"],
      ["protocol-relative URL", "//client.example"],
      ["FTP scheme", "ftp://client.example"],
      ["WebSocket scheme", "wss://client.example"],
      ["custom application scheme", "com.example.app://callback"],
      ["wildcard host", "https://*.example.com"],
      ["wildcard port", "https://client.example:*"],
      ["username", "https://user@client.example"],
      ["username and password", "https://user:secret@client.example"],
      ["path", "https://client.example/callback"],
      ["double root slash", "https://client.example//"],
      ["dot path", "https://client.example/."],
      ["encoded dot path", "https://client.example/%2e"],
      ["resolved dot segments", "https://client.example/callback/.."],
      ["backslash path", "https://client.example\\callback"],
      ["query", "https://client.example?tenant=one"],
      ["empty query", "https://client.example?"],
      ["fragment", "https://client.example/#fragment"],
      ["empty fragment", "https://client.example#"],
      ["invalid port", "https://client.example:not-a-port"],
      ["HTTP domain", "http://client.example"],
      ["HTTPS IPv6 literal unsupported by Hydra CORS", "https://[2001:db8::1]:8443"],
      ["HTTP IPv6 loopback unsupported by Hydra CORS", "http://[::1]:4200"],
    ])("rejects %s", (_label, value) => {
      expect(normalizeClientCorsOrigin(value, { allowHttpLoopback: true })).toBeNull();
    });

    it.each([
      "http://localhost:4200",
      "http://tenant.localhost:4200",
      "http://127.0.0.1:4200",
      "http://[::1]:4200",
    ])("rejects loopback HTTP unless explicitly enabled: %s", (value) => {
      expect(normalizeClientCorsOrigin(value)).toBeNull();
    });
  });

  describe("clientCorsOriginsFromRedirectUris", () => {
    it("derives normalized, unique web origins in first-seen order", () => {
      expect(
        clientCorsOriginsFromRedirectUris(
          [
            "https://CLIENT.example:443/auth/callback",
            "https://client.example/login/return",
            "https://client.example:8443/callback",
            "http://localhost:4200/callback",
            "http://127.1:4300/callback",
          ],
          { allowHttpLoopback: true },
        ),
      ).toEqual([
        "https://client.example",
        "https://client.example:8443",
        "http://localhost:4200",
        "http://127.0.0.1:4300",
      ]);
    });

    it("ignores malformed, credentialed, custom-scheme, and disabled HTTP redirect URIs", () => {
      expect(
        clientCorsOriginsFromRedirectUris([
          "not a URL",
          "https://user:secret@client.example/callback",
          "com.example.app:/callback",
          "http://localhost:4200/callback",
          "http://client.example/callback",
          "https://client.example/callback",
        ]),
      ).toEqual(["https://client.example"]);
    });
  });
});
