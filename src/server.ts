// 덕메 (dukme) 웹 서버: 화면(public/) + 사용자별 에이전트(src/agent/) + Tool 실행과 데이터.
// 계속 켜져 있는 Node 서버 하나에서 돈다(서버리스 아님 — FileStorage는 폴더 하나를 프로세스 하나가 소유해야 한다).
// 부스 모드: 브라우저마다 익명 사용자(서명된 UUID 쿠키) → 사용자별 Croche 인스턴스·저장 폴더·app-state·SSE.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { AgentPool, PoolFullError, crocheOpener, type Session } from "./agent/index.js";
import { BOOTH_IDLE_RESET, HOST, LIMITS, PORT, PROJECT_ROOT, TRUST_PROXY, crocheKeys, sessionSecret } from "./config.js";
import { Identity } from "./identity.js";
import { HourlyLimit } from "./limits.js";
import { crocheStorageDir } from "./paths.js";
import { onCard } from "./bus.js";
import { clearStaleCrocheLocks } from "./staleLocks.js";
import { resetState, readState, updateState } from "./state.js";
import { loadAliases, loadItems, loadPlaces, type Item } from "./data.js";
import { diagnoseItemPreview, getMediaPreview } from "./mediaPreview.js";
import { REPLY_INSTRUCTION, resolveReplyLanguage } from "./language.js";
import { buildPersonalContext } from "./personalContext.js";
import { extractExplicitPreferences } from "./explicitPreferences.js";
import { applyFavoriteChange, buildFavoriteCatalog, favoritesLabel, noteFavoriteChange, rosterSummary, type FavoriteApplyResult } from "./favorite.js";

let keys: ReturnType<typeof crocheKeys>;
let secret: Buffer;
try {
  keys = crocheKeys();
  secret = sessionSecret();
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const identity = new Identity({ secret, trustProxy: TRUST_PROXY, newUsersPerIpPerHour: LIMITS.newUsersPerIpPerHour });
const globalLimit = new HourlyLimit(LIMITS.globalMessagesPerHour);

// SSE: 사용자별 화면 목록. 이벤트는 그 사용자의 화면에만 보낸다(전체 방송 금지 — 방문자끼리 섞이지 않게).
const pages = new Map<string, Set<ServerResponse>>();
const sendEvent = (res: ServerResponse, payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
function sendToUser(userId: string, payload: unknown): void {
  for (const page of pages.get(userId) ?? []) sendEvent(page, payload);
}

const pool = new AgentPool({
  open: crocheOpener(keys, { toolCallsPerTurn: LIMITS.toolCallsPerTurn }),
  maxSessions: LIMITS.maxSessions,
  idleMs: LIMITS.sessionIdleMinutes * 60 * 1000,
  onEvent: (userId, event) => sendToUser(userId, { source: "agent", event }),
  // "기억 초기화"를 턴 도중에 눌러 memory.clear()가 미뤄졌을 때: 그 턴 중 Tool이 예전 최애를 다시 쓸 수 있으니 한 번 더 비운다.
  onIdleAfterReset: (userId) => void resetState(userId).catch((error) => console.error("reset after turn failed:", error)),
});
onCard((card) => {
  if (card.user) sendToUser(card.user, { source: "card", event: { tool: card.tool, data: card.data } });
});

// 안 쓰는 인스턴스 정리(저장 폴더는 그대로), SSE 연결 유지용 핑(프록시가 조용한 연결을 끊지 않게).
setInterval(() => void pool.sweep().catch((error) => console.error("session sweep failed:", error)), 60 * 1000).unref();
setInterval(() => {
  for (const set of pages.values()) for (const page of set) page.write(": ping\n\n");
}, 25 * 1000).unref();

const hasCrocheStore = (userId: string) => existsSync(crocheStorageDir(userId));
/** 이미 대화한 적이 있는 사용자만 연다(첫 화면만 연 방문자를 위해 Croche 사용자를 만들지 않는다). */
async function sessionIfStarted(userId: string): Promise<Session | null> {
  return pool.peek(userId) ?? (hasCrocheStore(userId) ? pool.get(userId) : null);
}

// 언어 판별에서 빼는 고유명사: 멤버·그룹 이름과 별명, 지역 이름("I love 사쿠야", "목포 route"가 한국어로 잡히지 않게).
let properNounCache: string[] | null = null;
function languageProperNouns(catalog: ReturnType<typeof buildFavoriteCatalog>, places: Awaited<ReturnType<typeof loadPlaces>>): string[] {
  if (properNounCache) return properNounCache;
  const nouns = new Set<string>();
  for (const m of catalog.members) for (const v of [m.name, ...m.variants]) nouns.add(v);
  for (const g of catalog.groups) for (const v of [g.name, ...g.variants]) nouns.add(v);
  for (const place of places) {
    for (const token of [place.area, ...(place.region ?? "").split(/\s+/)]) {
      if (!token) continue;
      nouns.add(token);
      nouns.add(token.replace(/(특별자치시|특별자치도|통합특별시|특별시|광역시|도|시|군|구)$/, ""));
    }
  }
  for (const extra of ["홍대", "성수", "한남", "강남", "명동", "서울", "부산", "제주"]) nouns.add(extra);
  properNounCache = [...nouns].filter((n) => n.length >= 2);
  return properNounCache;
}

const BODY_LIMIT = 64 * 1024;
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_LIMIT) throw new HttpError(413, "too_large");
  }
  try {
    const parsed = JSON.parse(body || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(payload));
}

