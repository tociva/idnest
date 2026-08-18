import { describe, expect, it } from "vitest";
import { isAllowedOrigin, normalizeOrigin } from "./origin";

describe("origin allowlist", () => {
  it("normalizes origins", () => {
    expect(normalizeOrigin("https://admin.idnest.cloud/settings")).toBe("https://admin.idnest.cloud");
    expect(normalizeOrigin("not a url")).toBeNull();
  });

  it("allows exact origins", () => {
    expect(isAllowedOrigin("https://admin-local.idnest.cloud/page", ["https://admin-local.idnest.cloud"])).toBe(
      true,
    );
    expect(isAllowedOrigin("https://client.example", ["https://admin-local.idnest.cloud"])).toBe(
      false,
    );
  });

  it("allows bounded wildcard subdomains", () => {
    const allowedOrigins = ["https://*.idnest.cloud", "https://*.example.com"];

    expect(isAllowedOrigin("https://admin.idnest.cloud", allowedOrigins)).toBe(true);
    expect(isAllowedOrigin("https://app.example.com", allowedOrigins)).toBe(true);
    expect(isAllowedOrigin("https://app-dev.example.com", allowedOrigins)).toBe(true);
    expect(isAllowedOrigin("https://tenant.preview.example.com", allowedOrigins)).toBe(true);
  });

  it("rejects origins outside bounded wildcard domains", () => {
    const allowedOrigins = ["https://*.idnest.cloud", "https://*.example.com"];

    expect(isAllowedOrigin("https://evil.com", allowedOrigins)).toBe(false);
    expect(isAllowedOrigin("https://example.com.evil.com", allowedOrigins)).toBe(false);
    expect(isAllowedOrigin("http://app.example.com", allowedOrigins)).toBe(false);
    expect(isAllowedOrigin("https://example.com", allowedOrigins)).toBe(false);
  });

  it("does not allow bare wildcard origins", () => {
    expect(isAllowedOrigin("https://app.example.com", ["*"])).toBe(false);
  });
});
