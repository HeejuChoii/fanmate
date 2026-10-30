/**
 * Read-only image previews from the owner's public 손민수위키 / reCree detail pages.
 * Never guesses an image based on a product name or substitutes a different item's photo.
 * A missing/blocked page simply produces null, and the UI keeps its current icon.
 */
import type { Item, Place } from './data.js';

export type MediaPreview = { imageUrl: string; kind: 'photo' | 'share_preview'; source: 'sonminsoo' | 'recree' } | null;
const cache = new Map<string, { until: number; pending: Promise<MediaPreview> }>();
const CACHE_MS = 30 * 60 * 1000;
const ALLOWED_PAGE_HOSTS = new Set(['sonminsoo.kr', 'www.sonminsoo.kr', 'recree.io', 'www.recree.io']);
// Hand-verified public images from the same reCree pages for the NCT WISH Mokpo demo.
// These display immediately even if metadata extraction is temporarily blocked.
const FEATURED_RECREe_PHOTOS: Record<string, string> = {
  'place_165': 'https://cdn.recree.io/post-images/banner/ebce25b8-02f4-40bd-9167-6972058028f7/1791820822156-hct58q0crhg.png',
  'place_344': 'https://cdn.recree.io/post-images/banner/new/1789972490791-j7yrbdsbu5.png',
  'place_161': 'https://cdn.recree.io/post-images/banner/a8aeee92-fc06-43e6-9102-1a22214d1fa9/1791821548780-c2iqbacpqjf.png',
};


function pageUrl(input: string | null | undefined, host: 'sonminsoo.kr' | 'recree.io'): URL | null {
  if (!input) return null;
  try {
    const u = new URL(input);
    return u.protocol === 'https:' && (u.hostname === host || u.hostname === `www.${host}`) ? u : null;
  } catch { return null; }
}

export function safeImageUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const decoded = value.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"');
  try {
    const u = new URL(decoded.trim(), base);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname || u.href.length > 3500) return null;
    if (/\.(svg)(?:\?|$)/i.test(u.pathname) || /(?:logo|favicon|avatar|placeholder)/i.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? "").replace(/&amp;/g, '&').replace(/&quot;/g, '"') : null;
}
function meta(html: string, property: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase() === property.toLowerCase()) return attr(tag, 'content');
  }
  return null;
}
function selectLdPhoto(doc: unknown): string | null {
  if (Array.isArray(doc)) {
    for (const part of doc) { const found = selectLdPhoto(part); if (found) return found; }
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const r = doc as Record<string, unknown>;
  if (r['@graph']) return selectLdPhoto(r['@graph']);
  const types = Array.isArray(r['@type']) ? r['@type'] : [r['@type']];
  if (!types.some(t => t === 'Product' || t === 'Place')) return null;
  const raw = r.image;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.find(x => typeof x === 'string') ?? null;
  if (raw && typeof raw === 'object') return String((raw as Record<string, unknown>).url ?? '');
  return null;
}

// 손민수위키 상품 페이지에서 "제품 사진"만 고른다. 아이돌(멤버) 사진은 절대 쓰지 않는다.
// - og:image는 멤버 사진이 합성된 공유 카드라서 쓰지 않는다(대체로도 쓰지 않음 → 화면은 아이콘 유지).
// - ld+json Product image가 og:image와 같은 주소면 같은 합성 이미지이므로 버린다.
// - 페이지 구조가 바뀌어도 잡히도록 몇 가지 경로를 순서대로 본다. 아무것도 확실하지 않으면 null.
const IDOL_HINT = /(?:착용|아이돌|멤버|직캠|무대|공항|idol|member|wearing|look|reference|참고\s*사진|원본\s*사진)/i;
const PRODUCT_HINT = /(?:제품|상품|product|item\s*photo|goods)/i;

function decodeJsonString(raw: string): string {
  return raw.replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/\\+$/, '');
}

export interface WikiPreviewDiagnosis {
  ldJsonBlocks: number;
  ldJsonProductImage: string | null;
  ogImage: string | null;
  photoSection: boolean;
  figures: number;
  productLabelledImages: string[];
  productJsonImages: string[];
  imgTags: Array<{ src: string | null; alt: string | null }>;
  picked: MediaPreview;
  reason: string;
}

