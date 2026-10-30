// App-authoritative structured state: wishlist / owned items / visited places.
// Croche's own agent memory remembers free-text facts (최애 그룹·멤버, 예산, 사이즈, 취향)
// from the conversation itself; this file is for the deterministic lists the tools mutate,
// per the Croche guidance to "keep authoritative inventory in the app". Plain JSON on disk,
// so it survives a server restart exactly like FileStorage does for the conversation.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appStateFile } from "./paths.js";

// 최애는 여러 명일 수 있다 (예: BOYNEXTDOOR 태산 + aespa 카리나). 그룹만 좋아하면 member 없이,
// 데이터에 없는 멤버면 group 없이 저장될 수 있다. 앞에 있을수록 우선(검색·코스 기본값).
export interface FavoriteEntry {
  group?: string;
  member?: string;
}

export interface FanPreferences {
  favorites?: FavoriteEntry[];
  budget?: number;
  colors?: string[];
  sizeTop?: string;
  sizeBottom?: string;
  sizeShoes?: string;
  shoppingMode?: "shopping" | "travel" | "both";
  language?: "ko" | "en" | "ja" | "zh-CN" | "zh-TW"; // 사용자가 선택한 응답 언어
}

export interface AppState {
  wishlist: string[]; // item ids
  owned: string[]; // item ids
  visitedPlaces: string[]; // place ids
  preferences: FanPreferences;
  purchaseClicks: number; // "사러 가기" 클릭 수 (데모용 카운터)
  messagesSent: number; // 이 사용자가 보낸 메시지 수 (사용자당 상한, "처음부터" 하면 0부터)
  conversationLanguage?: "ko" | "en" | "ja" | "zh-CN" | "zh-TW"; // 마지막으로 판별된 대화 언어 (짧은 대답은 이걸 유지)
}

// 예전 형식(favoriteGroup/favoriteMember 하나씩)으로 저장된 app-state도 그대로 읽히게 favorites로 바꾼다.
// 다음에 저장할 때 새 형식으로만 쓰인다.
export function migratePreferences(raw: unknown): FanPreferences {
  if (!raw || typeof raw !== "object") return {};
  const { favoriteGroup, favoriteMember, ...rest } = raw as FanPreferences & { favoriteGroup?: unknown; favoriteMember?: unknown };
  const preferences: FanPreferences = { ...rest };
  if (!Array.isArray(preferences.favorites)) {
    delete preferences.favorites;
    const legacy: FavoriteEntry = {};
    if (typeof favoriteGroup === "string" && favoriteGroup.trim()) legacy.group = favoriteGroup.trim();
    if (typeof favoriteMember === "string" && favoriteMember.trim()) legacy.member = favoriteMember.trim();
    if (legacy.group || legacy.member) preferences.favorites = [legacy];
  }
  return preferences;
}

function emptyState(): AppState {
  return { wishlist: [], owned: [], visitedPlaces: [], preferences: {}, purchaseClicks: 0, messagesSent: 0 };
}

// 사용자별: DATA_DIR/users/<id>/app-state.json (paths.ts가 id 모양을 확인한다).
const stateFile = appStateFile;

export async function readState(user: string): Promise<AppState> {
  try {
    const raw = await readFile(stateFile(user), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      wishlist: parsed.wishlist ?? [],
      owned: parsed.owned ?? [],
      visitedPlaces: parsed.visitedPlaces ?? [],
      purchaseClicks: parsed.purchaseClicks ?? 0,
      messagesSent: parsed.messagesSent ?? 0,
      ...(parsed.conversationLanguage ? { conversationLanguage: parsed.conversationLanguage } : {}),
      preferences: migratePreferences(parsed.preferences),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeStateRaw(user: string, state: AppState): Promise<void> {
  const target = stateFile(user);
  await mkdir(path.dirname(target), { recursive: true });
  // 임시 파일에 쓰고 rename — 동시 쓰기가 섞여서 JSON이 깨지는 걸 막는다 (rename은 원자적).
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, target);
}

export async function writeState(user: string, state: AppState): Promise<void> {
  await writeStateRaw(user, state);
}

export async function resetState(user: string): Promise<void> {
  await writeStateRaw(user, emptyState());
}

// 같은 유저에 대해 updateOwned/markVisited/addWishlist가 한 턴에 같이 호출되는 경우가 있어서,
// 읽고-고치고-쓰는 전체 과정을 유저별로 한 번에 하나씩만 돌게 직렬화한다 (lost-update 방지).
const locks = new Map<string, Promise<unknown>>();

export async function updateState<T>(user: string, mutate: (state: AppState) => T | Promise<T>): Promise<T> {
  const previous = locks.get(user) ?? Promise.resolve();
  let result!: T;
  const next = previous
    .catch(() => {})
    .then(async () => {
      const state = await readState(user);
      result = await mutate(state);
      await writeStateRaw(user, state);
    });
  locks.set(user, next);
  await next;
  return result;
}
