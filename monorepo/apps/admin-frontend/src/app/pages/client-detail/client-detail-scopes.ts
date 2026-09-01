export const normalizeScopeList = (scopes: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "string") continue;
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

export const splitScopes = (value: string): string[] => normalizeScopeList(value.split(/[\s,]+/));

export const mergeCustomScopeInput = (scope: string, customScope: string): string =>
  normalizeScopeList([...splitScopes(scope), ...splitScopes(customScope)]).join(" ");

export interface ScopeOptionValue {
  value: string;
  label: string;
}

export const scopeOptionsFromScopes = (scopes: readonly string[]): ScopeOptionValue[] =>
  normalizeScopeList(scopes).map((scope) => ({ value: scope, label: scope }));

export const mergeScopeOptions = <T extends ScopeOptionValue>(...groups: Array<readonly T[]>): T[] => {
  const seen = new Set<string>();
  const options: T[] = [];
  for (const group of groups) {
    for (const option of group) {
      if (!option.value || seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
    }
  }
  return options;
};

export const customScopeOptionsFromScope = (
  scope: string,
  knownOptions: readonly ScopeOptionValue[],
): ScopeOptionValue[] => {
  const knownValues = new Set(knownOptions.map((option) => option.value));
  return scopeOptionsFromScopes(splitScopes(scope)).filter((option) => !knownValues.has(option.value));
};
