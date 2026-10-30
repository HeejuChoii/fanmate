// 최애 그룹·멤버 판별 공통 로직. explicitPreferences(문장에서 직접 추출)와 savePreferences Tool이
// 같은 규칙을 쓰도록 한 곳에 모은다. 그룹·멤버 소속은 data/items.json, 별명은 data/aliases.json 기준.
// - 멤버만 말해도 데이터에서 그룹을 찾는다. 그룹이 하나면 그룹까지 같이 정하고, 여러 그룹이면 정하지 않는다.
// - 그룹명은 "아이브", "엔시티 위시", "위시" 같은 한글 표기·별명도 정식 이름으로 맞춘다.
import type { Aliases, Item } from "./data.js";
import type { FavoriteEntry } from "./state.js";
import { norm } from "./aliasMatch.js";

export interface FavoriteCatalog {
  groups: Array<{ name: string; variants: string[] }>; // variants: 공백 없앤 소문자
  members: Array<{ group: string; name: string; variants: string[] }>;
}

export type FavoriteResolution =
  | { status: "resolved"; favoriteGroup?: string; favoriteMember?: string }
  | { status: "ambiguous"; member: string; candidateGroups: string[] }
  | { status: "none" };

const compact = (value: string) => norm(value).replace(/\s+/g, "");

// "장원영"을 "원영"으로도 부르니까, 흔한 성으로 시작하는 세 글자 한글 이름은 이름 두 글자도 받는다.
// ("아이유"→"이유", "카리나"→"리나"처럼 성이 아닌 경우는 만들지 않는다.)
const SURNAMES = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나명";
function givenName(name: string): string | null {
  return /^[가-힣]{3}$/.test(name) && SURNAMES.includes(name[0]!) ? name.slice(1) : null;
}

