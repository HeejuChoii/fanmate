import assert from 'node:assert/strict';
import { extractExplicitPreferences } from '../src/explicitPreferences.js';
import type { Item } from '../src/data.js';
const items = [
  { group: 'NCT WISH', member: '사쿠야' },
  { group: 'NCT WISH', member: '리쿠' },
  { group: 'BTS', member: '뷔' },
] as Item[];
const first = extractExplicitPreferences('내 최애는 NCT WISH 사쿠야야. 손민수 예산은 5만 원이고, 찜한 것도 기억해 줘!', items);
assert.deepEqual(first, { budget: 50000, favorite: { mode: 'add', entries: [{ group: 'NCT WISH', member: '사쿠야' }], ambiguous: [] } });
assert.deepEqual(extractExplicitPreferences('내 최애 누구야? 예산 기억해?',items),{});
assert.deepEqual(extractExplicitPreferences('사쿠야 엄브로 자켓 139000원 찾아줘',items),{});
assert.deepEqual(extractExplicitPreferences('예산은 50,000원이야',items),{budget:50000});
console.log('PASS: first-turn explicit favorite/budget persist even without Croche tool call');
