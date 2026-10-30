// 한국 지명 영문 표기 (국어의 로마자 표기법 기준, 지명에 자주 나오는 소리 변화만 반영).
// 영어·일본어·중국어 화면에서 "서울 route" 대신 "Seoul route"처럼 보이게 쓴다.
// 서울특별시 → Seoul, 용산구 → Yongsan-gu, 강릉시 → Gangneung-si, 종로구 → Jongno-gu.

const INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWEL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
// 받침: 대표음
const FINAL = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
// 받침 뒤에 ㅇ(소리 없음)이 오면 받침이 다음 음절로 넘어갈 때의 소리
const FINAL_LIAISON = ["", "g", "kk", "ks", "n", "nj", "n", "d", "r", "lg", "lm", "lb", "ls", "lt", "lp", "r", "m", "b", "bs", "s", "ss", "", "j", "ch", "k", "t", "p", ""];

const WHOLE: Record<string, string> = {
  서울: "Seoul", 서울특별시: "Seoul", 한국: "Korea", 전국: "Korea", 대한민국: "Korea",
  // 이름 끝 글자가 행정 접미사처럼 보이는 도시(대구의 '구')는 통째로
  부산: "Busan", 대구: "Daegu", 인천: "Incheon", 광주: "Gwangju", 대전: "Daejeon", 울산: "Ulsan", 세종: "Sejong", 제주: "Jeju",
  홍대: "Hongdae", 성수: "Seongsu", 한남: "Hannam", 강남: "Gangnam",
};
// 행정 단위 접미사: 앞은 붙여 읽고 접미사만 하이픈으로 (용산구 → Yongsan-gu).
const SUFFIX: Array<[RegExp, string]> = [
  [/특별시$|광역시$|특별자치시$/, ""],
  [/특별자치도$/, "-do"],
  [/통합특별시$/, ""],
  [/도$/, "-do"],
  [/시$/, "-si"],
  [/군$/, "-gun"],
  [/구$/, "-gu"],
  [/동$/, "-dong"],
  [/읍$/, "-eup"],
  [/면$/, "-myeon"],
];

function decompose(ch: string): [number, number, number] | null {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return [Math.floor(code / 588), Math.floor((code % 588) / 28), code % 28];
}

/** 한글 음절들을 로마자로 (소리 변화: 연음, 비음화, 유음화). 한글이 아닌 글자는 그대로. */
export function romanizeHangul(word: string): string {
  const chars = [...word];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const cur = decompose(chars[i]!);
    if (!cur) { out += chars[i]; continue; }
    const [ini, vow, fin] = cur;
    const prev = i > 0 ? decompose(chars[i - 1]!) : null;
    const next = i + 1 < chars.length ? decompose(chars[i + 1]!) : null;

    // 초성: 앞 받침과의 소리 변화
    let initial = INITIAL[ini]!;
    if (prev) {
      const pf = prev[2];
      if (ini === 11 && pf !== 0 && pf !== 21) initial = FINAL_LIAISON[pf]!; // 연음 (ㅇ 받침 제외)
      else if (ini === 5) { // ㄹ
        if (pf === 8 || pf === 4) initial = "l"; // ㄹ+ㄹ, ㄴ+ㄹ → ll (신라 → Silla)
        else if (pf !== 0) initial = "n"; // 그 밖의 받침+ㄹ → ㄴ (강릉 → 강능, 종로 → 종노)
      } else if (ini === 2 && pf === 8) initial = "l"; // ㄹ+ㄴ → ll (설날 → Seollal)
    } else if (ini === 5) initial = "r";
    if (ini === 11 && prev && (prev[2] === 0 || prev[2] === 21)) initial = "";

    // 받침: 다음 초성과의 소리 변화
    let final = FINAL[fin]!;
    if (next) {
      const ni = next[0];
      if (ni === 11 && fin !== 21) final = ""; // 연음되어 다음 음절로 넘어감
      else if (ni === 2 || ni === 6) { // 다음이 ㄴ/ㅁ → 비음화
        if (final === "k") final = "ng";
        else if (final === "t") final = "n";
        else if (final === "p") final = "m";
      } else if (ni === 5) { // 다음이 ㄹ
        if (final === "n") final = "l"; // 신라 → 실라
        else if (final === "k") final = "ng";
        else if (final === "p") final = "m";
      }
    }
    out += initial + VOWEL[vow]! + final;
  }
  return out;
}

const capitalize = (s: string) => s.replace(/^([a-z])/, (m) => m.toUpperCase());

/** 지명 한 덩어리를 영문으로: "용산구" → "Yongsan-gu", "서울특별시 용산구" → "Seoul Yongsan-gu". */
export function romanizePlaceName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed || !/[가-힣]/.test(trimmed)) return trimmed;
  return trimmed.split(/\s+/).map((word) => {
    if (WHOLE[word]) return WHOLE[word];
    for (const [re, suffix] of SUFFIX) {
      if (re.test(word) && word.replace(re, "").length >= 1) {
        const stem = word.replace(re, "");
        if (WHOLE[stem]) return WHOLE[stem] + (suffix === "-si" || suffix === "" ? "" : suffix);
        // 한 글자 지명은 접미사까지 붙여 읽는다 (중구 → Jung-gu, 서구 → Seo-gu)
        return capitalize(romanizeHangul(stem)) + suffix;
      }
    }
    return capitalize(romanizeHangul(word));
  }).join(" ");
}
