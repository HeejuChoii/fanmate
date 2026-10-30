// tasteMatch(Qloo) Tool: 실제 Qloo 대신 fetch를 가짜로 바꿔서 요청 형식·결과 정리·카드 전송을 확인한다.
import assert from "node:assert/strict";
import { onCard } from "../src/bus.ts";
import { tasteMatchHandler } from "../src/tools/tasteMatch.ts";
import { loadItems } from "../src/data.ts";

process.env.QLOO_API_KEY = "test-key";
const calls: URL[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(url);
  assert.equal((init?.headers as Record<string, string>)["X-Api-Key"], "test-key");
  assert.equal(url.origin, "https://hackathon.api.qloo.com");
  let body: unknown;
  if (url.pathname === "/search") {
    body = { results: [{ name: url.searchParams.get("query"), entity_id: `E-${url.searchParams.get("query")}`, types: [url.searchParams.get("types")] }] };
  } else if (url.pathname === "/v2/tags") {
    body = { results: { tags: [{ tag_id: "urn:tag:category:place:cafe", name: "Cafe" }] } };
  } else {
    const type = url.searchParams.get("filter.type");
    body = {
      results: {
        entities: [
          { name: "Brand One", entity_id: "B1", subtype: type, query: { affinity: 0.91 }, properties: { address: "Seongsu, Seoul" } },
          { name: "Brand Two", entity_id: "B2", subtype: type, query: { affinity: 0.83 } },
        ],
      },
    };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const cards: unknown[] = [];
onCard((c) => cards.push(c));
const ctx = { user: "u1", causedBy: ["t1"] } as never;

const item = (await loadItems())[0];
const brands = (await tasteMatchHandler({ key: "similar_brands", args: { itemId: item.id, alsoLikes: "Carhartt" } } as never, ctx)) as any;
assert.equal(brands.kind, "brands");
assert.equal(brands.results.length, 2);
const insights = calls.find((u) => u.pathname === "/v2/insights")!;
assert.equal(insights.searchParams.get("filter.type"), "urn:entity:brand");
assert.ok(insights.searchParams.get("signal.interests.entities")!.split(",").length >= 2, "brand + alsoLikes seeds");

calls.length = 0;
const places = (await tasteMatchHandler({ key: "places_nearby", args: { area: "Seongsu, Seoul", vibe: "cafe" } } as never, ctx)) as any;
assert.equal(places.kind, "places");
const placeCall = calls.find((u) => u.pathname === "/v2/insights")!;
assert.equal(placeCall.searchParams.get("filter.location.query"), "Seongsu, Seoul");
assert.equal(placeCall.searchParams.get("signal.interests.tags"), "urn:tag:category:place:cafe");

const artists = (await tasteMatchHandler({ key: "artists", args: { group: "aespa" } } as never, ctx)) as any;
assert.equal(artists.kind, "artists");
assert.equal(cards.length, 3, "one card per call");

delete process.env.QLOO_API_KEY;
const off = (await tasteMatchHandler({ key: "artists", args: { group: "aespa" } } as never, ctx)) as any;
assert.equal(off.status, "rejected");

console.log("PASS: tasteMatch → Qloo /search, /v2/tags, /v2/insights");
