// A tool handler runs inside the same server process as the web page's SSE connections.
// Rather than guess at the shape of tool-result events on the Croche agent stream, handlers
// publish their own structured result here, and the server forwards it to the page verbatim.
// This keeps card rendering tied to the actual data the tool returned, not a re-parse of text.
export interface CardEvent {
  tool: "searchItem" | "findAlternative" | "addWishlist" | "planRoute" | "updateOwned" | "markVisited" | "findPlaces" | "tasteMatch";
  data: unknown;
  /** 이 카드를 받을 사용자(Tool context.user). 서버는 그 사용자의 화면에만 보낸다 — 방문자끼리 섞이지 않게. */
  user: string | null | undefined;
}

type Listener = (event: CardEvent) => void;

const listeners = new Set<Listener>();

export function onCard(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 모델이 같은 도구를 같은 인자로 한 턴 안에서 두 번 부를 때가 있어서(재시도/혼동), 카드가 화면에
// 두 번 뜨는 걸 막는다. dedupeKey가 최근에 이미 쓰였으면 카드를 또 띄우지 않는다 — 도구 실행 자체나
// 모델에게 돌려주는 결과는 그대로이고, 화면 카드만 한 번으로 줄인다.
const recentEmits = new Map<string, number>();
const DEDUP_WINDOW_MS = 60000;

function pruneRecentEmits(now: number): void {
  if (recentEmits.size < 200) return;
  for (const [key, ts] of recentEmits) {
    if (now - ts > DEDUP_WINDOW_MS) recentEmits.delete(key);
  }
}

export function dedupeKeyFor(tool: string, key: string, args: unknown, causedBy: readonly string[] | undefined): string {
  return `${tool}:${(causedBy ?? []).join(",")}:${key}:${JSON.stringify(args)}`;
}

export function emitCard(event: CardEvent, dedupeKey?: string): void {
  if (dedupeKey) {
    const now = Date.now();
    const last = recentEmits.get(dedupeKey);
    if (last && now - last < DEDUP_WINDOW_MS) return;
    recentEmits.set(dedupeKey, now);
    pruneRecentEmits(now);
  }
  for (const listener of listeners) listener(event);
}
