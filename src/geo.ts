// Area/region matching for places. "대구" (Daegu) is a literal substring of "해운대구"
// (Haeundae-gu, a district of Busan) — plain substring matching on area names picks up
// the wrong city. So we compare whole administrative tokens (province, district), with
// known suffixes stripped, instead of raw substring containment.
import type { Place } from "./data.js";
import { norm } from "./aliasMatch.js";
import { romanizePlaceName } from "./romanize.js";

const ADMIN_SUFFIX = /(특별자치시|특별자치도|특별시|광역시|자치시|자치군|도|시|군|구)$/;

function stripAdminSuffix(token: string): string {
  return token.replace(ADMIN_SUFFIX, "");
}

// 행정 명칭이 아닌 동네 별명. 접미사만 떼어서는 알 수 없는 것들만 넣는다
// (서울/경기/부산 같은 시·도 단위는 접미사 제거만으로 이미 매치된다).
const AREA_ALIASES: Record<string, string> = {
  홍대: "마포구",
  성수: "성동구",
  한남: "용산구",
  강남: "강남구",
  이태원: "용산구",
  명동: "중구",
  압구정: "강남구",
  신촌: "서대문구",
  잠실: "송파구",
  여의도: "영등포구",
  인사동: "종로구",
  익선동: "종로구",
  북촌: "종로구",
  해운대: "해운대구",
  서면: "부산진구",
};

// 일본어·중국어로 쓴 주요 지명 → 한국어. 접미사(区/區/市/郡/洞)는 떼고 찾은 뒤 한국어 접미사로 다시 붙인다.
const CJK_AREAS: Record<string, string> = {
  ソウル: "서울", 首尔: "서울", 首爾: "서울", 漢城: "서울", 汉城: "서울",
  プサン: "부산", 釜山: "부산",
  インチョン: "인천", 仁川: "인천",
  テグ: "대구", 大邱: "대구",
  テジョン: "대전", 大田: "대전",
  クァンジュ: "광주", 光州: "광주",
  ウルサン: "울산", 蔚山: "울산",
  チェジュ: "제주", 済州: "제주", 济州: "제주", 濟州: "제주",
  ヨンサン: "용산", 龍山: "용산", 龙山: "용산",
  カンナム: "강남", 江南: "강남",
  ホンデ: "홍대", 弘大: "홍대",
  ソンス: "성수", 聖水: "성수", 圣水: "성수",
  ミョンドン: "명동", 明洞: "명동",
  イテウォン: "이태원", 梨泰院: "이태원",
  チョンノ: "종로", 鍾路: "종로", 钟路: "종로", 鐘路: "종로",
  マポ: "마포", 麻浦: "마포",
  ソンパ: "송파", 松坡: "송파",
  ヨイド: "여의도", 汝矣島: "여의도", 汝矣岛: "여의도",
  ヘウンデ: "해운대", 海雲台: "해운대", 海云台: "해운대",
  チョンジュ: "전주", 全州: "전주",
  モッポ: "목포", 木浦: "목포",
  カンヌン: "강릉", 江陵: "강릉",
  キョンジュ: "경주", 慶州: "경주", 庆州: "경주",
  スウォン: "수원", 水原: "수원",
  チュンチョン: "춘천", 春川: "춘천",
  ヤンピョン: "양평", 楊平: "양평", 杨平: "양평",
  カピョン: "가평", 加平: "가평",
  ソギポ: "서귀포", 西帰浦: "서귀포", 西归浦: "서귀포", 西歸浦: "서귀포",
};
const CJK_SUFFIX: Array<[RegExp, string]> = [[/[区區]$/, "구"], [/市$/, "시"], [/郡$/, "군"], [/洞$/, "동"]];
const WHOLE_COUNTRY = new Set(["한국", "전국", "대한민국", "korea", "southkorea", "allofkorea", "nationwide", "韓国", "韩国", "韓國", "全国", "全國"]);

