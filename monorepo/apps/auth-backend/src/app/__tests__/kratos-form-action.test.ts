import { describe, expect, it } from "vitest";
import {
  browserKratosFormAction,
  parseAllowedKratosContinueUrl,
} from "../kratos-form-action";

const kratosPublicUrl = "https://kratos-local.idnest.cloud";
const authBaseUrl = "https://auth-local.idnest.cloud";
const options = { kratosPublicUrl, authBaseUrl };

describe("browserKratosFormAction", () => {
  it("rewrites a trusted Kratos action onto the auth origin and keeps path and query", () => {
    expect(
      browserKratosFormAction(
        "https://kratos-local.idnest.cloud/self-service/login?flow=flow-1",
        options,
      ),
    ).toBe("https://auth-local.idnest.cloud/self-service/login?flow=flow-1");
  });

  it("rejects actions that are not the Kratos public origin", () => {
    expect(() =>
      browserKratosFormAction("https://evil.example/self-service/login?flow=flow-1", options),
    ).toThrow("Kratos returned an untrusted flow action");
  });

  it("rejects Kratos actions outside /self-service/", () => {
    expect(() =>
      browserKratosFormAction("https://kratos-local.idnest.cloud/admin/identities", options),
    ).toThrow("Kratos returned an untrusted flow action");
  });
});

describe("parseAllowedKratosContinueUrl", () => {
  it("allows Google, Apple, Kratos self-service, and the auth origin", () => {
    expect(
      parseAllowedKratosContinueUrl(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
        options,
      )?.toString(),
    ).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc");
    expect(
      parseAllowedKratosContinueUrl("https://appleid.apple.com/auth/authorize", options)?.origin,
    ).toBe("https://appleid.apple.com");
    expect(
      parseAllowedKratosContinueUrl(
        "https://kratos-local.idnest.cloud/self-service/methods/oidc/auth/google",
        options,
      )?.pathname,
    ).toBe("/self-service/methods/oidc/auth/google");
    expect(
      parseAllowedKratosContinueUrl(
        "https://auth-local.idnest.cloud/auth/login?flow=flow-1",
        options,
      )?.origin,
    ).toBe("https://auth-local.idnest.cloud");
  });

  it("resolves relative Kratos Locations against the public origin", () => {
    expect(
      parseAllowedKratosContinueUrl("/self-service/login?flow=flow-2", options)?.toString(),
    ).toBe("https://kratos-local.idnest.cloud/self-service/login?flow=flow-2");
  });

  it("rejects Hydra, other apps, and credentialed URLs", () => {
    expect(
      parseAllowedKratosContinueUrl("https://hydra-dev.idnest.cloud/oauth2/auth", options),
    ).toBeNull();
    expect(parseAllowedKratosContinueUrl("https://evil.example/phish", options)).toBeNull();
    expect(
      parseAllowedKratosContinueUrl("https://user:pass@accounts.google.com/o/oauth2/v2/auth", options),
    ).toBeNull();
  });
});
