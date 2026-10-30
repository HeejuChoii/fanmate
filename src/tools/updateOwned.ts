import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { findItemById } from "../data.js";
import { updateState } from "../state.js";
import { emitCard, dedupeKeyFor } from "../bus.js";

export const updateOwnedDeclaration: ToolDeclaration = {
  name: "updateOwned",
  summary: "사용자가 아이템을 실제로 '샀다'고 말했을 때, 그 아이템을 보유 목록으로 옮긴다 (위시리스트에 있었으면 거기서는 빠진다).",
  commands: [
    {
      key: "update_owned",
      name: "update",
      reads: false,
      summary: "itemId를 보유 목록에 추가한다. 사용자가 '샀어', '샀다', '구매했어' 처럼 실제 구매를 명확히 말했을 때만 호출한다.",
      flags: [{ name: "itemId", type: "string", required: true, description: "구매한(보유하게 된) 아이템의 id" }],
    },
  ],
};

export const updateOwnedHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "update_owned") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  const itemId = String(args.itemId ?? "").trim();

  const item = await findItemById(itemId);
  if (!item) {
    return { status: "rejected", reason: `itemId '${itemId}'를 data/items.json에서 찾을 수 없어요.` };
  }

  const user = context.user ?? "demo-user";
  const { alreadyOwned, wasInWishlist, ownedCount } = await updateState(user, (state) => {
    const alreadyOwned = state.owned.includes(itemId);
    const wasInWishlist = state.wishlist.includes(itemId);
    if (!alreadyOwned) state.owned.push(itemId);
    if (wasInWishlist) state.wishlist = state.wishlist.filter((id) => id !== itemId);
    return { alreadyOwned, wasInWishlist, ownedCount: state.owned.length };
  });

  const result = {
    updated: !alreadyOwned,
    alreadyOwned,
    movedFromWishlist: wasInWishlist,
    item,
    ownedCount,
  };
  emitCard({ tool: "updateOwned", data: result, user: context.user }, dedupeKeyFor("updateOwned", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