/** 요청한 브라우저의 익명 사용자. 새로 발급했으면 쿠키를 붙인다. IP별 새 사용자 상한이면 null(429를 이미 보냄). */
function who(req: IncomingMessage, res: ServerResponse): string | null {
  const result = identity.resolve(req);
  if (!result.ok) {
    json(res, 429, { error: result.reason });
    return null;
  }
  if (result.setCookie) res.setHeader("set-cookie", result.setCookie);
  return result.userId;
}

async function serveFile(res: ServerResponse, file: string, type: string): Promise<void> {
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(await readFile(join(PROJECT_ROOT, "public", file)));
}

const startedAt = Date.now();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      // Render healthCheckPath: 프로세스가 살아 있고 요청을 받는지만 본다(Croche 연결은 사용자 요청 때 연다).
      json(res, 200, { ok: true, sessions: pool.size, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      // 첫 화면에서 쿠키를 받아 두면 EventSource(/events)도 같은 사용자로 붙는다.
      const result = identity.resolve(req);
      if (result.ok && result.setCookie) res.setHeader("set-cookie", result.setCookie);
      await serveFile(res, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/markers.js") {
      await serveFile(res, "markers.js", "text/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/config") {
      // 화면이 알아야 하는 운영 설정(키·비밀값은 절대 넣지 않는다).
      json(res, 200, { boothIdleResetSeconds: BOOTH_IDLE_RESET, userMessageLimit: LIMITS.userMessages });
      return;
    }
    if (req.method === "GET" && url.pathname === "/media-preview") {
      const search = url.searchParams;
      const type = search.get("type");
      const id = search.get("id") ?? "";
      if ((type !== "item" && type !== "place") || id.length > 120 || !id) {
        res.writeHead(400).end();
        return;
      }
      const source = type === "item"
        ? (await loadItems()).find((i) => i.id === id)
        : (await loadPlaces()).find((p) => p.id === id);
      if (!source) { res.writeHead(404).end(); return; }
      // 사진이 안 뜰 때 원인 확인용(캐시 없이 손민수위키 페이지를 다시 읽어 단계별 결과를 보여 준다).
      if (type === "item" && search.get("debug") === "1") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          .end(JSON.stringify(await diagnoseItemPreview(source as Item), null, 2));
        return;
      }
      const preview = await getMediaPreview(type, id, source);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=900" })
        .end(JSON.stringify(preview ?? { imageUrl: null }));
      return;
    }

    // ── 여기부터는 사용자별 ──────────────────────────────────────────────
    const userId = who(req, res);
    if (!userId) return;

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const set = pages.get(userId) ?? new Set<ServerResponse>();
      set.add(res);
      pages.set(userId, set);
      req.on("close", () => {
        set.delete(res);
        if (!set.size) pages.delete(userId);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const payload = await readJson(req);
      const text = String(payload.text ?? "").trim().slice(0, 4000);
      if (!text) {
        res.writeHead(400).end();
        return;
      }
      const outcome = await pool.withUser(userId, async () => {
        // 과금 보호: Croche에 닿기 전에 사용자·전체 상한부터 본다.
        const before = await readState(userId);
        if (before.messagesSent >= LIMITS.userMessages) return { status: 429, body: { error: "user_limit" } };
        if (!globalLimit.tryTake()) return { status: 429, body: { error: "global_limit" } };
        const session = await pool.get(userId);
        // 초기화 뒤 새 턴이 시작되면 예약해 둔 재초기화는 버린다(새 턴에서 찜한 걸 지우지 않게).
        session.resetStateWhenIdle = false;
        await updateState(userId, (state) => { state.messagesSent += 1; });
        // Croche가 대화 이력을 초기화해도 앱에 저장된 최애·예산·구매·방문 정보는
        // 매 턴 별도 context로 전달한다 (SDK SendInput.context 공식 지원).
        const [items, places, aliases] = await Promise.all([loadItems(), loadPlaces(), loadAliases()]);
        const catalog = buildFavoriteCatalog(items, aliases);
        const explicit = extractExplicitPreferences(text, items, aliases, catalog);
        // Croche가 savePreferences를 생략한 턴에도 '내 최애는 사쿠야, 예산은 5만 원'
        // 처럼 사용자가 분명히 직접 말한 사실만 앱에 안전하게 보존한다.
        const { favorite, ...rest } = explicit;
        let favoriteApplied: FavoriteApplyResult | null = null;
        if (Object.keys(rest).length || favorite?.entries.length) {
          // 최애 추가/교체/삭제 규칙은 savePreferences Tool과 같다(src/favorite.ts applyFavoriteChange).
          favoriteApplied = await updateState(userId, state => {
            const applied = favorite ? applyFavoriteChange(state.preferences.favorites, favorite.mode, favorite.entries) : null;
            state.preferences = { ...state.preferences, ...rest };
            if (applied) {
              if (applied.favorites.length) state.preferences.favorites = applied.favorites;
              else delete state.preferences.favorites;
            }
            return applied;
          });
          if (favoriteApplied) noteFavoriteChange(userId, favoriteApplied);
        }
        let appState = await readState(userId);
        // 답할 언어: 이 메시지가 문장이면 그 언어, 짧거나 고유명사뿐이면 직전 대화 언어 유지.
        const replyLanguage = resolveReplyLanguage(text, {
          previous: appState.conversationLanguage ?? appState.preferences.language ?? null,
          properNouns: languageProperNouns(catalog, places),
        });
        if (replyLanguage !== appState.conversationLanguage) {
          appState = await updateState(userId, (state) => { state.conversationLanguage = replyLanguage; return state; });
        }
        // 화면 문구도 같은 판별 결과를 따른다 (화면이 따로 추측하지 않게).
        sendToUser(userId, { source: "lang", event: { lang: replyLanguage } });
        const context = {
          replyLanguage,
          replyInstruction: REPLY_INSTRUCTION[replyLanguage],
          ...buildPersonalContext(appState, session.handle.memoryList(), items, places),
          fanDataRoster: rosterSummary(catalog),
          // 이번 메시지에서 앱이 이미 반영한 최애 변경. 덕메는 이걸 기준으로 실제 저장된 것만 말한다.
          ...(favoriteApplied && (favoriteApplied.added.length || favoriteApplied.removed.length)
            ? { favoriteChangeThisTurn: { mode: favorite!.mode, added: favoritesLabel(favoriteApplied.added), removed: favoritesLabel(favoriteApplied.removed), nowSaved: favoritesLabel(favoriteApplied.favorites) || "(없음)" } }
            : {}),
          ...(favorite?.ambiguous.length
            ? { favoriteNeedsGroup: { ambiguous: favorite.ambiguous, note: "같은 이름이 여러 그룹에 있어 이 최애는 저장하지 않았다. 어느 그룹인지 물어본다." } }
            : {}),
        };
        const receipt = await session.handle.send({ id: randomUUID(), text, context });
        return { status: 200, body: receipt };
      });
      json(res, outcome.status, outcome.body);
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      // "새 대화": 대화창만 비움 (기억은 유지). "처음부터"/"기억 초기화": 대화 + AI 기억 + 찜/보유/방문 + 대화 언어 + 메시지 수까지
      // 전부 비움(다음 관람객용). 저장 폴더 자체는 지우지 않는다.
      const payload = await readJson(req);
      const scope = String(payload.scope ?? "conversation") === "all" ? "all" : "conversation";
      const result = await pool.withUser(userId, async () => {
        const session = await sessionIfStarted(userId);
        if (session) await session.handle.clearHistory();
        let memoryDeferred = false;
        if (scope === "all") {
          if (session) memoryDeferred = (await session.handle.memoryClear()).deferred;
          await resetState(userId);
          if (session && memoryDeferred && session.status !== "idle") session.resetStateWhenIdle = true;
        }
        return { ok: true, scope, memoryDeferred };
      });
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/memory/delete") {
      // 기억 패널에서 사용자가 직접 지우는 AI 기억 한 줄 (PRD §7). Croche 메모리 API는 삭제만 지원한다.
      const payload = await readJson(req);
      const id = String(payload.id ?? "").trim();
      if (!id) {
        res.writeHead(400).end();
        return;
      }
      const outcome = await pool.withUser(userId, async () => {
        const session = await sessionIfStarted(userId);
        return session ? session.handle.memoryDelete(id) : { deleted: false };
      });
      json(res, 200, { ok: true, outcome });
      return;
    }
    if (req.method === "POST" && url.pathname === "/favorite/remove") {
      // 기억 패널의 최애 ✕: 그 최애 하나만 지운다(멤버면 그 멤버, 그룹만 저장된 항목이면 그 그룹).
      const payload = await readJson(req);
      const entry = {
        ...(typeof payload.group === "string" && payload.group.trim() ? { group: payload.group.trim() } : {}),
        ...(typeof payload.member === "string" && payload.member.trim() ? { member: payload.member.trim() } : {}),
      };
      if (!entry.group && !entry.member) {
        res.writeHead(400).end();
        return;
      }
      const favorites = await pool.withUser(userId, () => updateState(userId, (state) => {
        const applied = applyFavoriteChange(state.preferences.favorites, "remove", [entry]);
        if (applied.favorites.length) state.preferences.favorites = applied.favorites;
        else delete state.preferences.favorites;
        return applied.favorites;
      }));
      json(res, 200, { ok: true, favorites });
      return;
    }
    if (req.method === "POST" && url.pathname === "/list/remove") {
      // 위시리스트/보유/방문 목록에서 한 항목을 사용자가 직접 지운다.
      const payload = await readJson(req);
      const list = payload.list;
      const id = String(payload.id ?? "").trim();
      if (!id || (list !== "wishlist" && list !== "owned" && list !== "visitedPlaces")) {
        res.writeHead(400).end();
        return;
      }
      await pool.withUser(userId, () => updateState(userId, (state) => {
        state[list] = state[list].filter((x) => x !== id);
      }));
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/purchase-click") {
      // 아이템 카드의 "사러 가기" 클릭 — 실제 구매 연동은 범위 밖(PRD §12). 화면 구석 카운터용으로 클릭 수만 센다.
      const { purchaseClicks } = await pool.withUser(userId, () => updateState(userId, (state) => {
        state.purchaseClicks += 1;
        return { purchaseClicks: state.purchaseClicks };
      }));
      json(res, 200, { purchaseClicks });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      // "내 덕질 기록" 패널: 자유 텍스트 기억은 Croche가 대화에서 적어두고, 찜/보유/방문 목록은 앱이 들고 있는다 (PRD §7).
      const session = await sessionIfStarted(userId);
      const memory = session ? session.handle.memoryList() : [];
      const [items, places, appState] = await Promise.all([loadItems(), loadPlaces(), readState(userId)]);
      const wishlist = appState.wishlist.map((id) => items.find((i) => i.id === id)).filter(Boolean);
      const owned = appState.owned.map((id) => items.find((i) => i.id === id)).filter(Boolean);
      const visitedPlaces = appState.visitedPlaces.map((id) => places.find((p) => p.id === id)).filter(Boolean);
      json(res, 200, {
        memory, preferences: appState.preferences, wishlist, owned, visitedPlaces, purchaseClicks: appState.purchaseClicks,
        replyLanguage: appState.conversationLanguage ?? appState.preferences.language ?? "en",
        messagesLeft: Math.max(0, LIMITS.userMessages - appState.messagesSent),
      });
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    if (error instanceof HttpError) {
      if (!res.headersSent) json(res, error.status, { error: error.code });
      return;
    }
    if (error instanceof PoolFullError) {
      if (!res.headersSent) json(res, 503, { error: "busy" });
      return;
    }
    console.error("request failed:", error);
    if (!res.headersSent) json(res, 500, { error: "server_error" });
  }
});

// 이전 컨테이너가 남긴 Croche 소유 기록을 지운 뒤에 요청을 받는다(재배포 후 store_busy 방지).
const staleLocks = await clearStaleCrocheLocks().catch((error) => {
  console.error("stale lock cleanup failed:", error);
  return 0;
});
if (staleLocks) console.log(`이전 프로세스의 Croche 잠금 기록 ${staleLocks}개 정리`);

server.listen(PORT, HOST, () => {
  console.log(`FanMate 서버: http://localhost:${PORT} (${keys.serverKey ? "서버 키" : "디버그 키(로컬 개발)"})`);
  for (const ip of lanAddresses()) console.log(`  같은 와이파이: http://${ip}:${PORT}`);
  if (BOOTH_IDLE_RESET) console.log(`  부스 모드: ${BOOTH_IDLE_RESET}초 동안 입력이 없으면 자동으로 처음부터`);
});

const stop = async () => {
  server.close();
  await pool.closeAll();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
