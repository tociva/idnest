import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appleMapper = readFileSync(
  new URL("../../../../../../config/kratos/oidc.apple.mapper.jsonnet", import.meta.url),
  "utf8",
);
const googleMapper = readFileSync(
  new URL("../../../../../../config/kratos/oidc.google.mapper.jsonnet", import.meta.url),
  "utf8",
);
const kratosTemplate = readFileSync(new URL("../../../../../../config/kratos.tpl.yml", import.meta.url), "utf8");
const kratosRenderer = readFileSync(
  new URL("../../../../../../scripts/docker/render-kratos-config.sh", import.meta.url),
  "utf8",
);

function providerBlock(id: string): string {
  const marker = `- id: ${id}`;
  const start = kratosTemplate.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const rest = kratosTemplate.slice(start + marker.length);
  const nextProviderStart = rest.search(/\n\s{10}- id: /);
  return kratosTemplate.slice(start, nextProviderStart === -1 ? undefined : start + marker.length + nextProviderStart);
}

describe("Social OIDC Kratos config", () => {
  it("maps Apple email only when Apple marks it verified", () => {
    expect(appleMapper).toContain("email_verified: false");
    expect(appleMapper).toContain("[if 'email' in claims && claims.email_verified then 'email' else null]");
    expect(appleMapper).toContain("verified_addresses");
  });

  it("maps Google email only when Google marks it verified", () => {
    expect(googleMapper).toContain("email_verified: false");
    expect(googleMapper).toContain("[if 'email' in claims && claims.email_verified then 'email' else null]");
    expect(googleMapper).toContain("verified_addresses");
  });

  it("maps optional Google profile claims only when Google supplies them", () => {
    expect(googleMapper).toContain(
      "[if 'name' in claims then 'name' else null]: claims.name",
    );
    expect(googleMapper).toContain(
      "[if 'picture' in claims then 'picture' else null]: claims.picture",
    );
    expect(googleMapper).not.toMatch(/^\s*name:\s*claims\.name/m);
    expect(googleMapper).not.toMatch(/^\s*picture:\s*claims\.picture/m);
  });

  it("routes Kratos browser errors to the backend error handler", () => {
    expect(kratosTemplate).toContain("default_browser_return_url: ${AUTH_URL}/error");
    expect(kratosTemplate).toMatch(/flows:\n\s+error:\n\s+ui_url: \$\{AUTH_URL\}\/error/);
    expect(kratosTemplate).not.toContain("${AUTH_URL}/auth/error");
  });

  it("quotes comma-separated CORS origins before rendering Kratos YAML", () => {
    expect(kratosTemplate).toContain(
      "allowed_origins: ${KRATOS_CORS_ALLOWED_ORIGINS_YAML}",
    );
    expect(kratosTemplate).not.toContain("allowed_origins: [${CORS_ALLOWED_ORIGINS}]");
    expect(kratosRenderer).toContain(
      'KRATOS_CORS_ALLOWED_ORIGINS_YAML="$(render_cors_origins_yaml)"',
    );
    expect(kratosRenderer).toContain('printf "%s\\\"%s\\\"", separator, origin');
  });

  it("uses Kratos v26.2-compatible Google and Apple provider config", () => {
    const google = providerBlock("google");
    const apple = providerBlock("apple");

    expect(google).toContain("provider: google");
    expect(google).not.toContain("account_linking_mode");

    expect(apple).toContain("provider: apple");
    expect(apple).toContain("issuer_url: https://appleid.apple.com");
    expect(apple).not.toContain("account_linking_mode");
    expect(apple).toContain("APPLE_CLIENT_ID");
  });

  it("marks the Apple provider as optional for the render script", () => {
    expect(kratosTemplate).toContain("# BEGIN optional apple provider");
    expect(kratosTemplate).toContain("# END optional apple provider");
  });
});
