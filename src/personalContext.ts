// Persistent, app-authoritative context passed to Croche separately from the user's message.
// The runtime supports SendInput.context; this ensures a new chat can still see saved preferences,
// purchases and visits without relying on the model to recall an earlier conversation.
import type { AppState } from './state.js';
import type { Item, Place } from './data.js';

export function buildPersonalContext(
  state: AppState,
  memory: Array<{ text: string }>,
  items: Item[],
  places: Place[],
) {
  const byItemId = new Map(items.map(i => [i.id, i]));
  const byPlaceId = new Map(places.map(p => [p.id, p]));
  const itemLabel = (id: string): Record<string, string> => {
    const item = byItemId.get(id);
    const result: Record<string, string> = { id };
    if (item) Object.assign(result, { group: item.group, member: item.member, brand: item.brand, name: item.name });
    return result;
  };
  const placeLabel = (id: string): Record<string, string> => {
    const place = byPlaceId.get(id);
    const result: Record<string, string> = { id };
    if (place) Object.assign(result, { name: place.name, region: place.region });
    return result;
  };
  return {
    kind: 'dukme_saved_user_context',
    note: '앱에서 저장한 현재 사용자 정보다. 새 대화를 시작해도 유지된다. 아래 personalProfile을 과거 대화의 다른 취향보다 우선한다. 사용자 질문에 직접 답하고, 정보를 지어내지 않는다.',
    // favorites: 최애 목록(여러 명 가능, 앞이 우선). 예: [{ group: 'BOYNEXTDOOR', member: '태산' }, { group: 'aespa', member: '카리나' }]
    personalProfile: {
      ...state.preferences,
      favorites: (state.preferences.favorites ?? []).map((f) => ({ ...f }) as Record<string, string>),
    },
    crocheLongTermMemories: memory.map(m => m.text).filter(Boolean).slice(-25),
    wishlist: state.wishlist.map(itemLabel),
    ownedItems: state.owned.map(itemLabel),
    visitedPlaces: state.visitedPlaces.map(placeLabel),
  };
}