export function diagnoseWikiHtml(html: string, base: string): WikiPreviewDiagnosis {
  const ogImage = safeImageUrl(meta(html, 'og:image'), base) ?? safeImageUrl(meta(html, 'twitter:image'), base);
  const isShareCard = (url: string | null) => !!url && !!ogImage && url.split('?')[0] === ogImage.split('?')[0];
  const photo = (url: string | null): MediaPreview => (url ? { imageUrl: url, kind: 'photo', source: 'sonminsoo' } : null);

  // 1) ld+json Product.image (og:image와 같은 합성 이미지는 제외)
  let ldJsonBlocks = 0;
  let ldJsonProductImage: string | null = null;
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    ldJsonBlocks++;
    try {
      const candidate = safeImageUrl(selectLdPhoto(JSON.parse(script[1] ?? "null")), base);
      if (candidate && !ldJsonProductImage) ldJsonProductImage = candidate;
    } catch { /* other structured data is allowed to be malformed */ }
  }

  // 2) 사진 섹션(예전 구조): 두 번째 <figure>가 제품, 첫 번째는 아이돌 참고 사진. 캡션으로 다시 확인한다.
  const photos = html.match(/<section\b[^>]*aria-label=["']사진["'][^>]*>([\s\S]*?)<\/section>/i)?.[1];
  const figures = photos ? [...photos.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)].map((m) => m[1] ?? "") : [];
  let sectionPick: string | null = null;
  const labelled = figures.find((f) => PRODUCT_HINT.test(f.replace(/<img\b[^>]*>/gi, '')) && !IDOL_HINT.test(f.replace(/<img\b[^>]*>/gi, '')));
  const figure = labelled ?? (figures.length > 1 && !IDOL_HINT.test((figures[1] ?? '').replace(/<img\b[^>]*>/gi, '')) ? figures[1] : undefined);
  if (figure) {
    const img = figure.match(/<img\b[^>]*>/i)?.[0];
    sectionPick = img ? safeImageUrl(attr(img, 'src') ?? attr(img, 'data-src'), base) : null;
  }

  // 3) alt/aria-label이 "제품/상품"이라고 밝힌 <img> (구조가 바뀐 경우)
  const imgTags = (html.match(/<img\b[^>]*>/gi) ?? []).map((tag) => ({ src: attr(tag, 'src') ?? attr(tag, 'data-src'), alt: attr(tag, 'alt') ?? attr(tag, 'aria-label') }));
  const productLabelledImages = imgTags
    .filter((t) => t.alt && PRODUCT_HINT.test(t.alt) && !IDOL_HINT.test(t.alt))
    .map((t) => safeImageUrl(t.src, base))
    .filter((u): u is string => !!u && !isShareCard(u));

  // 4) 클라이언트 렌더링(Next.js 등) 데이터 안의 "제품 이미지" 키만 (productImage, product_image_url …).
  //    image/thumbnail 같은 일반 키는 멤버 사진일 수 있어서 보지 않는다.
  const productJsonImages = [...html.matchAll(/\\?"(product_?(?:image|img|photo)\w*)\\?"\s*:\s*\\?"(https?:[^"\\]*(?:\\.[^"\\]*)*?)\\?"/gi)]
    .map((m) => safeImageUrl(decodeJsonString(m[2] ?? ''), base))
    .filter((u): u is string => !!u && !isShareCard(u));

  const base0 = { ldJsonBlocks, ldJsonProductImage, ogImage, photoSection: !!photos, figures: figures.length, productLabelledImages, productJsonImages, imgTags: imgTags.slice(0, 30) };
  if (ldJsonProductImage && !isShareCard(ldJsonProductImage)) return { ...base0, picked: photo(ldJsonProductImage), reason: 'ld+json Product.image' };
  if (sectionPick && !isShareCard(sectionPick)) return { ...base0, picked: photo(sectionPick), reason: '사진 섹션의 제품 figure' };
  if (productLabelledImages[0]) return { ...base0, picked: photo(productLabelledImages[0]), reason: 'alt가 제품/상품인 img' };
  if (productJsonImages[0]) return { ...base0, picked: photo(productJsonImages[0]), reason: '페이지 데이터의 product image 키' };
  const reason = !html.trim() ? '빈 HTML'
    : !photos && !ldJsonBlocks && imgTags.length === 0 ? '초기 HTML에 사진이 없음(클라이언트 렌더링 추정) — og:image는 멤버 합성이라 쓰지 않음'
    : ldJsonProductImage && isShareCard(ldJsonProductImage) ? 'ld+json 이미지가 og:image(멤버 합성)와 같아서 제외'
    : '제품 사진이라고 확인되는 이미지를 찾지 못함';
  return { ...base0, picked: null, reason };
}

/** 제품 사진만. 확실한 제품 사진이 없으면 null(화면은 아이콘 유지). */
export function extractWikiPreview(html: string, base: string): MediaPreview {
  return diagnoseWikiHtml(html, base).picked;
}

/** reCree banners are real source-linked place imagery, not arbitrary search results. */
export function extractRecreePreview(html: string, base: string): MediaPreview {
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const raw = attr(tag, 'src') ?? attr(tag, 'data-src');
    const candidate = safeImageUrl(raw, base);
    if (candidate && candidate.includes('cdn.recree.io/post-images/')) return { imageUrl: candidate, kind: 'photo', source: 'recree' };
  }
  const og = safeImageUrl(meta(html, 'og:image'), base);
  return og ? { imageUrl: og, kind: 'share_preview', source: 'recree' } : null;
}

