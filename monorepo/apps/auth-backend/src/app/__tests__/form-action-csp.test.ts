import { afterEach, describe, expect, it } from "vitest";
import { buildAuthCsp, clientRedirectOrigins } from "../form-action-csp";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function formAction(csp: string): string {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("form-action "));
  if (!directive) throw new Error("CSP is missing form-action");
  return directive;
}

describe("form-action CSP", () => {
  it("always includes Google, YouTube, and Apple authorize hosts", () => {
    const csp = buildAuthCsp([], {
      kratosPublicUrl: "https://kratos-dev.idnest.cloud",
      hydraPublicUrl: "https://hydra-dev.idnest.cloud/",
    });
    const action = formAction(csp);
    expect(action).toContain("https://accounts.google.com");
    expect(action).toContain("https://accounts.youtube.com");
    expect(action).toContain("https://appleid.apple.com");
    expect(action).toContain("'self'");
    expect(action).toContain("https://kratos-dev.idnest.cloud");
    expect(action).toContain("https://hydra-dev.idnest.cloud");
  });

  it("adds HTTPS origins from the current Hydra client's redirect_uris", () => {
    const origins = clientRedirectOrigins(["https://app-dev.digitalsmartads.com/auth/callback"]);
    expect(origins).toEqual(["https://app-dev.digitalsmartads.com"]);

    const action = formAction(
      buildAuthCsp(origins, {
        kratosPublicUrl: "https://kratos-dev.idnest.cloud",
        hydraPublicUrl: "https://hydra-dev.idnest.cloud/",
      }),
    );
    expect(action).toContain("https://app-dev.digitalsmartads.com");
  });

  it("ignores credentials, fragments, HTTP, and malformed redirect URIs", () => {
    expect(
      clientRedirectOrigins([
        "https://user:secret@app.example/callback",
        "https://app.example/callback#fragment",
        "http://app.example/callback",
        "not a url",
      ]),
    ).toEqual(["https://app.example"]);
  });

  it("uses HYDRA_URLS_SELF_ISSUER and never HYDRA_ADMIN_URL port 4445", () => {
    process.env.KRATOS_PUBLIC_URL = "https://kratos-dev.idnest.cloud";
    process.env.HYDRA_ADMIN_URL = "https://hydra-dev.idnest.cloud:4445";
    process.env.HYDRA_URLS_SELF_ISSUER = "https://hydra-dev.idnest.cloud/";
    process.env.AUTH_RETURN_TO_ALLOWED_ORIGINS = "https://should-not-appear.example";

    const csp = buildAuthCsp(
      clientRedirectOrigins(["https://app-dev.digitalsmartads.com/auth/callback"]),
    );
    const action = formAction(csp);

    expect(action).toContain("https://hydra-dev.idnest.cloud");
    expect(action).not.toContain(":4445");
    expect(csp).not.toContain("https://hydra-dev.idnest.cloud:4445");
    expect(action).not.toContain("should-not-appear.example");
    expect(action).toContain("https://app-dev.digitalsmartads.com");
  });

  it("does not read AUTH_RETURN_TO_ALLOWED_ORIGINS for form-action", () => {
    process.env.KRATOS_PUBLIC_URL = "https://kratos-dev.idnest.cloud";
    process.env.HYDRA_URLS_SELF_ISSUER = "https://hydra-dev.idnest.cloud/";
    process.env.AUTH_RETURN_TO_ALLOWED_ORIGINS = "https://admin-dev.idnest.cloud";

    const action = formAction(buildAuthCsp());
    expect(action).not.toContain("https://admin-dev.idnest.cloud");
  });

  it("keeps the existing document CSP directives", () => {
    const csp = buildAuthCsp([], {
      kratosPublicUrl: "https://kratos-dev.idnest.cloud",
      hydraPublicUrl: "https://hydra-dev.idnest.cloud/",
      assetOrigins: ["https://assets.idnest.cloud"],
    });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://kratos-dev.idnest.cloud");
    expect(csp).toContain("img-src 'self' data: https://assets.idnest.cloud");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
