import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { loadItems, loadAliases, type Item, type Aliases } from "../data.js";
import { readState } from "../state.js";
import { emitCard, dedupeKeyFor } from "../bus.js";
import { norm, fieldMatches } from "../aliasMatch.js";

export const searchItemDeclaration: ToolDeclaration = {
  name: "searchItem",
  summary:
    "최애 멤버의 손민수 후보 아이템(검수된 원래 제품 + 팬 계정 미검증 후보)을 멤버·상황·날짜·특징 묘사로 찾는다. '공항에서 멘 가방', '빨간 니트' 같은 모호한 표현도 처리한다. 대체템은 여기서 섞여 나오지 않으니, 예산 안의 대체템이 필요하면 결과의 itemId로 findAlternative를 따로 호출한다. data/items.json에 없는 건 지어내지 않는다.",
  commands: [
    {
      key: "search_item",
      name: "search",
      reads: true,
      summary:
        "member·group·situation·category·keywords 중 아는 조건만 넣어서 제품 후보를 찾는다 (대체템은 기본적으로 빠짐 — includeAlternatives:true를 주지 않으면 원래 제품만 나온다). 결과가 없으면 빈 배열을 반환하니, 그대로 '아직 확인되지 않은 정보'라고 답한다.",
      flags: [
        { name: "group", type: "string", description: "그룹명. 한글 정식 이름/별명/로마자 모두 가능 (예: NCT WISH, 위시, Stray Kids, 스키즈)" },
        { name: "member", type: "string", description: "멤버명. 한글 정식 이름/별명/로마자 모두 가능 (예: 리쿠, 릭구, riku)" },
        {
          name: "situation",
          type: "string",
          description: "상황 (공항 / 무대 / 브이로그 / 팬사인회 / 화보 / 일상 중 하나)",
        },
        { name: "category", type: "string", description: "카테고리 (가방, 모자, 신발 등)" },
        {
          name: "keywords",
          type: "string",
          description: "자유 텍스트 특징 묘사 (예: 블랙 숄더백, 은색 버클, 빨간 니트)",
        },
        {
          name: "includeAlternatives",
          type: "boolean",
          description: "true면 대체템도 섞어서 반환. 기본 false(원래 제품만). 예산 안의 대체템은 findAlternative를 쓰는 게 맞다.",
        },
        { name: "recommendationsOnly", type: "boolean", description: "추천 요청이면 true: 이미 산 제품을 제외하고 개인 취향·예산 순으로 추천한다. 특정 제품의 정체 확인은 false." },
        { name: "maxPrice", type: "integer", minimum: 0, description: "원화 예산 상한. 사용자가 3만원 이하 등 명시했다면 설정한다. 가격 미확인·외화 제품은 원화 예산으로 판단하지 못하므로 제외." },
        { name: "limit", type: "integer", description: "최대 결과 수 (최대 5)", minimum: 1, maximum: 5 },
      ],
    },
  ],
};

const MAX_RESULTS = 5; // 데이터가 커서 토큰 절약을 위해 결과를 항상 5개로 제한한다.

// 특정 멤버 검색은 정확히 그 멤버를 참조하고, '단체'는 같은 그룹일 때만 포함한다.
// 이름의 부분 문자열 비교는 '한' -> '한진'처럼 오검출을 일으켜 쓰지 않는다.
function exactMemberMatch(canonicalValue: string, filter: string, aliases: Aliases): boolean {
  const v = norm(canonicalValue);
  return v === filter || (aliases.members[canonicalValue] ?? []).some(alias => norm(alias) === filter);
}
function memberMatches(item: Item, filter: string, aliases: Aliases, scopedGroup: string): boolean {
  if (!filter) return true;
  if (item.member === "단체") return Boolean(scopedGroup) && fieldMatches(item.group, scopedGroup, aliases.groups);
  return exactMemberMatch(item.member, filter, aliases);
}