export interface FetchReport { url: string; status: number | null; contentType: string | null; bytes: number; error: string | null }

async function fetchTrustedHtml(start: URL, report?: FetchReport): Promise<string | null> {
  let url = start;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!ALLOWED_PAGE_HOSTS.has(url.hostname) || url.protocol !== 'https:') return null;
    try {
      const response = await fetch(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { 'accept': 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; DukmePhotoPreview/1.0)' },
      });
      if (report) Object.assign(report, { url: url.href, status: response.status, contentType: response.headers.get('content-type') });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get('location');
        if (!target) return null;
        url = new URL(target, url);
        continue;
      }
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return null;
      // Only need initial HTML. Max 5 MB, no unbounded remote fetch.
      const limit = 5_000_000;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) return null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > limit) { await reader.cancel(); if (report) report.error = '5MB 초과'; return null; }
        chunks.push(value);
      }
      if (report) report.bytes = bytes;
      return new TextDecoder().decode(Buffer.concat(chunks));
    } catch (error) {
      if (report) report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return null;
    }
  }
  return null;
}

async function resolvePreview(kind: 'item' | 'place', id: string, source: Item | Place): Promise<MediaPreview> {
  if (kind === 'item') {
    const item = source as Item;
    // data/items.json의 imageUrl(손민수위키 제품 사진)이 있으면 페이지를 읽지 않고 바로 쓴다.
    // 손민수위키 상품 페이지는 클라이언트 렌더링이라 서버에서 읽어도 사진이 없다. 절대 https 주소만 허용.
    if (typeof item.imageUrl === 'string' && /^https:\/\//i.test(item.imageUrl.trim())) {
      const direct = safeImageUrl(item.imageUrl, item.imageUrl);
      if (direct) return { imageUrl: direct, kind: 'photo', source: 'sonminsoo' };
    }
    const url = pageUrl(item.wikiUrl, 'sonminsoo.kr');
    if (!url) return null; // X-only rows have no image; never substitute other idols.
    const html = await fetchTrustedHtml(url);
    return html ? extractWikiPreview(html, url.href) : null;
  }
  const place = source as Place;
  const direct = safeImageUrl(place.imageUrl ?? FEATURED_RECREe_PHOTOS[id], 'https://recree.io');
  if (direct) return { imageUrl: direct, kind: 'photo', source: 'recree' };
  const url = pageUrl(place.recreeUrl, 'recree.io');
  if (!url) return null;
  const html = await fetchTrustedHtml(url);
  return html ? extractRecreePreview(html, url.href) : null;
}

export function getMediaPreview(kind: 'item' | 'place', id: string, source: Item | Place): Promise<MediaPreview> {
  const key = `${kind}:${id}`;
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) return existing.pending;
  const pending = resolvePreview(kind, id, source).catch(() => null);
  cache.set(key, { until: Date.now() + CACHE_MS, pending });
  return pending;
}

/** 노트북에서 사진이 왜 안 뜨는지 확인용: /media-preview?type=item&id=...&debug=1 */
export async function diagnoseItemPreview(item: Item): Promise<Record<string, unknown>> {
  const url = pageUrl(item.wikiUrl, 'sonminsoo.kr');
  if (!url) return { wikiUrl: item.wikiUrl, reason: 'wikiUrl이 없거나 https://sonminsoo.kr 주소가 아님' };
  const report: FetchReport = { url: url.href, status: null, contentType: null, bytes: 0, error: null };
  const html = await fetchTrustedHtml(url, report);
  if (!html) {
    const reason = report.error ? `요청 실패 (${report.error})`
      : report.status && report.status >= 400 ? `HTTP ${report.status} — 사이트가 서버 요청을 막았을 수 있음`
      : report.contentType && !report.contentType.includes('text/html') ? `HTML이 아님 (${report.contentType})`
      : '응답 없음';
    return { fetch: report, reason };
  }
  return { fetch: report, ...diagnoseWikiHtml(html, url.href) };
}
