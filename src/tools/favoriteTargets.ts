// planRoute·findPlaces 공통: 이번 호출에서 "최애"로 볼 대상 목록.
// 사용자가 멤버·그룹을 말했으면(Tool 인자) 그 하나, 아니면 저장된 최애 전체(앞 순서 우선).
import type { Aliases, Item, Place } from "../data.js";
import type { FavoriteEntry } from "../state.js";
import { norm, fieldMatches, resolveGroupAlias } from "../aliasMatch.js";

export interface FavoriteTarget {
  member: string; // 소문자 정규화, 없으면 ""
  group: string; // 소문자 정규화, 없으면 ""
  memberName: string | null; // 라벨용 데이터 정식 이름
  groupName: string | null; // 안내용 데이터 정식 그룹명 (예: "BTS")
}

export function favoriteTargets(
  args: { member?: unknown; group?: unknown },
  saved: FavoriteEntry[] | undefined,
  items: Item[],
  aliases: Aliases,
): { targets: FavoriteTarget[]; fromSaved: boolean } {
  const toTarget = (memberText: string, groupText: string): FavoriteTarget | null => {
    let member = norm(memberText);
    let group = norm(groupText);
    // "위시"처럼 그룹 별명을 member 자리에 넣는 경우가 있어서, 실제 멤버로 안 풀리면 그룹 별명인지 먼저 확인한다.
    if (member && !items.some((item) => fieldMatches(item.member, member, aliases.members))) {
      const asGroup = resolveGroupAlias(member, aliases.groups);
      if (asGroup) {
        group = group || norm(asGroup);
        member = "";
      }
    }
    const memberItem = member
      ? items.find((item) => item.member !== "단체" && fieldMatches(item.member, member, aliases.members) && (!group || fieldMatches(item.group, group, aliases.groups)))
      : undefined;
    if (!group && memberItem) group = norm(memberItem.group);
    if (!member && !group) return null;
    const groupItem = memberItem ?? (group ? items.find((item) => fieldMatches(item.group, group, aliases.groups)) : undefined);
    return { member, group, memberName: memberItem?.member ?? null, groupName: groupItem?.group ?? null };
  };

  const argMember = typeof args.member === "string" ? args.member : "";
  const argGroup = typeof args.group === "string" ? args.group : "";
  if (argMember.trim() || argGroup.trim()) {
    const one = toTarget(argMember, argGroup);
    return { targets: one ? [one] : [], fromSaved: false };
  }
  const targets = (saved ?? []).map((f) => toTarget(f.member ?? "", f.group ?? "")).filter((t): t is FavoriteTarget => t !== null);
  return { targets, fromSaved: targets.length > 0 };
}

// 성지는 그룹 단위다: 데이터 대부분이 "단체" 방문이고 멤버 개인 기록은 드물다(BTS 78곳 중 RM·V·SUGA 몇 곳).
// 그래서 최애가 멤버여도 찾는 범위는 그 멤버의 그룹 성지 전체(groupVisitIndex)이고,
// 멤버 개인 기록이 있는 곳(memberVisitIndex)은 우선순위만 올리고 "지민이 다녀간 곳"처럼 표시한다.

/** 이 장소에 그 멤버 이름으로 남은 개인 방문 기록이 있는 최애 중 가장 앞 순서의 index, 없으면 -1. ("단체"는 그룹 방문으로 본다) */
export function memberVisitIndex(place: Place, targets: FavoriteTarget[], aliases: Aliases): number {
  return targets.findIndex((t) =>
    Boolean(t.member) &&
    place.visits.some((v) =>
      v.member !== "단체" &&
      fieldMatches(v.member, t.member, aliases.members) &&
      (!t.group || fieldMatches(v.group, t.group, aliases.groups)),
    ),
  );
}

/** 이 장소에 다녀간 최애 그룹(단체·멤버 개인 방문 모두) 중 가장 앞 순서의 index, 없으면 -1. */
export function groupVisitIndex(place: Place, targets: FavoriteTarget[], aliases: Aliases): number {
  return targets.findIndex((t) => Boolean(t.group) && place.visits.some((v) => fieldMatches(v.group, t.group, aliases.groups)));
}
