import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { findItemById } from "../data.js";
import { updateState } from "../state.js";
import { emitCard, dedupeKeyFor } from "../bus.js";

export const addWishlistDeclaration: ToolDeclaration = {
  name: "addWishlist",
  summary: "사용자가 찜한(사고 싶은) 아이템을 위시리스트에 추가한다. 사용자가 '찜해줘', 'A로 할래' 처럼 명확히 요청했을 때만 쓴다.",
  commands: [
    {
      key: "add_wishlist",
      name: "add",
      reads: false,
      summary: "itemId를 위시리스트에 추가한다. 사용자가 특정 아이템을 고르거나 찜하겠다고 말했을 때 호출한다.",
      flags: [{ name: "itemId", type: "string", required: true, description: "찜할 아이템의 id" }],
    },
  ],
};

export const addWishlistHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "add_wishlist") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  const itemId = String(args.itemId ?? "").trim();

  const item = await findItemById(itemId);
  if (!item) {
    return { status: "rejected", reason: `itemId '${itemId}'를 data/items.json에서 찾을 수 없어요.` };
  }

  const user = context.user ?? "demo-user";
  const { already, wishlistCount } = await updateState(user, (state) => {
    const already = state.wishlist.includes(itemId);
    if (!already) state.wishlist.push(itemId);
    return { already, wishlistCount: state.wishlist.length };
  });

  const result = { added: !already, alreadyInWishlist: already, item, wishlistCount };
  emitCard({ tool: "addWishlist", data: result, user: context.user }, dedupeKeyFor("addWishlist", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
