// Deterministic fallback for *explicitly stated* Korean favourite and budget facts.
// Croche still performs its normal Memory and savePreferences Tool actions, but the
// demo must not lose clear declarations if a model turn omits the tool call.
import type { FanPreferences } from './state.js';
import type { Aliases, Item } from './data.js';
import { buildFavoriteCatalog, detectFavoriteMode, detectFavoritesInText, type FavoriteCatalog, type FavoriteMention, type FavoriteMode } from './favorite.js';

// 최애는 여러 명일 수 있어서 preferences에 바로 덮어쓰지 않고 "무엇을 어떻게 바꾸라는지"로 돌려준다.
// 적용은 server.ts가 savePreferences Tool과 같은 applyFavoriteChange(src/favorite.ts)로 한다.
export type ExplicitPreferences = Omit<FanPreferences, 'favorites'> & {
  favorite?: { mode: FavoriteMode } & FavoriteMention;
};

export function extractExplicitPreferences(
  text: string,
  items: Item[],
  aliases: Aliases = { members: {}, groups: {} },
  catalog: FavoriteCatalog = buildFavoriteCatalog(items, aliases),
): ExplicitPreferences {
  const changes: ExplicitPreferences = {};
  const mode = detectFavoriteMode(text);
  const asksWho = /최애(?:가|는)?\s*누구/.test(text);
  const saysFavorite = /최애/.test(text);
  if (!asksWho) {
    // "최애"를 말했으면 말한 이름 전부. 말하지 않았으면 "태산은 빼줘", "카리나만 좋아", "카리나로 갈아탔어",
    // "카리나도 좋아"처럼 이름 바로 뒤에 표현이 붙은 것만 최애 변경으로 본다.
    // 삭제는 "최애"를 말했어도 이름 바로 뒤에 삭제 표현이 붙은 것을 먼저 본다("카리나만 남기고 태산은 빼줘").
    let mention = saysFavorite && mode !== 'remove' ? detectFavoritesInText(text, catalog) : detectFavoritesInText(text, catalog, { onlyBefore: mode });
    if (saysFavorite && mode === 'remove' && !mention.entries.length) mention = detectFavoritesInText(text, catalog);
    if (mention.entries.length || mention.ambiguous.length) changes.favorite = { mode, ...mention };
  }
  const match = text.match(/(?:손민수\s*)?예산(?:은|이|으로|을|은\s*)?[^.!?\n]{0,25}?(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*원/);
  if (match) {
    const base = Number(match[1]!.replace(/,/g, ''));
    const multiplier = match[2] === '만' ? 10000 : match[2] === '천' ? 1000 : 1;
    const amount = base * multiplier;
    if (Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000) changes.budget = amount;
  }
  return changes;
}
