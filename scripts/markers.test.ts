import assert from 'node:assert/strict';
import '../public/markers.js';

const { extractMarkers, resolveExpression } = (globalThis as any).DukmeMarkers as {
  extractMarkers: (text: string, options?: { streaming?: boolean }) => { text: string; markers: string[] };
  resolveExpression: (markers: string[]) => string;
};
const final = (t: string) => extractMarkers(t);
const streaming = (t: string) => extractMarkers(t, { streaming: true });

// 실제 버그: 콜론 뒤 공백
assert.deepEqual(final(': happy: Hey, welcome!'), { text: 'Hey, welcome!', markers: ['happy'] });
// 여러 변형: 공백, 전각 콜론, 대소문자
assert.deepEqual(final(':happy : 반가워!').markers, ['happy']);
assert.equal(final(':happy : 반가워!').text, '반가워!');
assert.deepEqual(final('：happy： 좋아!'), { text: '좋아!', markers: ['happy'] });
assert.deepEqual(final(':Happy: Nice :SORRY:'), { text: 'Nice', markers: ['happy', 'sorry'] });
assert.deepEqual(final('찾았어 :think: 이거 어때 : cheer :'), { text: '찾았어 이거 어때', markers: ['think', 'cheer'] });
// 마커가 문장부호 앞에 남기던 공백도 정리
assert.equal(final('Found it :happy:!').text, 'Found it!');
// 정상 마커
assert.deepEqual(final(':sorry: 아직 확인되지 않은 정보예요'), { text: '아직 확인되지 않은 정보예요', markers: ['sorry'] });
// 맨 앞의 알 수 없는 :word: 는 숨김 (중간 것은 그대로 — 일반 글일 수 있음)
assert.equal(final(':wave: Hi there').text, 'Hi there');
assert.equal(final(':wave::sparkles: Hi').text, 'Hi');
assert.equal(final('시간은 10:30 이야').text, '시간은 10:30 이야');
assert.equal(final('Note: happy hour starts at 5').text, 'Note: happy hour starts at 5');
assert.equal(final('Hi :) see you').text, 'Hi :) see you');
assert.equal(final('Hi :) see you').markers.length, 0);

// 스트리밍 조각 경계에서 잘린 마커: 받은 만큼의 원문을 매번 다시 정리한다
const pieces = [': hap', 'py: Hey', ', wel', 'come! :th', 'ink: Let me', ' check.'];
let raw = '';
const seen: string[] = [];
for (const piece of pieces) {
  raw += piece;
  seen.push(streaming(raw).text);
}
assert.ok(seen.every((t) => !/[:：]\s*(h|ha|hap|happy|t|th|thi|think)\b/i.test(t)), `잘린 마커가 보이면 안 됨: ${JSON.stringify(seen)}`);
assert.equal(seen[0], '');
assert.equal(seen[1], 'Hey');
assert.deepEqual(final(raw), { text: 'Hey, welcome! Let me check.', markers: ['happy', 'think'] });
// 스트리밍 중 끝의 콜론은 잠깐 숨겨도, 최종 텍스트에서는 살아 있다
assert.equal(streaming('예산은:').text, '예산은');
assert.equal(final('예산은:').text, '예산은:');

// 표정 우선순위
assert.equal(resolveExpression(['think', 'happy']), 'happy');
assert.equal(resolveExpression(['sorry', 'cheer']), 'cheer');
assert.equal(resolveExpression([]), 'idle');
assert.equal(resolveExpression(['HAPPY']), 'happy');
console.log('PASS: 표정 마커 느슨하게 인식(공백·전각·대소문자·조각 경계), 맨 앞 알 수 없는 마커 숨김');
