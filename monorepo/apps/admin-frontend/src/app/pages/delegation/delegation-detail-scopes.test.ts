import { describe, expect, it } from "vitest";
import {
  addDelegationScope,
  createDelegationScopeState,
  selectDelegationScopes,
} from "./delegation-detail-scopes";

describe("delegation detail scope state", () => {
  it("retains the first option when another scope is added", () => {
    let state = createDelegationScopeState([]);

    state = addDelegationScope(state, "records:read");
    state = addDelegationScope(state, "records:write");

    expect(state).toEqual({
      options: ["records:read", "records:write"],
      selected: ["records:read", "records:write"],
    });
  });

  it("keeps a deselected scope available for reselection", () => {
    let state = createDelegationScopeState(["records:read", "records:write"]);

    state = selectDelegationScopes(state, ["records:write"]);
    expect(state).toEqual({
      options: ["records:read", "records:write"],
      selected: ["records:write"],
    });

    state = selectDelegationScopes(state, ["records:read", "records:write"]);
    expect(state.selected).toEqual(["records:read", "records:write"]);
  });

  it("initializes loaded scopes as both options and selections", () => {
    expect(createDelegationScopeState(["records:write", "records:read", "records:read"])).toEqual({
      options: ["records:read", "records:write"],
      selected: ["records:read", "records:write"],
    });
  });
});
