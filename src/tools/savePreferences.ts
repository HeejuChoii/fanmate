import type { ToolDeclaration, ToolHandler, JsonValue } from "@h1r-ai/croche";
import { updateState, type FanPreferences } from "../state.js";
import { loadAliases, loadItems } from "../data.js";
import { applyFavoriteChange, buildFavoriteCatalog, favoritesLabel, resolveFavoriteArgs, withRecentFavoriteChange, type FavoriteMode } from "../favorite.js";

export const savePreferencesDeclaration: ToolDeclaration = {
  name: "savePreferences",
  summary: "대화에서 사용자가 직접 밝힌 최애·예산·색·사이즈·쇼핑/성지 모드를 구조화해 저장한다. 재방문 후 추천 Tool이 실제로 이 값을 적용할 수 있게 한다.",
  commands: [{
    key: "save_preferences", name: "save", reads: false,
    summary: "사용자가 명시적으로 이야기하거나 변경한 항목만 전송한다. 모르는 값은 추측하지 않는다.",
    flags: [
      { name: "favoriteGroup", type: "string", description: "최애 그룹의 정식 이름" },
      { name: "favoriteMember", type: "string", description: "최애 멤버. 여러 명이면 쉼표로(예: '태산, 카리나'). 그룹을 몰라도 멤버만 보내면 앱 데이터에서 그룹을 찾아 같이 저장한다" },
      { name: "favoriteMode", type: "string", description: "add(기본: '~도 있어', '또', '추가'), replace('최애 바뀌었어', '이제 ~만', '~로 갈아탔어'), remove('~는 이제 아니야', '빼줘'). 애매하면 add. 최애는 여러 명 저장된다" },
      { name: "budget", type: "integer", minimum: 0, description: "현재 쇼핑 예산(원)" },
      { name: "colors", type: "string", description: "좋아하는 색상 목록, 쉼표 구분" },
      { name: "sizeTop", type: "string", description: "상의 사이즈" },
      { name: "sizeBottom", type: "string", description: "하의 사이즈" },
      { name: "sizeShoes", type: "string", description: "신발 사이즈" },
      { name: "shoppingMode", type: "string", description: "shopping(쇼핑), travel(성지), both(둘 다) 중 하나" },
      { name: "language", type: "string", description: "사용자가 명시한 선호 응답 언어: ko, en, ja, zh-CN(간체), zh-TW(번체)" },
    ],
  }],
};

export const savePreferencesHandler: ToolHandler = async (invocation, context) => {
  if (invocation.key !== "save_preferences") return { status: "rejected", reason: "지원하지 않는 동작" };
  const a = invocation.args as Record<string, unknown>;
  const changes: FanPreferences = {};
  for (const key of ["sizeTop", "sizeBottom", "sizeShoes"] as const) {
    if (typeof a[key] === "string" && a[key].trim()) changes[key] = a[key].trim().slice(0,80);
  }
  if (typeof a.budget === "number" && Number.isSafeInteger(a.budget) && a.budget >= 0 && a.budget <= 100000000) changes.budget = a.budget;
  if (typeof a.colors === "string" && a.colors.trim()) {
    changes.colors = a.colors.split(/[,，/]/).map(v => v.trim()).filter(Boolean).slice(0,8);
  }
  if (a.shoppingMode === "shopping" || a.shoppingMode === "travel" || a.shoppingMode === "both") changes.shoppingMode = a.shoppingMode;
  if (["ko", "en", "ja", "zh-CN", "zh-TW"].includes(String(a.language))) changes.language = a.language as "ko" | "en" | "ja" | "zh-CN" | "zh-TW";
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
  const mode: FavoriteMode = a.favoriteMode === "replace" || a.favoriteMode === "remove" ? a.favoriteMode : "add";
  const [items, aliases] = await Promise.all([loadItems(), loadAliases()]);
  const catalog = buildFavoriteCatalog(items, aliases);
  const wantsFavorite = Boolean(text(a.favoriteGroup) || text(a.favoriteMember));
  const mention = wantsFavorite ? resolveFavoriteArgs(text(a.favoriteGroup), text(a.favoriteMember), catalog) : { entries: [], ambiguous: [] };
  if (!Object.keys(changes).length && !mention.entries.length) {
    if (mention.ambiguous.length) {
      return { status: "needs_group", ambiguous: mention.ambiguous,
        reason: "같은 이름의 멤버가 여러 그룹에 있어 최애를 저장하지 않았다. candidateGroups 중 어느 그룹인지 사용자에게 물어본다." } as unknown as JsonValue;
    }
    return { status: "ignored", reason: "확인된 변경 사항 없음" };
  }
  const user = context.user ?? "demo-user";
  const { preferences, applied: appliedNow } = await updateState(user, state => {
    const applied = applyFavoriteChange(state.preferences.favorites, mode, mention.entries);
    state.preferences = { ...state.preferences, ...changes, favorites: applied.favorites };
    if (!applied.favorites.length) delete state.preferences.favorites;
    return { preferences: state.preferences, applied };
  });
  const applied = withRecentFavoriteChange(user, mode, mention.entries, appliedNow);
  // 덕메가 "저장했어"라고 말하기 전에 실제로 무엇이 저장·삭제됐는지 확인할 수 있게 그대로 돌려준다.
  const result: Record<string, unknown> = {
    status: "saved",
    preferences,
    favorites: { mode, nowSaved: favoritesLabel(applied.favorites) || "(없음)", added: applied.added, removed: applied.removed },
  };
  const notes: string[] = [];
  if (wantsFavorite && mention.entries.length && !applied.added.length && !applied.removed.length) notes.push("최애 목록은 바뀌지 않았다(이미 저장돼 있거나 지울 항목이 없음).");
  if (applied.notFound.length) notes.push(`저장돼 있지 않아 지우지 못했다: ${favoritesLabel(applied.notFound)}`);
  if (mention.ambiguous.length) notes.push("같은 이름의 멤버가 여러 그룹에 있어 일부 최애는 저장하지 않았다. 어느 그룹인지 물어본다.");
  if (mention.ambiguous.length) Object.assign(result, { favoriteNotSaved: mention.ambiguous });
  if (notes.length) Object.assign(result, { note: notes.join(" ") });
  return result as unknown as JsonValue;
};