// 쇼핑 용어/색상은 한-영이 섞여 있다. 특히 '검은 목걸이'가 영어 제품명에도 맞아야 한다.
const KEYWORD_EQUIVALENTS: Record<string, string[]> = {
  "검정": ["검은", "블랙", "black", "검정색"], "검은": ["검정", "블랙", "black"],
  "블랙": ["black", "검정", "검은"], "흰": ["화이트", "white", "흰색"],
  "화이트": ["white", "흰색"], "갈색": ["브라운", "brown"],
  "브라운": ["brown", "갈색"], "파란": ["blue", "블루"],
  "핑크": ["pink", "분홍"], "목걸이": ["necklace", "pendant"],
  "모자": ["cap", "hat", "beanie", "베레모", "볼캡"],
  "가방": ["bag", "백팩", "백", "클러치", "토트"],
  "신발": ["sneaker", "boots", "shoe", "구두", "운동화"],
  "티셔츠": ["shirt", "tee", "t-shirt", "반팔티"],
};
function matches(item: Item, text: string, aliases: Aliases): boolean {
  if (!text) return true;
  const memberAliases = (aliases.members[item.member] ?? []).join(" ");
  const groupAliases = (aliases.groups[item.group] ?? []).join(" ");
  const haystack = `${item.group} ${item.member} ${item.situation} ${item.category} ${item.detailCategory ?? ""} ${item.brand} ${item.name} ${item.features} ${groupAliases} ${memberAliases}`.toLowerCase();
  // 각 단어가 발견돼야 하며, 색상/카테고리 동의어 중 하나도 허용한다.
  return text.split(/\s+/).filter(Boolean).every((token) => {
    const terms = [token, ...(KEYWORD_EQUIVALENTS[token] ?? [])];
    return terms.some(t => haystack.includes(t));
  });
}

function interleaveByFavorite(sorted: Item[], rank: (item: Item) => number, count: number, limit: number): Item[] {
  const buckets: Item[][] = Array.from({ length: count }, () => []);
  for (const item of sorted) buckets[Math.floor(rank(item) / 2)]?.push(item);
  const out: Item[] = [];
  while (out.length < limit && buckets.some((b) => b.length)) {
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next && out.length < limit) out.push(next);
    }
  }
  return out;
}

