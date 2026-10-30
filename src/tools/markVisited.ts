import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { findPlaceById } from "../data.js";
import { updateState } from "../state.js";
import { emitCard, dedupeKeyFor } from "../bus.js";

export const markVisitedDeclaration: ToolDeclaration = {
  name: "markVisited",
  summary: "사용자가 다녀온 성지(장소)를 방문 기록으로 남긴다. planRoute로 짜줬던 코스의 placeId들을 그대로 넘기면 된다.",
  commands: [
    {
      key: "mark_visited",
      name: "mark",
      reads: false,
      summary: "placeIds를 방문 기록에 추가한다. 사용자가 '다녀왔어', '갔다 왔어' 처럼 말했을 때, 대화에서 짜줬던 코스의 placeId들을 넘긴다.",
      flags: [
        { name: "placeIds", type: "string", list: true, required: true, description: "다녀온 장소들의 id 목록" },
      ],
    },
  ],
};

export const markVisitedHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "mark_visited") {
    return { status: "rejected", reason: "알 수 없는 동작이에요." };
  }
  const args = invocation.args as Record<string, unknown>;
  const requested = Array.isArray(args.placeIds) ? (args.placeIds as unknown[]).map(String) : [];
  if (requested.length === 0) return { status: "rejected", reason: "placeIds가 필요해요." };

  const resolved = await Promise.all(requested.map((id) => findPlaceById(id)));
  const valid = resolved.filter((p): p is NonNullable<typeof p> => Boolean(p));
  const invalidIds = requested.filter((id, i) => !resolved[i]);

  const user = context.user ?? "demo-user";
  const { newlyVisited, visitedCount } = await updateState(user, (state) => {
    const newlyVisited = valid.filter((p) => !state.visitedPlaces.includes(p.id));
    for (const place of newlyVisited) state.visitedPlaces.push(place.id);
    return { newlyVisited, visitedCount: state.visitedPlaces.length };
  });

  const result = {
    marked: newlyVisited.map((p) => ({ id: p.id, name: p.name })),
    alreadyVisited: valid.filter((p) => !newlyVisited.includes(p)).map((p) => ({ id: p.id, name: p.name })),
    invalidIds,
    visitedCount,
  };
  emitCard({ tool: "markVisited", data: result, user: context.user }, dedupeKeyFor("markVisited", invocation.key, args, context.causedBy));
  return result as unknown as JsonValue;
};
