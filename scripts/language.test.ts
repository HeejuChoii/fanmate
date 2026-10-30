import assert from 'node:assert/strict';
import { REPLY_INSTRUCTION, REPLY_LANGUAGES, resolveReplyLanguage, requestedLanguage } from '../src/language.js';
import { romanizePlaceName } from '../src/romanize.js';
import { planRouteHandler } from '../src/tools/planRoute.js';
import { readState, resetState, updateState } from '../src/state.js';

const properNouns = ['사쿠야', '태산', '카리나', 'boynextdoor', '목포', '서울', 'sakuya', 'taesan', '용산구', '용산'];
const r = (text: string, previous: any) => resolveReplyLanguage(text, { previous, properNouns });

// 짧거나 판단이 안 되는 메시지는 직전 언어 유지
for (const short of ['yes!!', 'ok', 'Yes', 'okay~', '👍', '🥹🥹', '123', '10:30', 'BOYNEXTDOOR', 'NCT WISH', '사쿠야', 'Taesan!', '네', 'ㅇㅇ', 'ㅋㅋㅋ', 'thanks!!', '?']) {
  assert.equal(r(short, 'en'), 'en', `${short} (직전 en)`);
  assert.equal(r(short, 'ja'), 'ja', `${short} (직전 ja)`);
}
assert.equal(r('yes', 'ko'), 'ko');
assert.equal(r('ok', 'zh-TW'), 'zh-TW');

// 문장을 쓰면 그 언어로 바뀐다
assert.equal(r('sounds good, plan it', 'ko'), 'en');
assert.equal(r('좋아 그걸로 해줘', 'en'), 'ko');
assert.equal(r('このバッグ探して', 'en'), 'ja');
assert.equal(r('帮我找一下这个包', 'en'), 'zh-CN');
assert.equal(r('幫我找這個包包', 'en'), 'zh-TW');
// 고유명사(멤버·지역)는 언어 신호가 아니다
assert.equal(r('plan me a route in 목포', 'ko'), 'en');
assert.equal(r('I love 사쿠야 so much', 'ko'), 'en');
assert.equal(r('사쿠야 가방 찾아줘', 'en'), 'ko');
assert.equal(r('show me 용산구 spots', 'ko'), 'en');
// 첫 메시지는 한 단어여도
assert.equal(r('hello', null), 'en');
assert.equal(r('안녕', null), 'ko');
assert.equal(r('👍', null), 'en'); // FanMate: default English

// 언어를 직접 요청하면 문장 언어보다 우선
assert.equal(requestedLanguage('영어로 답해줘'), 'en');
assert.equal(r('영어로 답해줘', 'ko'), 'en');
assert.equal(r('please reply in Korean', 'en'), 'ko');
assert.equal(r('日本語で話して', 'ko'), 'ja');
assert.equal(r('请用简体中文回答', 'en'), 'zh-CN');
assert.equal(r('請用繁體中文回答', 'en'), 'zh-TW');
assert.equal(requestedLanguage('I want an English muffin'), null);

// 지역명 영문 표기
const expected: Record<string, string> = {
  서울: 'Seoul', 서울특별시: 'Seoul', 용산구: 'Yongsan-gu', 종로구: 'Jongno-gu', 강릉시: 'Gangneung-si', 목포시: 'Mokpo-si',
  목포: 'Mokpo', 양평군: 'Yangpyeong-gun', 해운대구: 'Haeundae-gu', 중구: 'Jung-gu', 대구: 'Daegu', 부산: 'Busan',
  홍대: 'Hongdae', 성수: 'Seongsu', 명동: 'Myeong-dong', 신라: 'Silla', 한국: 'Korea', 강원특별자치도: 'Gangwon-do',
  '서울특별시 용산구': 'Seoul Yongsan-gu', Seoul: 'Seoul',
};
for (const [ko, en] of Object.entries(expected)) assert.equal(romanizePlaceName(ko), en, ko);

// planRoute가 화면·답변용 영문 지역명을 같이 돌려준다
const user = 'test-language';
const ctx = { user, causedBy: [] } as unknown as Parameters<typeof planRouteHandler>[1];
try {
  await resetState(user);
  const route = await planRouteHandler({ key: 'plan_route', args: { area: '용산구' } } as any, ctx) as any;
  assert.equal(route.areaEn, 'Yongsan-gu');
  const none = await planRouteHandler({ key: 'plan_route', args: { area: '없는동네' } } as any, ctx) as any;
  assert.equal(none.status, 'no_data');
  assert.ok(none.areaEn);
} finally {
  await resetState(user);
}
// 언어별 지시문은 그 언어로 쓰여 있다
for (const lang of REPLY_LANGUAGES) assert.ok(REPLY_INSTRUCTION[lang], lang);
assert.match(REPLY_INSTRUCTION.ja, /[\u3040-\u30ff]/);
assert.match(REPLY_INSTRUCTION['zh-CN'], /简体/);
assert.match(REPLY_INSTRUCTION['zh-TW'], /繁體/);
assert.match(REPLY_INSTRUCTION.en, /English/);
assert.match(REPLY_INSTRUCTION.ko, /한국어/);

// 기억 초기화(scope=all)는 대화 언어도 비운다 → 다음 관람객은 한국어로 시작
await updateState(user, (s) => { s.conversationLanguage = 'ja'; });
assert.equal((await readState(user)).conversationLanguage, 'ja');
await resetState(user);
assert.equal((await readState(user)).conversationLanguage, undefined);
assert.equal(resolveReplyLanguage('👍', { previous: (await readState(user)).conversationLanguage ?? null }), 'en');

console.log('PASS: 대화 언어 고정(짧은 대답은 직전 언어), 언어 직접 요청, 지역명 영문 표기');
