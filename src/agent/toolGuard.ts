// 과금 보호: 한 턴(같은 사용자 입력)에서 실행하는 Tool 호출 수 상한.
// 넘으면 Tool을 실행하지 않고 거절 결과를 돌려준다 — 모델은 그 결과를 보고 지금까지 찾은 걸로 답한다.
import type { ToolHandler } from "@h1r-ai/croche";

const TURN_TTL_MS = 10 * 60 * 1000;

export function limitToolCallsPerTurn(handlers: Record<string, ToolHandler>, maxPerTurn: number, now: () => number = Date.now): Record<string, ToolHandler> {
  const counts = new Map<string, { count: number; at: number }>();
  const prune = () => {
    if (counts.size < 500) return;
    const cutoff = now() - TURN_TTL_MS;
    for (const [key, value] of counts) if (value.at < cutoff) counts.delete(key);
  };
  const guarded: Record<string, ToolHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    guarded[name] = (invocation, context) => {
      // causedBy = 이 Tool 호출을 일으킨 입력 id들 → 같은 턴이면 같은 키.
      const key = `${context.user ?? ""}|${(context.causedBy ?? []).join(",")}`;
      const entry = counts.get(key) ?? { count: 0, at: now() };
      entry.count += 1;
      entry.at = now();
      counts.set(key, entry);
      prune();
      if (entry.count > maxPerTurn) {
        return {
          status: "rejected",
          reason: `이번 턴에 도구를 너무 많이 불렀다(상한 ${maxPerTurn}번). 더 부르지 말고 지금까지 받은 결과만으로 답한다.`,
        };
      }
      return handler(invocation, context);
    };
  }
  return guarded;
}
