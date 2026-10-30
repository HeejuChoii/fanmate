// tasteMatch: FanMate's Qloo-powered tool.
// Our data knows WHAT the idol wore and WHERE they went. Qloo knows what people with that taste
// also love. This tool joins the two:
//   - similar_brands: idol's (often luxury) brand -> Qloo brands with a similar taste profile
//   - places_nearby: an area (+ a pilgrimage spot / vibe) -> Qloo places there that fit the fan's taste
//   - artists: the fan's group -> artists their taste graph says they'll also love
import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { findItemById, findPlaceById } from "../data.js";
import { emitCard, dedupeKeyFor } from "../bus.js";
import { qlooConfigured, qlooInsights, qlooSearch, qlooTags, type QlooEntity } from "../qloo.js";

const BRAND = "urn:entity:brand";
const PLACE = "urn:entity:place";
const ARTIST = "urn:entity:artist";

export const tasteMatchDeclaration: ToolDeclaration = {
  name: "tasteMatch",
  summary:
    "Qloo taste graph. Finds brands, places or artists that people with the same taste love. " +
    "Use it to go beyond our database: affordable brands with the same vibe as an idol's item, places in an area that fit the fan's taste, and artists to discover.",
  commands: [
    {
      key: "similar_brands",
      name: "brands",
      reads: true,
      summary:
        "Brands with a similar taste profile to an idol item's brand (Qloo Insights). Pass itemId from searchItem, or a brand name. " +
        "Use when the original is over budget (alongside findAlternative) or when the fan asks for 'more like this'.",
      flags: [
        { name: "itemId", type: "string", description: "Original item id from searchItem (e.g. item_037)" },
        { name: "seedBrands", type: "string", description: "Use ONLY when a previous call returned resolved=false: 1-3 well-known brands with a similar style to the original, comma separated (e.g. 'Thisisneverthat, Stussy')" },
        { name: "brand", type: "string", description: "Brand name if there is no itemId (e.g. Acne Studios)" },
        { name: "alsoLikes", type: "string", description: "Optional: other brands the fan loves, comma separated, to personalize (e.g. Carhartt, Stussy)" },
      ],
    },
    {
      key: "places_nearby",
      name: "places",
      reads: true,
      summary:
        "Places in an area that match the fan's taste (Qloo Insights, location-filtered). Pass the area in English (e.g. 'Seongsu, Seoul'). " +
        "Seed it with a pilgrimage spot (placeId from planRoute) and/or a vibe (e.g. 'dessert cafe', 'vintage shop').",
      flags: [
        { name: "area", type: "string", required: true, description: "Area in English, e.g. 'Seongsu, Seoul', 'Hannam, Seoul', 'Seoul'" },
        { name: "placeId", type: "string", description: "Optional pilgrimage spot id from planRoute to use as the taste seed" },
        { name: "vibe", type: "string", description: "Optional vibe/category keyword, e.g. 'cafe', 'bakery', 'vintage clothing'" },
      ],
    },
    {
      key: "artists",
      name: "artists",
      reads: true,
      summary: "Artists the fan will probably also love, based on their favorite group (Qloo Insights).",
      flags: [{ name: "group", type: "string", required: true, description: "Group name in English (e.g. aespa, RIIZE, NCT WISH)" }],
    },
  ],
};

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Qloo 검색 결과가 정말 같은 이름인지 확인한다. ("NO MANUAL"이 "Proper No. Twelve"로 잡히는 일 방지) */
function sameName(query: string, found: string): boolean {
  const q = norm(query);
  const f = norm(found);
  if (!q || !f) return false;
  if (q === f || f.startsWith(q + " ") || q.startsWith(f + " ")) return true;
  const qt = q.split(" ").filter((w) => w.length > 1);
  const ft = new Set(f.split(" "));
  return qt.length > 0 && qt.every((w) => ft.has(w));
}

async function firstEntity(text: string, type: string, strict = true): Promise<QlooEntity | undefined> {
  if (!text.trim()) return undefined;
  const hits = await qlooSearch(text.trim(), [type], 5);
  return strict ? hits.find((h) => sameName(text, h.name)) : hits[0];
}

// 브랜드 추천에서 패션과 상관없는 결과(피트니스 앱 등)를 뒤로 미룬다.
const FASHION = /fashion|apparel|cloth|wear|street|luxury|designer|denim|knit|shoe|sneaker|boot|accessor|jewel|bag|handbag|watch|eyewear|beauty|cosmetic|casual|outdoor|vintage|boutique|style|tailor|couture|leather|sport/i;
function fashionFirst(list: QlooEntity[]): QlooEntity[] {
  const looks = (e: QlooEntity) => FASHION.test([e.type, e.description, ...(e.tags ?? [])].join(" "));
  const good = list.filter(looks);
  return good.length >= 3 ? good : [...good, ...list.filter((e) => !looks(e))];
}

