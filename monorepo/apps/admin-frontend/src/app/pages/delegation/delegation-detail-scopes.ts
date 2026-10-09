export interface DelegationScopeState {
  options: string[];
  selected: string[];
}

export function normalizeDelegationScopes(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function createDelegationScopeState(values: readonly unknown[]): DelegationScopeState {
  const scopes = normalizeDelegationScopes(values);
  return { options: [...scopes], selected: scopes };
}

export function addDelegationScope(
  state: DelegationScopeState,
  value: string,
): DelegationScopeState {
  return {
    options: normalizeDelegationScopes([...state.options, value]),
    selected: normalizeDelegationScopes([...state.selected, value]),
  };
}

export function selectDelegationScopes(
  state: DelegationScopeState,
  values: readonly unknown[],
): DelegationScopeState {
  const selected = normalizeDelegationScopes(values);
  return {
    options: normalizeDelegationScopes([...state.options, ...selected]),
    selected,
  };
}
