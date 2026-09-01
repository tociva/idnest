import { describe, expect, it } from "vitest";
import {
  customScopeOptionsFromScope,
  mergeCustomScopeInput,
  mergeScopeOptions,
  scopeOptionsFromScopes,
  splitScopes,
} from "./client-detail-scopes";

describe("client detail scope helpers", () => {
  it("splits scopes from whitespace and commas", () => {
    expect(splitScopes("openid profile,custom.read\ncustom.write")).toEqual([
      "openid",
      "profile",
      "custom.read",
      "custom.write",
    ]);
  });

  it("merges one or more pending custom scopes into existing selected scopes", () => {
    expect(mergeCustomScopeInput("openid profile email", "custom.read custom.write")).toBe(
      "openid profile email custom.read custom.write",
    );
  });

  it("deduplicates selected and pending custom scopes while preserving order", () => {
    expect(mergeCustomScopeInput("openid profile custom.read", "profile custom.read custom.write")).toBe(
      "openid profile custom.read custom.write",
    );
  });

  it("extracts custom options from loaded scopes without duplicating known scope options", () => {
    expect(
      customScopeOptionsFromScope("openid profile custom.read custom.write", [
        { value: "openid", label: "OpenID" },
        { value: "profile", label: "Profile" },
      ]),
    ).toEqual([
      { value: "custom.read", label: "custom.read" },
      { value: "custom.write", label: "custom.write" },
    ]);
  });

  it("keeps custom options available independently of selected scope values", () => {
    expect(
      mergeScopeOptions(
        [{ value: "openid", label: "OpenID" }],
        scopeOptionsFromScopes(["custom.read", "custom.write"]),
        scopeOptionsFromScopes(["custom.read"]),
      ),
    ).toEqual([
      { value: "openid", label: "OpenID" },
      { value: "custom.read", label: "custom.read" },
      { value: "custom.write", label: "custom.write" },
    ]);
  });
});
