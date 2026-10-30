import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { findItemById, loadItems } from "../data.js";
import { emitCard, dedupeKeyFor } from "../bus.js";

export const findAlternativeDeclaration: ToolDeclaration = {
  name: "findAlternative",
  summary:
    "원래 제품(itemId)의 대체템을 예산(maxPrice) 안에서 찾는다. 원래 제품이 예산을 넘을 때만 쓰고, 검색 결과가 여러 개여도 대표 아이템 1개에 대해서만 호출한다 (여러 아이템마다 전부 부르지 않는다).",
  commands: [
    {
      key: "find_alternative",
      name: "find",
      reads: true,
      summary: "searchItem으로 찾은 원래 제품의 id로 대체템을 찾는다. maxPrice가 있으면 그 가격 이하만 반환한다.",
      flags: [
        { name: "itemId", type: "string", required: true, description: "원래 제품의 id (예: item_001)" },
        { name: "maxPrice", type: "integer", minimum: 0, description: "원 단위 최대 예산 (예: 50000)" },
      ],
    },
  ],
};

export const findAlternativeHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "find_alternative") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  const itemId = String(args.itemId ?? "").trim();
  const maxPrice = typeof args.maxPrice === "number" ? args.maxPrice : undefined;

  const original = await findItemById(itemId);
  if (!original) {
    return { status: "rejected", reason: `itemId '${itemId}'를 data/items.json에서 찾을 수 없어요.` };
  }

  const items = await loadItems();
  const alternatives = items
    .filter((item) => item.alternativeOf === itemId)
    // price가 없고 priceText만 있는 아이템(해외 통화 등)은 원화 예산과 비교할 수 없으니 그냥 포함시킨다.
    .filter((item) => maxPrice === undefined || item.price === null || item.price <= maxPrice)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .map((item) => ({
      ...item,
      savingsVsOriginal: original.price !== null && item.price !== null ? original.price - item.price : null,
    }));

  const result = { original, maxPrice: maxPrice ?? null, count: alternatives.length, alternatives };
  emitCard({ tool: "findAlternative", data: result, user: context.user }, dedupeKeyFor("findAlternative", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