export function buildFavoriteCatalog(items: Item[], aliases: Aliases): FavoriteCatalog {
  const itemGroups = [...new Set(items.map((i) => i.group))].filter((g) => g && g !== "단체");
  const groupAliasKeys = Object.keys(aliases.groups ?? {});
  const groups = new Map<string, Set<string>>();
  const addGroup = (name: string, variants: string[]) => {
    const set = groups.get(name) ?? new Set<string>();
    for (const v of [name, ...variants]) if (compact(v)) set.add(compact(v));
    groups.set(name, set);
  };
  for (const g of itemGroups) addGroup(g, []);
  for (const key of groupAliasKeys) {
    const variants = aliases.groups[key] ?? [];
    // 별명 키 이름이 items와 다를 수 있다(SVT ↔ SEVENTEEN) — 별명 중 하나가 items 그룹명과 같으면 그쪽으로 합친다.
    const canonical = itemGroups.find((g) => [key, ...variants].some((v) => compact(v) === compact(g))) ?? key;
    addGroup(canonical, [key, ...variants]);
  }

  const memberAliasKeys = Object.keys(aliases.members ?? {});
  const members: FavoriteCatalog["members"] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.member || item.member === "단체" || !item.group || item.group === "단체") continue;
    const id = `${item.group}\u0000${item.member}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const variants = new Set<string>([compact(item.member)]);
    const given = givenName(item.member);
    if (given) variants.add(given);
    // 별명 키가 성까지 붙은 이름일 수 있다("명재현" ↔ items의 "재현").
    for (const key of memberAliasKeys) {
      if (key === item.member || givenName(key) === item.member || given === key) {
        for (const v of [key, ...(aliases.members[key] ?? [])]) if (compact(v)) variants.add(compact(v));
      }
    }
    members.push({ group: item.group, name: item.member, variants: [...variants] });
  }
  return { groups: [...groups].map(([name, variants]) => ({ name, variants: [...variants] })), members };
}

/** 그룹 이름·별명을 정식 그룹명으로. 모르는 그룹이면 null. */
export function canonicalGroup(input: string, catalog: FavoriteCatalog): string | null {
  const key = compact(input);
  if (!key) return null;
  return catalog.groups.find((g) => g.variants.includes(key))?.name ?? null;
}

/** 멤버 이름·별명이 데이터에서 속한 (그룹, 정식 멤버명) 목록. */
export function findMember(input: string, catalog: FavoriteCatalog, group?: string): Array<{ group: string; name: string }> {
  const key = compact(input);
  if (!key) return [];
  return catalog.members
    .filter((m) => (!group || m.group === group) && m.variants.includes(key))
    .map(({ group: g, name }) => ({ group: g, name }));
}

/**
 * savePreferences처럼 그룹·멤버가 따로 들어올 때. 멤버가 데이터에 있으면 데이터의 그룹을 따른다
 * (모델이 예전 최애 그룹을 그대로 붙여 보내도 바로잡힌다). 같은 이름이 여러 그룹에 있고 그룹이
 * 정해지지 않으면 ambiguous로 돌려서 덕메가 되묻게 한다.
 */
export function resolveFavorite(input: { group?: string; member?: string }, catalog: FavoriteCatalog): FavoriteResolution {
  const groupText = input.group?.trim() ?? "";
  const memberText = input.member?.trim() ?? "";
  const group = groupText ? canonicalGroup(groupText, catalog) ?? groupText : undefined;
  if (!memberText) return group ? { status: "resolved", favoriteGroup: group } : { status: "none" };

  if (group) {
    const inGroup = findMember(memberText, catalog, group);
    if (inGroup.length) return { status: "resolved", favoriteGroup: group, favoriteMember: inGroup[0]!.name };
  }
  const matches = findMember(memberText, catalog);
  const groups = [...new Set(matches.map((m) => m.group))];
  if (groups.length === 1) return { status: "resolved", favoriteGroup: groups[0], favoriteMember: matches[0]!.name };
  if (groups.length > 1) return { status: "ambiguous", member: memberText, candidateGroups: groups };
  // 데이터에 없는 멤버: 사용자가 말한 그대로 저장한다. 그룹을 말했으면 그 그룹을 같이.
  return group ? { status: "resolved", favoriteGroup: group, favoriteMember: memberText } : { status: "resolved", favoriteMember: memberText };
}

// 한국어 조사·어미를 떼고 이름 후보를 만든다: "사쿠야야" → "사쿠야", "원영이" → "원영".
const PARTICLES = ["이에요", "예요", "에요", "이야", "이랑", "이가", "이는", "이를", "이도", "님", "야", "이", "가", "는", "은", "을", "를", "도", "랑", "의"];
function tokenCandidates(token: string): string[] {
  const out = new Set([token]);
  for (const p of PARTICLES) if (token.length > p.length && token.endsWith(p)) out.add(token.slice(0, -p.length));
  return [...out];
}

export type FavoriteMode = "add" | "replace" | "remove";

/**
 * 최애를 추가/교체/삭제 중 무엇으로 말했는지. 삭제 > 교체 > 추가 순으로 보고, 애매하면 추가.
 * - 추가: "~도 있어", "~도 좋아", "또", "추가"
 * - 교체: "최애 바뀌었어", "이제 ~만", "~로 갈아탔어"
 * - 삭제: "~는 이제 아니야", "빼줘"
 */
const REMOVE_PHRASE = /빼\s*(?:줘|주|줄|자|라|야)|지워|삭제|이제\s*아니|더\s*이상\s*아니|최애\s*아니|탈덕/;
const REPLACE_PHRASE = /바뀌었|바뀜|바꿨|바꿀|바꿔|갈아탔|갈아타|갈아탈|교체|이제\s*\S+만(?:\s|$|[!.~?])|\S+만\s*좋아|한\s*명만/;
export function detectFavoriteMode(text: string): FavoriteMode {
  const t = norm(text);
  if (REMOVE_PHRASE.test(t)) return "remove";
  if (REPLACE_PHRASE.test(t)) return "replace";
  return "add";
}

export interface FavoriteMention {
  entries: FavoriteEntry[];
  ambiguous: Array<{ member: string; candidateGroups: string[] }>;
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 문장에서 말한 최애를 전부 찾는다: "내 최애는 사쿠야야", "나 원영이 최애야", "BOYNEXTDOOR 태산이랑 에스파 카리나".
 * 멤버는 데이터에서 그룹을 찾고(말한 그룹이 있으면 그쪽 우선), 같은 이름이 여러 그룹이면 ambiguous로 뺀다.
 * 멤버 없이 말한 그룹은 그룹만으로 넣는다. onlyBefore면 "태산은 빼줘", "카리나만 좋아"처럼 이름 바로
 * 뒤에 그 표현이 붙은 것만 남긴다("사쿠야 가방 빼줘"의 사쿠야를 최애에서 지우지 않게).
 */
// "최애"라는 말 없이도 최애 변경으로 볼 때, 이름 바로 뒤에 붙어야 하는 표현.
export const AFTER_NAME: Record<FavoriteMode, string> = {
  remove: "\\s*(?:은|는|이는|도|이도)?\\s*(?:이제\\s*|더\\s*이상\\s*)?(?:최애(?:에서|가|는)?\\s*)?(?:빼|아니|지워|삭제)",
  replace: "\\s*(?:(?:으로|로)\\s*갈아|만\\s*좋아|만\\s*최애|한\\s*명만)",
  add: "\\s*(?:도|이도)\\s*(?:좋아|있어|최애)",
};

export function detectFavoritesInText(text: string, catalog: FavoriteCatalog, options: { onlyBefore?: FavoriteMode } = {}): FavoriteMention {
  // "위시리스트"의 "위시"를 NCT WISH로 읽지 않게 먼저 지운다.
  const cleaned = norm(text).replace(/위시\s*리스트|wish\s*list/g, " ");
  const flat = cleaned.replace(/\s+/g, "");
  // 두 글자 이하 별명은 단어 단위로만 맞춘다("레벨" 같은 일반어 오인 방지).
  const rawTokens = cleaned.split(/[\s.,!?~'"()\[\]/]+/).filter(Boolean);
  const tokenSet = new Set(rawTokens.flatMap(tokenCandidates));
  // 한 글자 이름("한", "뷔")은 "한 번"처럼 일반 단어와 겹치니, 조사가 붙었거나 그 그룹을 같이 말했을 때만 이름으로 본다.
  const withParticle = new Set(rawTokens.flatMap((t) => tokenCandidates(t).filter((c) => c !== t)));
  const mentioned = (v: string) => (v.length >= 3 ? flat.includes(v) : tokenSet.has(v));
  const phraseAfter = (v: string) => !!options.onlyBefore && new RegExp(`${escapeRe(v)}${AFTER_NAME[options.onlyBefore]}`).test(cleaned);

  const groups = catalog.groups.filter((g) => g.variants.some(mentioned)).map((g) => g.name);
  const memberMentioned = (m: FavoriteCatalog["members"][number]) =>
    m.variants.some((v) => (v.length === 1 && !groups.includes(m.group) ? withParticle.has(v) : tokenSet.has(v)) || (v.length >= 3 && flat.includes(v)));
  const hits = catalog.members.filter(memberMentioned)
    .filter((m) => !options.onlyBefore || m.variants.some(phraseAfter));

  const entries: FavoriteEntry[] = [];
  const ambiguous: FavoriteMention["ambiguous"] = [];
  for (const name of [...new Set(hits.map((m) => m.name))]) {
    const candidates = [...new Set(hits.filter((m) => m.name === name).map((m) => m.group))];
    const inSaidGroup = candidates.filter((g) => groups.includes(g));
    const chosen = inSaidGroup.length === 1 ? inSaidGroup : candidates.length === 1 ? candidates : [];
    if (chosen.length === 1) entries.push({ group: chosen[0], member: name });
    else ambiguous.push({ member: name, candidateGroups: inSaidGroup.length > 1 ? inSaidGroup : candidates });
  }
  for (const group of groups) {
    if (entries.some((e) => e.group === group)) continue;
    if (options.onlyBefore && !catalog.groups.find((g) => g.name === group)?.variants.some(phraseAfter)) continue;
    entries.push({ group });
  }
  // 말한 순서대로(먼저 말한 최애가 앞 = 우선).
  const position = (e: FavoriteEntry) => {
    const variants = e.member
      ? catalog.members.find((m) => m.name === e.member && m.group === e.group)?.variants ?? []
      : catalog.groups.find((g) => g.name === e.group)?.variants ?? [];
    const found = variants.map((v) => flat.indexOf(v)).filter((i) => i >= 0);
    return found.length ? Math.min(...found) : Number.MAX_SAFE_INTEGER;
  };
  entries.sort((x, y) => position(x) - position(y));
  return { entries, ambiguous };
}

const sameMember = (a: FavoriteEntry, b: FavoriteEntry) =>
  !!a.member && !!b.member && norm(a.member) === norm(b.member) && (!a.group || !b.group || a.group === b.group);

export interface FavoriteApplyResult {
  favorites: FavoriteEntry[];
  added: FavoriteEntry[];
  removed: FavoriteEntry[];
  notFound: FavoriteEntry[]; // 지우라고 했는데 저장돼 있지 않던 것
}

/**
 * 최애 목록에 변경을 적용한다 (server.ts 직접 추출 경로, savePreferences Tool, 기억 패널 ✕ 공통).
 * - add: 같은 그룹·멤버는 중복 저장하지 않는다. 같은 그룹의 멤버를 더하면 그 그룹에 멤버가 늘고,
 *   "그룹만" 저장돼 있던 항목은 그 그룹 멤버가 생기면 그 자리를 멤버 항목이 대신한다.
 * - replace: 목록을 새로 말한 최애로 바꾼다.
 * - remove: 멤버를 말하면 그 멤버만, 그룹만 말하면 그 그룹 항목을 전부 지운다.
 */
export function applyFavoriteChange(current: FavoriteEntry[] | undefined, mode: FavoriteMode, entries: FavoriteEntry[]): FavoriteApplyResult {
  const before = [...(current ?? [])];
  const result: FavoriteApplyResult = { favorites: before, added: [], removed: [], notFound: [] };
  if (!entries.length) return result;

  if (mode === "remove") {
    let next = before;
    for (const e of entries) {
      const hit = (f: FavoriteEntry) => (e.member ? sameMember(f, e) : !!e.group && f.group === e.group);
      const gone = next.filter(hit);
      if (!gone.length) result.notFound.push(e);
      result.removed.push(...gone);
      next = next.filter((f) => !hit(f));
    }
    result.favorites = next;
    return result;
  }

  let next = mode === "replace" ? [] : before;
  for (const e of entries) {
    if (!e.group && !e.member) continue;
    if (e.member) {
      if (next.some((f) => sameMember(f, e))) continue;
      const groupOnly = e.group ? next.findIndex((f) => !f.member && f.group === e.group) : -1;
      next = groupOnly >= 0 ? next.map((f, i) => (i === groupOnly ? e : f)) : [...next, e];
    } else {
      if (next.some((f) => f.group === e.group)) continue;
      next = [...next, e];
    }
  }
  result.favorites = next;
  result.added = next.filter((f) => !before.some((b) => (f.member ? sameMember(b, f) : !b.member && b.group === f.group)));
  result.removed = before.filter((b) => !next.some((f) => (b.member ? sameMember(f, b) : !f.member && f.group === b.group)));
  return result;
}

/** savePreferences처럼 그룹·멤버가 따로 들어올 때 → 저장할 항목들. 멤버는 쉼표로 여러 명 가능. */
export function resolveFavoriteArgs(group: string | undefined, members: string | undefined, catalog: FavoriteCatalog): FavoriteMention {
  const names = (members ?? "").split(/[,，、/]|\s+(?:and|그리고)\s+/).map((v) => v.trim()).filter(Boolean);
  const out: FavoriteMention = { entries: [], ambiguous: [] };
  if (!names.length) {
    const r = resolveFavorite({ group }, catalog);
    if (r.status === "resolved" && r.favoriteGroup) out.entries.push({ group: r.favoriteGroup });
    return out;
  }
  for (const name of names) {
    const r = resolveFavorite({ group, member: name }, catalog);
    if (r.status === "ambiguous") out.ambiguous.push({ member: r.member, candidateGroups: r.candidateGroups });
    else if (r.status === "resolved") {
      const entry: FavoriteEntry = {};
      if (r.favoriteGroup) entry.group = r.favoriteGroup;
      if (r.favoriteMember) entry.member = r.favoriteMember;
      out.entries.push(entry);
    }
  }
  return out;
}

/** 기억 패널·context용 한 줄: "BOYNEXTDOOR 태산 · aespa 카리나". */
export function favoritesLabel(favorites: FavoriteEntry[] | undefined): string {
  return (favorites ?? []).map((f) => [f.group, f.member].filter(Boolean).join(" ")).join(" · ");
}

/** 매 턴 context에 넣을 짧은 명단: "그룹: 멤버, 멤버". */
export function rosterSummary(catalog: FavoriteCatalog): string[] {
  const byGroup = new Map<string, string[]>();
  for (const m of catalog.members) byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m.name]);
  return [...byGroup].map(([g, ms]) => `${g}: ${ms.join(", ")}`);
}

// 같은 턴에 server.ts(문장에서 직접 추출)가 먼저 최애를 바꾼 뒤 덕메가 savePreferences를 또 부르면,
// Tool은 "이미 저장됨/지울 게 없음"으로 보게 된다. 그때 덕메가 거꾸로 말하지 않게 직전 변경을 잠깐 기억해 둔다.
const recentChanges = new Map<string, { at: number; added: FavoriteEntry[]; removed: FavoriteEntry[] }>();
const RECENT_MS = 2 * 60 * 1000;
export function noteFavoriteChange(user: string, applied: Pick<FavoriteApplyResult, "added" | "removed">): void {
  recentChanges.set(user, { at: Date.now(), added: applied.added, removed: applied.removed });
}
export function recentFavoriteChange(user: string): { added: FavoriteEntry[]; removed: FavoriteEntry[] } | null {
  const r = recentChanges.get(user);
  return r && Date.now() - r.at < RECENT_MS ? r : null;
}
/** Tool 결과에 직전 턴의 앱 반영분을 합친다: 요청한 항목이 방금 추가/삭제된 거면 그렇게 보고한다. */
export function withRecentFavoriteChange(user: string, mode: FavoriteMode, requested: FavoriteEntry[], applied: FavoriteApplyResult): FavoriteApplyResult {
  const recent = recentFavoriteChange(user);
  if (!recent) return applied;
  const matches = (a: FavoriteEntry, b: FavoriteEntry) => (a.member ? sameMember(a, b) : !b.member && a.group === b.group);
  const plus = (list: FavoriteEntry[], extra: FavoriteEntry[]) => [...list, ...extra.filter((e) => !list.some((l) => matches(l, e)))];
  const req = (list: FavoriteEntry[]) => list.filter((e) => requested.some((r) => matches(r, e) || (!!r.member && sameMember(r, e))));
  return {
    ...applied,
    added: mode === "remove" ? applied.added : plus(applied.added, req(recent.added)),
    removed: plus(applied.removed, mode === "add" ? [] : req(recent.removed)),
    notFound: applied.notFound.filter((n) => !recent.removed.some((r) => matches(n, r) || sameMember(n, r))),
  };
}
