import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { loadItems, loadPlaces, loadAliases, type Place } from "../data.js";
import { readState } from "../state.js";
import { emitCard, dedupeKeyFor } from "../bus.js";
import { norm, fieldMatches } from "../aliasMatch.js";
import { areaLabel, displayArea, placeMatchesArea } from "../geo.js";
import { orderByProximity } from "../routeOrder.js";
import { romanizePlaceName } from "../romanize.js";
import { favoriteTargets, groupVisitIndex, memberVisitIndex } from "./favoriteTargets.js";

const DAY_START_MIN = 10 * 60;
const DAY_END_MIN = 21 * 60;

function mustTryLabel(place: Place): string {
  const group = place.visits.find((v) => v.group)?.group;
  return group ? `${group} 픽` : "추천 메뉴";
}

// KSPO DOME처럼 여러 그룹이 공유하는 다목적 장소는 "방문: 단체, 단체…"로 중복 표시되거나,
// 특정 그룹 전용 성지인 양 최우선으로 뽑히면 안 된다 — 방문한 그룹 이름을 한 번씩만 모아 보여준다.
// 코스 라벨("보이넥스트도어가 다녀간 곳")에 쓸 한글 이름. 데이터 이름이 한글이면 그대로, 아니면
// aliases.json에서 같은 그룹·멤버의 한글 표기를 찾는다. 없으면 null(화면은 "BOYNEXTDOOR 방문"처럼 조사 없이).
// 별명 목록은 애칭("위시")이 앞에 오기도 해서, 가장 긴 한글 표기(보통 정식 이름: 엔시티위시)를 고른다.
const HANGUL = /[가-힣]/;
const longestHangul = (list: string[]) =>
  list.filter((a) => HANGUL.test(a)).sort((a, b) => b.length - a.length)[0] ?? null;
export function koreanName(name: string, aliasMap: Record<string, string[]>): string | null {
  if (HANGUL.test(name)) return name;
  const own = longestHangul(aliasMap[name] ?? []);
  if (own) return own;
  for (const [key, list] of Object.entries(aliasMap)) {
    if (norm(key) !== norm(name) && !list.some((a) => norm(a) === norm(name))) continue;
    const found = longestHangul([key, ...list]);
    if (found) return found;
  }
  return null;
}

function visitGroups(place: Place): string[] {
  return Array.from(new Set(place.visits.map((v) => v.group).filter(Boolean)));
}

export const planRouteDeclaration: ToolDeclaration = {
  name: "planRoute",
  summary:
    "지역·날짜·시간대로 성지(다녀간 장소) 코스를 짠다. 이미 다녀온 곳은 제외하고, 사용자가 찜/보유한 아이템의 브랜드 매장이 그 지역에 있으면 코스에 넣는다.",
  commands: [
    {
      key: "plan_route",
      name: "plan",
      reads: true,
      summary: "area(지역)로 성지 코스를 짠다. date/startTime은 참고용이고, 이미 방문한 곳은 자동으로 빠진다.",
      flags: [
        { name: "area", type: "string", description: "지역 (예: 홍대, 성수, 서울, Seoul, Yongsan-gu, 首尔, ソウル — 한국어·영어·일본어·중국어 지명 모두 가능). 사용자가 지역을 말하지 않았으면 비워 둔다: 최애 그룹 성지가 가장 많은 지역을 골라 짜고 autoArea로 알려 준다" },
        { name: "date", type: "string", description: "날짜 (예: 2026-10-24). 참고용, 영업시간 검증에는 쓰지 않음" },
        { name: "startTime", type: "string", description: "하루 시작 시각 HH:MM. 10:00~21:00 안에서만, 생략 시 10:00" },
        { name: "maxStops", type: "integer", minimum: 1, maximum: 6, description: "하루당 최대 코스 수 (기본 4)" },
        {
          name: "days",
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "여행 일수. '이틀 코스' 같은 요청이면 2를 넣는다 — 하루치씩 따로따로 부르지 말고 한 번에 요청한다. 날마다 다른 장소로, 시간은 10~21시 안에서 짠다.",
        },
        {
          name: "itemIds",
          type: "string",
          list: true,
          description:
            "같은 턴에 사용자가 방금 찜/구매한 아이템의 id가 있으면 같이 넘긴다. 저장 타이밍에 의존하지 않고 그 브랜드 매장을 코스에 바로 반영하기 위함.",
        },
        {
          name: "member",
          type: "string",
          description:
            "사용자가 이번에 말한 멤버. 성지는 그룹 단위라 그 멤버의 그룹이 다녀간 곳을 모두 대상으로 하고, 그 멤버 개인 기록이 있는 곳을 조금 더 먼저 넣는다. 비우면 저장된 최애 전체를 기준으로 한다.",
        },
        {
          name: "group",
          type: "string",
          description: "사용자의 최애 그룹 (member만 알아도 됨, 그룹은 자동으로 알아낸다). 같은 그룹 멤버가 다녀간 곳을 그 다음 우선순위로 넣는다.",
        },
      ],
    },
  ],
};

