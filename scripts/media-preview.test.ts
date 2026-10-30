import assert from 'node:assert/strict';
import { extractWikiPreview, diagnoseWikiHtml } from '../src/mediaPreview.js';

const base = 'https://sonminsoo.kr/item/c285f509-8b17-4668-8520-82079e518c07';
const OG = '<meta property="og:image" content="https://cdn.sonminsoo.kr/og/composite-member.jpg">';

// og:image(멤버 합성 공유 카드)만 있으면 쓰지 않는다 → 아이콘 유지
assert.equal(extractWikiPreview(`<html><head>${OG}</head><body></body></html>`, base), null);

// ld+json 이미지가 og:image와 같은 주소면 같은 합성 이미지 → 제외
const ldSame = `<head>${OG}<script type="application/ld+json">{"@type":"Product","image":"https://cdn.sonminsoo.kr/og/composite-member.jpg?w=1200"}</script></head>`;
assert.equal(extractWikiPreview(ldSame, base), null);

// ld+json Product 이미지가 og와 다르면 제품 사진으로 쓴다
const ldProduct = `<head>${OG}<script type="application/ld+json">{"@type":"Product","image":["https://cdn.sonminsoo.kr/products/jacket.jpg"]}</script></head>`;
assert.deepEqual(extractWikiPreview(ldProduct, base), { imageUrl: 'https://cdn.sonminsoo.kr/products/jacket.jpg', kind: 'photo', source: 'sonminsoo' });

// 예전 구조: 사진 섹션의 두 번째 figure가 제품, 첫 번째는 아이돌 참고 사진
const section = `<section aria-label="사진"><figure><img src="/img/idol.jpg"><figcaption>착용 사진</figcaption></figure><figure><img src="/img/product.jpg"><figcaption>제품 사진</figcaption></figure></section>`;
assert.equal(extractWikiPreview(section, base)?.imageUrl, 'https://sonminsoo.kr/img/product.jpg');
// 순서가 바뀌어도 캡션으로 제품 figure를 고른다
const swapped = `<section aria-label="사진"><figure><img src="/img/product.jpg"><figcaption>제품</figcaption></figure><figure><img src="/img/idol.jpg"><figcaption>멤버 착용</figcaption></figure></section>`;
assert.equal(extractWikiPreview(swapped, base)?.imageUrl, 'https://sonminsoo.kr/img/product.jpg');
// 두 번째 figure가 아이돌 캡션이면 고르지 않는다
const idolSecond = `<section aria-label="사진"><figure><img src="/a.jpg"></figure><figure><img src="/b.jpg"><figcaption>공항 착용</figcaption></figure></section>`;
assert.equal(extractWikiPreview(idolSecond, base), null);

// alt가 "제품"인 img (구조 변경 대응), 멤버 착용 alt는 제외
const alt = `<img src="https://cdn.sonminsoo.kr/m/sakuya.jpg" alt="사쿠야 착용 사진"><img src="https://cdn.sonminsoo.kr/p/item.jpg" alt="제품 이미지">`;
assert.equal(extractWikiPreview(alt, base)?.imageUrl, 'https://cdn.sonminsoo.kr/p/item.jpg');

// 클라이언트 렌더링 데이터(이스케이프된 JSON) 안의 productImage 키
const rsc = `${OG}<script>self.__next_f.push([1,"{\\"title\\":\\"x\\",\\"image\\":\\"https:\\/\\/cdn.sonminsoo.kr\\/m\\/member.jpg\\",\\"productImageUrl\\":\\"https:\\/\\/cdn.sonminsoo.kr\\/p\\/umbro.jpg\\"}"])</script>`;
assert.equal(extractWikiPreview(rsc, base)?.imageUrl, 'https://cdn.sonminsoo.kr/p/umbro.jpg');
const nextData = `<script id="__NEXT_DATA__" type="application/json">{"props":{"item":{"image":"https://cdn.sonminsoo.kr/m/member.jpg","product_image":"https://cdn.sonminsoo.kr/p/bag.png"}}}</script>`;
assert.equal(extractWikiPreview(nextData, base)?.imageUrl, 'https://cdn.sonminsoo.kr/p/bag.png');
// 일반 "image" 키만 있으면(멤버 사진일 수 있음) 고르지 않는다
assert.equal(extractWikiPreview(`<script>{"image":"https://cdn.sonminsoo.kr/m/member.jpg"}</script>`, base), null);

assert.match(diagnoseWikiHtml(`<html><head>${OG}</head><body><div id="root"></div></body></html>`, base).reason, /클라이언트 렌더링/);
console.log('PASS: 손민수위키 제품 사진만 고르고 og:image(멤버 합성)는 쓰지 않음');

// item.imageUrl이 있으면 페이지를 읽지 않고 바로 쓴다 (https 절대 주소만)
{
  const { getMediaPreview } = await import('../src/mediaPreview.js');
  const base = { wikiUrl: null, matchType: 'exact' } as any;
  const ok = await getMediaPreview('item', 't_ok', { ...base, id: 't_ok', imageUrl: 'https://hhyaidumvkylewdgojnu.supabase.co/storage/v1/object/public/question-images/answers/x.jpg' });
  assert.deepEqual(ok, { imageUrl: 'https://hhyaidumvkylewdgojnu.supabase.co/storage/v1/object/public/question-images/answers/x.jpg', kind: 'photo', source: 'sonminsoo' });
  assert.equal(await getMediaPreview('item', 't_http', { ...base, id: 't_http', imageUrl: 'http://example.com/a.jpg' }), null);
  assert.equal(await getMediaPreview('item', 't_rel', { ...base, id: 't_rel', imageUrl: '/a.jpg' }), null);
  assert.equal(await getMediaPreview('item', 't_logo', { ...base, id: 't_logo', imageUrl: 'https://cdn.example.com/logo.png' }), null);
  console.log('PASS: item.imageUrl 바로 사용(https 절대 주소만)');
}
