import assert from 'node:assert/strict';
import { buildPersonalContext } from '../src/personalContext.js';
import type { AppState } from '../src/state.js';
import type { Item, Place } from '../src/data.js';

const state: AppState = {
  preferences: { favorites: [{ group: 'NCT WISH', member: '사쿠야' }, { group: 'aespa', member: '카리나' }], budget: 50000 },
  wishlist: ['item_013'], owned: [], visitedPlaces: ['place_001'], purchaseClicks: 0,
};
const item = { id: 'item_013', group: 'NCT WISH', member: '사쿠야', brand: '엄브로', name: '사이드 다이아 트랙 자켓' } as Item;
const place = { id: 'place_001', name: '목포 성지', region: '전남' } as Place;
const context = buildPersonalContext(state, [], [item], [place]);
assert.deepEqual(context.personalProfile.favorites, [{ group: 'NCT WISH', member: '사쿠야' }, { group: 'aespa', member: '카리나' }]);
assert.equal(context.personalProfile.budget, 50000);
assert.equal(context.wishlist[0].id, 'item_013');
assert.equal(context.visitedPlaces[0].name, '목포 성지');
assert.equal(context.crocheLongTermMemories.length, 0);
const existingMemoryContext = buildPersonalContext(state, [{text:'사쿠야 좋아함'}], [], []);
assert.equal(existingMemoryContext.crocheLongTermMemories[0], '사쿠야 좋아함');
console.log('PASS: persisted personal profile appears in every Croche send context, including after new chat');