async function similarBrands(args: Record<string, unknown>) {
  const itemId = String(args.itemId ?? "").trim();
  const item = itemId ? await findItemById(itemId) : undefined;
  const brandName = String(item?.brand ?? args.brand ?? "").trim();
  if (!brandName) return { status: "rejected", reason: "Need itemId or brand." };

  const seed = await firstEntity(brandName, BRAND);
  const styleSeeds = String(args.seedBrands ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  const extras = [...styleSeeds, ...String(args.alsoLikes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)];
  const extraSeeds = (await Promise.all(extras.map((b) => firstEntity(b, BRAND).catch(() => undefined)))).filter(Boolean) as QlooEntity[];
  const seedIds = [seed, ...extraSeeds].filter(Boolean).map((e) => e!.entityId);
  if (!seed && !styleSeeds.length) {
    // 원래 브랜드를 Qloo가 모르면, 엉뚱한 브랜드로 추천하지 않고 모델에게 비슷한 스타일의 유명 브랜드로 다시 시도하게 한다.
    return {
      kind: "brands",
      seedBrand: brandName,
      resolved: false,
      results: [],
      note: `Qloo doesn't know "${brandName}" yet. Call tasteMatch similar_brands once more with the same itemId and seedBrands = 1-3 well-known brands with a similar style.`,
    };
  }
  if (!seedIds.length) return { kind: "brands", seedBrand: brandName, resolved: false, results: [], note: "Qloo could not resolve any seed brand." };
  const exclude = new Set([brandName.toLowerCase(), ...extras.map((b) => b.toLowerCase())]);
  const results = fashionFirst((await qlooInsights({ type: BRAND, entities: seedIds, take: 15 })).filter((e) => !exclude.has(e.name.toLowerCase()))).slice(0, 6);
  return {
    kind: "brands",
    seedBrand: seed?.name ?? brandName,
    seededBy: [seed, ...extraSeeds].filter(Boolean).map((e) => e!.name),
    original: item ? { id: item.id, brand: item.brand, name: item.name, price: item.price, group: item.group, member: item.member } : null,
    personalizedWith: extraSeeds.map((e) => e.name),
    resolved: Boolean(seed),
    results,
  };
}

async function placesNearby(args: Record<string, unknown>) {
  const area = String(args.area ?? "").trim() || "Seoul";
  const placeId = String(args.placeId ?? "").trim();
  const vibe = String(args.vibe ?? "").trim();
  const spot = placeId ? await findPlaceById(placeId) : undefined;

  const entitySeeds: string[] = [];
  if (spot) {
    const hit = await firstEntity(spot.name, PLACE).catch(() => undefined);
    if (hit) entitySeeds.push(hit.entityId);
  }
  const tagSeeds = vibe ? (await qlooTags(vibe, 2).catch(() => [])).map((t) => t.id) : [];

  let results = await qlooInsights({ type: PLACE, entities: entitySeeds, tags: tagSeeds, location: area, take: 8 }).catch(() => []);
  let broadened = false;
  if (!results.length && area.toLowerCase() !== "seoul") {
    results = await qlooInsights({ type: PLACE, entities: entitySeeds, tags: tagSeeds, location: "Seoul", take: 8 }).catch(() => []);
    broadened = results.length > 0;
  }
  if (!results.length && (entitySeeds.length || tagSeeds.length)) {
    results = await qlooInsights({ type: PLACE, location: area, take: 8 });
  }
  const spotName = spot?.name.toLowerCase();
  return {
    kind: "places",
    area: broadened ? "Seoul" : area,
    broadened,
    seedSpot: spot ? { id: spot.id, name: spot.name } : null,
    vibe: vibe || null,
    results: results.filter((r) => r.name.toLowerCase() !== spotName).slice(0, 6),
  };
}

async function artists(args: Record<string, unknown>) {
  const group = String(args.group ?? "").trim();
  if (!group) return { status: "rejected", reason: "Need group." };
  const seed = await firstEntity(group, ARTIST);
  if (!seed) return { kind: "artists", seedArtist: group, resolved: false, results: [] };
  const results = (await qlooInsights({ type: ARTIST, entities: [seed.entityId], take: 8 }))
    .filter((e) => e.name.toLowerCase() !== seed.name.toLowerCase())
    .slice(0, 6);
  return { kind: "artists", seedArtist: seed.name, resolved: true, results };
}

export const tasteMatchHandler: ToolHandler = async (invocation, context) => {
  if (!qlooConfigured()) return { status: "rejected", reason: "Qloo is not configured on this server." };
  const args = invocation.args as Record<string, unknown>;
  try {
    let result: Record<string, unknown>;
    if (invocation.key === "similar_brands") result = await similarBrands(args);
    else if (invocation.key === "places_nearby") result = await placesNearby(args);
    else if (invocation.key === "artists") result = await artists(args);
    else return { status: "rejected", reason: "Unknown command." };

    if ("kind" in result) {
      emitCard({ tool: "tasteMatch", data: result, user: context.user }, dedupeKeyFor("tasteMatch", invocation.key, args, context.causedBy));
    }
    return result as unknown as JsonValue;
  } catch (error) {
    // 네트워크·API 오류는 한 번만 알리고 재시도를 반복하지 않는다(CLAUDE.md 원칙 7).
    return { status: "rejected", reason: `Qloo request failed: ${String((error as Error)?.message ?? error).slice(0, 160)}. Do not retry this turn.` };
  }
};
