// Shared alias-aware matching, backed by data/aliases.json. Used by any tool that filters on a
// member/group name, so "릭구"/"위시"/romanized names resolve the same way everywhere.
export function norm(value: string | undefined | null): string {
  return (value ?? "").toString().trim().toLowerCase();
}

export function fieldMatches(canonicalValue: string, filter: string, aliasMap: Record<string, string[]>): boolean {
  if (!filter) return true;
  const canonLower = norm(canonicalValue);
  if (canonLower.includes(filter)) return true;
  const aliases = (aliasMap[canonicalValue] ?? []).map(norm);
  return aliases.some((alias) => alias === filter || alias.includes(filter) || filter.includes(alias));
}

// 모델이 그룹 별명("위시")을 member 자리에 넣는 경우가 있어서, 그런 텍스트가 실은 어느 그룹을
// 가리키는지 역으로 찾는다. 찾으면 그 캐노니컬 그룹명을 반환, 못 찾으면 null.
export function resolveGroupAlias(text: string, groupAliasMap: Record<string, string[]>): string | null {
  const filter = norm(text);
  if (!filter) return null;
  for (const canonical of Object.keys(groupAliasMap)) {
    if (fieldMatches(canonical, filter, groupAliasMap)) return canonical;
  }
  return null;
}