export const searchItemHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "search_item") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  let group = norm(args.group as string | undefined);
  const member = norm(args.member as string | undefined);
  const situation = norm(args.situation as string | undefined);
  const category = norm(args.category as string | undefined);
  const keywords = norm(args.keywords as string | undefined);
  const includeAlternatives = args.includeAlternatives === true;
  const maxPrice = typeof args.maxPrice === "number" && Number.isFinite(args.maxPrice) && args.maxPrice >= 0 ? args.maxPrice : undefined;
  const limit = typeof args.limit === "number" ? Math.min(MAX_RESULTS, Math.max(1, args.limit)) : MAX_RESULTS;

  const [items, aliases, state] = await Promise.all([loadItems(), loadAliases(), readState(context.user ?? "demo-user")]);
  const prefs = state.preferences;
  // 멤버만 지정했을 때 기존 '단체' 조건이 타 그룹까지 포함하던 문제를 차단한다.
  if (!group && member) {
    const groups = [...new Set(items.filter(i => i.member !== "단체" && exactMemberMatch(i.member, member, aliases)).map(i => i.group))];
    if (groups.length === 1) group = norm(groups[0]);
    else if (groups.length > 1) {
      const favorites = groups.filter(g => (prefs.favorites ?? []).some(f => f.group && fieldMatches(g, norm(f.group), aliases.groups)));
      if (favorites.length === 1) group = norm(favorites[0]);
      else return { status: "ambiguous_member", member: String(args.member), candidateGroups: groups,
        reason: "같은 멤버명이 여러 그룹에 있어요. 어느 그룹을 말하는지 먼저 물어봐 주세요.", count: 0, results: [] } as unknown as JsonValue;
    }
  }
  // 그룹·멤버를 안 정해서 물으면 저장된 최애 전체를 기준으로 찾는다(앞의 최애 우선).
  // 최애 멤버의 템 → 그 그룹의 다른 템 → 다음 최애 순서로 정렬된다.
  const favorites = (prefs.favorites ?? []).filter(f => f.group || f.member);
  const usedFavorites = !group && !member && favorites.length > 0;
  const favoriteGroups = [...new Set(favorites.map(f => f.group).filter((g): g is string => Boolean(g)))];
  if (usedFavorites && favoriteGroups.length === 1 && favorites.every(f => f.group)) group = norm(favoriteGroups[0]);
  const favoriteRank = (item: Item): number => {
    let best = -1;
    favorites.forEach((f, i) => {
      const fg = norm(f.group);
      const groupOk = !fg || fieldMatches(item.group, fg, aliases.groups);
      const rank = f.member && groupOk && memberMatches(item, norm(f.member), aliases, fg) ? 2 * i
        : fg && groupOk ? 2 * i + 1 : -1;
      if (rank >= 0 && (best < 0 || rank < best)) best = rank;
    });
    return best;
  };
  const recommendationsOnly = args.recommendationsOnly === true;
  const budget = recommendationsOnly ? prefs.budget : undefined;
  const colors = recommendationsOnly ? (prefs.colors ?? []).map(norm) : [];
  const preferenceScore = (item: Item): number => {
    let score = 0;
    if (budget !== undefined && item.price !== null && item.price <= budget) score += 3;
    if (budget !== undefined && item.price !== null && item.price > budget) score -= 2;
    if (colors.some(c => norm([item.name,item.features,item.detailCategory].join(" ")).includes(c))) score += 2;
    if (item.soldOut || item.stockStatus === "sold_out") score -= 3;
    if (item.matchType === "source_only") score -= 1; // 검증 데이터 우선
    return score;
  };
  const sorted = items
    // similar(유사 제품)는 alternativeOf로 묶인 "대체템"이 아니라 그 자체로 독립된 결과라서,
    // isSample과 달리 기본 검색에도 나와야 한다.
    .filter((item) => includeAlternatives || item.isOriginal || item.matchType === "similar" || item.matchType === "source_only")
    .filter((item) => fieldMatches(item.group, group, aliases.groups))
    .filter((item) => !usedFavorites || favoriteRank(item) >= 0)
    .filter((item) => memberMatches(item, member, aliases, group))
    .filter((item) => maxPrice === undefined || (item.price !== null && item.price <= maxPrice))
    .filter((item) => !recommendationsOnly || !state.owned.includes(item.id))
    .filter((item) => !situation || norm(item.situation).includes(situation))
    .filter((item) => !category || norm(`${item.category} ${item.detailCategory ?? ""}`).includes(category))
    .filter((item) => matches(item, keywords, aliases))
    .sort((a, b) => {
      if (usedFavorites) {
        const diff = favoriteRank(a) - favoriteRank(b);
        if (diff) return diff;
      }
      if (recommendationsOnly) {
        const diff = preferenceScore(b) - preferenceScore(a);
        if (diff) return diff;
      }
      if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
      return b.date.localeCompare(a.date);
    });
  // 최애 전체 기준일 때: 한 최애 템만으로 개수 상한이 차지 않게 최애마다 번갈아 담는다(첫 번째 최애부터).
  const results = usedFavorites && favorites.length > 1 ? interleaveByFavorite(sorted, favoriteRank, favorites.length, limit) : sorted.slice(0, limit);

  const result = {
    appliedPreferences: {
      favorites: usedFavorites ? favorites : null,
      budget: budget ?? null,
      maxPrice: maxPrice ?? null,
      colors: recommendationsOnly ? prefs.colors ?? [] : [],
      excludedOwned: recommendationsOnly,
    },
    query: { group: group || null, member: member || null, situation: situation || null, category: category || null, keywords: keywords || null },
    count: results.length,
    results,
  };
  emitCard({ tool: "searchItem", data: result, user: context.user }, dedupeKeyFor("searchItem", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