const TYPE_PRIORITY = ["카페", "매장", "포토스팟", "식당"];
function typeRank(type: string): number {
  const i = TYPE_PRIORITY.indexOf(type);
  return i === -1 ? TYPE_PRIORITY.length : i; // 목록에 없는 타입(명소/한식/해변 등 실제 데이터의 다양한 타입)은 맨 뒤로, 맨 앞으로 새치기하지 않게
}

function parseStartMinutes(startTime: unknown): number {
  const text = typeof startTime === "string" ? startTime.trim() : "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DAY_START_MIN; // default 10:00
  const hour = Math.min(23, Number(match[1]));
  const minute = Math.min(59, Number(match[2]));
  // 시간은 10~21시 안에서만.
  return Math.min(DAY_END_MIN, Math.max(DAY_START_MIN, hour * 60 + minute));
}

function formatMinutes(total: number): string {
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export const planRouteHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "plan_route") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  let area = String(args.area ?? "").trim();
  const date = typeof args.date === "string" ? args.date : null;
  const maxStops = typeof args.maxStops === "number" ? Math.min(6, Math.max(1, args.maxStops)) : 4;
  const days = typeof args.days === "number" ? Math.min(3, Math.max(1, Math.round(args.days))) : 1;
  const startMinutes = parseStartMinutes(args.startTime);

  const user = context.user ?? "demo-user";
  const [places, items, state, aliases] = await Promise.all([loadPlaces(), loadItems(), readState(user), loadAliases()]);

  // 최애: 사용자가 이번에 멤버·그룹을 말했으면 그 하나, 아니면 저장된 최애 전체(앞 순서 우선).
  const { targets } = favoriteTargets(args, state.preferences.favorites, items, aliases);

  // 지역을 말하지 않았으면: 최애 그룹 성지가 가장 많은 지역(시·도 + 구·군 단위)을 고른다.
  let autoArea: { picked: string; region: string; favoritePlaceCount: number; groups: string[]; reason: string } | null = null;
  let areaPlaces: Place[];
  if (!area) {
    if (!targets.length) return { status: "rejected", reason: "area(지역)나 최애(member/group) 중 하나는 있어야 해요." };
    const counts = new Map<string, { sample: Place; count: number; memberCount: number }>();
    for (const place of places) {
      if (visitGroups(place).length > 1 || state.visitedPlaces.includes(place.id)) continue; // 여러 그룹이 섞인 공연장은 지역 고르기에서 뺀다
      if (groupVisitIndex(place, targets, aliases) < 0 && memberVisitIndex(place, targets, aliases) < 0) continue;
      const entry = counts.get(place.region) ?? { sample: place, count: 0, memberCount: 0 };
      entry.count += 1;
      if (memberVisitIndex(place, targets, aliases) >= 0) entry.memberCount += 1;
      counts.set(place.region, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count || b.memberCount - a.memberCount)[0];
    if (!best) {
      const groupNames = [...new Set(targets.map((t) => t.groupName).filter(Boolean))].join(", ");
      const result = { status: "no_data", area: null, reason: `${groupNames || "최애"} 성지 정보는 아직 확인되지 않은 정보예요.`, course: [] as unknown[] };
      emitCard({ tool: "planRoute", data: result, user: context.user }, dedupeKeyFor("planRoute", invocation.key, args, context.causedBy));
      return result as unknown as JsonValue;
    }
    area = areaLabel(best.sample);
    const groups = [...new Set(targets.map((t) => t.groupName).filter((g): g is string => Boolean(g)))];
    autoArea = {
      picked: area,
      region: best.sample.region,
      favoritePlaceCount: best.count,
      groups,
      reason: `지역을 말하지 않아서 ${groups.join(", ") || "최애"} 성지가 가장 많은 ${area}(${best.count}곳)로 골랐다. 답할 때 어디로 골랐는지 한 줄로 말한다.`,
    };
    areaPlaces = places.filter((place) => place.region === best.sample.region);
  } else {
    areaPlaces = places.filter((place) => placeMatchesArea(place, area));
    // "Seoul", "首尔"로 물어도 화면·답변에는 데이터의 한국어 지역명("서울")을 쓰고, 영문 표기는 거기서 만든다.
    area = displayArea(areaPlaces, area);
  }
  if (areaPlaces.length === 0) {
    const result = { status: "no_data", area, areaEn: romanizePlaceName(area), reason: `'${area}' 지역의 성지 정보는 아직 확인되지 않은 정보예요.`, course: [] as unknown[] };
    emitCard({ tool: "planRoute", data: result, user: context.user }, dedupeKeyFor("planRoute", invocation.key, args, context.causedBy));
    return result as unknown as JsonValue;
  }

  const unvisited = areaPlaces.filter((place) => !state.visitedPlaces.includes(place.id));

  // Brands the user has shown interest in: wishlist/owned from the authoritative store, plus any
  // itemIds the model passes directly for this same turn (addWishlist's write may not have landed
  // yet if both tools are called in the same round — this flag makes the result independent of that).
  const explicitItemIds = Array.isArray(args.itemIds) ? (args.itemIds as unknown[]).map(String) : [];
  const interestingIds = new Set([...state.wishlist, ...state.owned, ...explicitItemIds]);
  const interestingBrands = new Set(
    items.filter((item) => interestingIds.has(item.id)).map((item) => item.brand),
  );
  const isBrandMatch = (place: Place): boolean =>
    place.type === "매장" && Array.from(interestingBrands).some((brand) => place.name.includes(brand) || place.note.includes(brand));

  // 우선순위: ① 최애 멤버 개인 방문 기록이 있는 곳 ② 최애 그룹이 다녀간 곳(단체 방문 포함 — 성지는 그룹 단위)
  // ③ 성지(isFandomSpot)이거나 착용 브랜드 매장 ④ 그 외 일반 명소(자리가 남을 때만).
  const memberIndex = (place: Place) => memberVisitIndex(place, targets, aliases);
  const groupIndex = (place: Place) => groupVisitIndex(place, targets, aliases);
  const memberVisitMatch = (place: Place): boolean => memberIndex(place) >= 0;
  const groupVisitMatch = (place: Place): boolean => groupIndex(place) >= 0;

  // 라벨용 실제 이름: 최애 멤버는 데이터의 정식 이름, 그룹은 그 장소 방문 기록에 적힌 그룹명.
  const visitLabel = (place: Place, kind: "member" | "group") => {
    const target = targets[kind === "member" ? memberIndex(place) : groupIndex(place)];
    if (!target) return null;
    const name = kind === "member"
      ? target.memberName
      : place.visits.find((v) => fieldMatches(v.group, target.group, aliases.groups))?.group ?? null;
    return name ? { kind, name, nameKo: koreanName(name, kind === "member" ? aliases.members : aliases.groups) } : null;
  };

  // KSPO DOME류의 다목적 장소(여러 그룹이 섞여 있음)는 최애 전용 성지처럼 최우선으로 뽑히면 안 된다.
  const isSharedVenue = (place: Place): boolean => visitGroups(place).length > 1;

  const visitScore = (place: Place): number => {
    if (!isSharedVenue(place) && memberVisitMatch(place)) return 4;
    if (!isSharedVenue(place) && groupVisitMatch(place)) return 3;
    if (place.isFandomSpot || isBrandMatch(place)) return 2;
    return 1;
  };

  // 같은 점수면 앞 순서 최애가 다녀간 곳 먼저.
  const favoriteOrder = (place: Place): number => {
    if (isSharedVenue(place)) return targets.length;
    const m = memberIndex(place);
    if (m >= 0) return m;
    const g = groupIndex(place);
    return g >= 0 ? g : targets.length;
  };
  const ranked = [...unvisited].sort((a, b) => {
    const scoreDiff = visitScore(b) - visitScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const orderDiff = favoriteOrder(a) - favoriteOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return typeRank(a.type) - typeRank(b.type);
  });

  const totalStops = maxStops * days;
  const chosen = ranked.slice(0, totalStops);

  // 날마다 다른 장소로: 랭킹 순서대로 하루당 maxStops개씩 나눠 담는다.
  const course: unknown[] = [];
  for (let day = 1; day <= days; day++) {
    // 그날 넣을 장소는 우선순위로 정하고, 순서는 가장 우선인 곳에서 출발해 가까운 곳끼리 잇는다(선 교차 방지).
    const dayPlaces = orderByProximity(chosen.slice((day - 1) * maxStops, day * maxStops));
    if (dayPlaces.length === 0) break;
    // 90분 간격이 10~21시를 넘으면 그 하루 분량 안에서 간격을 좁힌다.
    const span = DAY_END_MIN - startMinutes;
    const gap = dayPlaces.length > 1 ? Math.min(90, Math.floor(span / (dayPlaces.length - 1))) : 0;
    dayPlaces.forEach((place, index) => {
      course.push({
        day,
        time: formatMinutes(startMinutes + index * gap),
        placeId: place.id,
        name: place.name,
        area: place.area,
        type: place.type,
        address: place.address,
        openHours: place.openHours,
        note: place.note,
        visits: place.visits,
        visitGroups: visitGroups(place),
        isSharedVenue: isSharedVenue(place),
        isFandomSpot: place.isFandomSpot,
        isBrandMatch: isBrandMatch(place),
        isFavoriteMemberVisit: !isSharedVenue(place) && memberVisitMatch(place),
        isFavoriteGroupVisit: !isSharedVenue(place) && !memberVisitMatch(place) && groupVisitMatch(place),
        // 멤버 기록이 있으면 멤버 이름, 멤버 기록 없이 그룹 기록만 있으면 그룹 이름.
        visitLabel: isSharedVenue(place) ? null
          : memberVisitMatch(place) && targets[memberIndex(place)]?.memberName ? visitLabel(place, "member")
          : groupVisitMatch(place) ? visitLabel(place, "group") : null,
        mustTry: place.mustTry,
        mustTryLabel: mustTryLabel(place),
        tip: place.tip,
        lat: place.lat,
        lng: place.lng,
        naverMapUrl: place.naverMapUrl,
        recreeUrl: place.recreeUrl,
        imageUrl: place.imageUrl ?? null,
      });
    });
  }

  const excludedVisited = areaPlaces.length - unvisited.length;
  const result = {
    area,
    areaEn: romanizePlaceName(area),
    ...(autoArea ? { autoArea } : {}), // 한국어가 아닌 화면·답변에서 쓰는 지역 영문 표기 (서울 → Seoul)
    date,
    days,
    startTime: formatMinutes(startMinutes),
    excludedAlreadyVisited: excludedVisited,
    count: course.length,
    course,
  };
  emitCard({ tool: "planRoute", data: result, user: context.user }, dedupeKeyFor("planRoute", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