/** 영문 비교용: 소문자, 공백·하이픈·점 제거. ("Yongsan-gu" → "yongsangu") */
const latinKey = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[\s\-_.'’]/g, "");
/** 영문 행정 접미사 뗀 형태도 같이 ("yongsangu" → "yongsan", "seoulcity" → "seoul"). */
function latinVariants(key: string): string[] {
  const out = [key];
  const stripped = key.replace(/(?:specialcity|metropolitancity|city|district|province|island|gun|gu|si|dong|do|eup|myeon)$/, "");
  if (stripped && stripped !== key) out.push(stripped);
  return out;
}
const romanCache = new Map<string, string[]>();
function romanKeys(korean: string): string[] {
  let keys = romanCache.get(korean);
  if (!keys) {
    keys = korean ? latinVariants(latinKey(romanizePlaceName(korean))) : [];
    romanCache.set(korean, keys);
  }
  return keys;
}
const LATIN_ALIASES: Array<[string[], string]> = Object.entries(AREA_ALIASES).map(([alias, target]) => [romanKeys(alias), target]);

/**
 * 사용자가 쓴 지역명 → 데이터와 비교할 형태들.
 * korean: 한국어 후보(한국어로 썼거나, 일본어·중국어 표에서 찾은 것) / latin: 영문 비교 키.
 */
export function areaQuery(raw: string | undefined | null): { all: boolean; korean: string[]; latin: string[] } {
  const text = (raw ?? "").trim();
  if (!text || WHOLE_COUNTRY.has(text) || WHOLE_COUNTRY.has(latinKey(text))) return { all: true, korean: [], latin: [] };
  const korean = new Set<string>();
  if (/[가-힣]/.test(text)) {
    korean.add(text);
    const alias = AREA_ALIASES[text];
    if (alias) korean.add(alias);
  }
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) {
    const cjk = text.replace(/\s+/g, "");
    let found = CJK_AREAS[cjk];
    let suffix = "";
    if (!found) {
      for (const [re, ko] of CJK_SUFFIX) {
        if (re.test(cjk) && CJK_AREAS[cjk.replace(re, "")]) {
          found = CJK_AREAS[cjk.replace(re, "")];
          suffix = ko;
          break;
        }
      }
    }
    if (found) {
      korean.add(found);
      if (suffix) korean.add(found + suffix);
      const alias = AREA_ALIASES[found];
      if (alias) korean.add(alias);
    }
  }
  const latin = /[a-z]/i.test(text) ? latinVariants(latinKey(text)) : [];
  for (const [keys, target] of LATIN_ALIASES) if (latin.some((k) => keys.includes(k))) korean.add(target);
  return { all: false, korean: [...korean], latin };
}

function regionTokens(place: Place): { province: string; district: string } {
  const parts = (place.region || "").trim().split(/\s+/);
  return { province: parts[0] || "", district: parts[1] || place.area || "" };
}

// 시·도(region 첫 토큰)와 구·군·시(area) 둘 다 비교한다: "서울", "Seoul", "首尔" → 서울특별시의 모든 장소,
// "용산구", "Yongsan-gu", "龍山区" → 용산구 장소.
export function placeMatchesArea(place: Place, rawQuery: string | undefined | null): boolean {
  const query = areaQuery(rawQuery);
  if (query.all) return true;

  const { province, district } = regionTokens(place);
  const tokens = [province, stripAdminSuffix(province), district, stripAdminSuffix(district), place.area].filter(Boolean);
  const candidates = new Set(tokens.map(norm));
  if (query.korean.some((k) => candidates.has(norm(k)))) return true;
  if (query.latin.length) {
    const latinCandidates = new Set(tokens.flatMap(romanKeys));
    if (query.latin.some((k) => latinCandidates.has(k))) return true;
  }
  return false;
}

// 전국 결과를 묶어서 보여줄 때 쓰는 지역 단위: 광역시/도는 짧은 이름("서울","부산"),
// 그 밖의 시·군(목포시, 강릉시 등)은 그 자체(접미사만 뗀) 이름을 쓴다.
export function regionBucket(place: Place): string {
  const { province, district } = regionTokens(place);
  if (/구$/.test(place.area)) {
    const short = stripAdminSuffix(province);
    return short || province || place.area;
  }
  const short = stripAdminSuffix(district || place.area);
  return short || district || place.area;
}

/** 코스 제목용 지역 이름: 특별시·광역시의 구는 "서울 용산구", 그 밖은 시·군 이름("포천시"). */
export function areaLabel(place: Place): string {
  const { province } = regionTokens(place);
  return /구$/.test(place.area) && province ? `${stripAdminSuffix(province)} ${place.area}` : place.area;
}

/**
 * 사용자가 쓴 지역명(영어·일본어·중국어일 수 있음) 대신 화면에 쓸 한국어 지역명: 맞은 장소들이 한 구·군이면
 * "서울 용산구", 한 시·도면 "서울", 섞여 있으면 사용자가 쓴 그대로.
 */
export function displayArea(matched: Place[], raw: string): string {
  if (/[가-힣]/.test(raw) || !matched.length) return raw;
  const regions = new Set(matched.map((p) => p.region));
  if (regions.size === 1) return areaLabel(matched[0]!);
  const provinces = new Set(matched.map((p) => regionTokens(p).province));
  if (provinces.size === 1) return stripAdminSuffix([...provinces][0]!) || raw;
  return raw;
}
