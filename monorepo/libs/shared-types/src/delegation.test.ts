import { describe, expect, it } from "vitest";
import {
  canonicalDelegationScopes,
  delegationScopeSubset,
  isDelegationResourceKey,
  isDelegationScope,
  isDelegationStatus,
} from "./delegation";

describe("generic delegation contracts", () => {
  it("canonicalizes scopes from strings and arrays", () => {
    expect(canonicalDelegationScopes("records:read records:write records:read")).toEqual([
      "records:read",
      "records:write",
    ]);
    expect(canonicalDelegationScopes(["z", "a", "z"])).toEqual(["a", "z"]);
  });

  it("rejects empty and malformed scopes", () => {
    expect(() => canonicalDelegationScopes([])).toThrow(/1 to 50/);
    expect(() => canonicalDelegationScopes(["spaces are not valid"])).toThrow(/1 to 50/);
    expect(() => canonicalDelegationScopes(["records:read", 42])).toThrow(/only strings/);
    expect(isDelegationScope("records:read")).toBe(true);
    expect(isDelegationScope(" records:read")).toBe(false);
  });

  it("checks scope subsets without granting implicit scope", () => {
    expect(delegationScopeSubset(["records:read"], ["records:read", "records:write"])).toBe(true);
    expect(delegationScopeSubset(["records:delete"], ["records:read"])).toBe(false);
  });

  it("validates resource keys and lifecycle states", () => {
    expect(isDelegationResourceKey("ledger-api")).toBe(true);
    expect(isDelegationResourceKey("Ledger API")).toBe(false);
    expect(isDelegationStatus("active")).toBe(true);
    expect(isDelegationStatus("draft")).toBe(false);
  });
});
