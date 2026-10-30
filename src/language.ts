// 대화 언어 판별. 서버가 마지막으로 판별된 언어를 기억하고, 짧거나 판단이 안 되는 메시지
// ("yes!!", "ok", 이모지, 숫자, 고유명사만 있는 문장)는 직전 언어를 그대로 쓴다.
// 사용자가 다른 언어로 "문장"을 쓰면 그때 바꾼다. 같은 결과를 답변(replyLanguage)과 화면 문구에 함께 쓴다.

export type ReplyLanguage = "ko" | "en" | "ja" | "zh-CN" | "zh-TW";
export const REPLY_LANGUAGES: readonly ReplyLanguage[] = ["ko", "en", "ja", "zh-CN", "zh-TW"];

// 매 턴 context에 replyLanguage와 함께 넣는 지시문. 코드만 주면 모델이 지침의 예시 언어를 따라가는 일이 있어서
// 그 언어로 직접 쓴 문장을 같이 준다.
export const REPLY_INSTRUCTION: Record<ReplyLanguage, string> = {
  ko: "반드시 한국어로만 답한다.",
  en: "Reply only in English.",
  ja: "必ず日本語だけで返答してください。",
  "zh-CN": "请只用简体中文回答。",
  "zh-TW": "請只用繁體中文回答。",
};

// 간체/번체를 가르는 흔한 글자들 (한쪽에만 있는 자형).
const SIMPLIFIED_ONLY = "这们吗买东么说个来时会过对还没发样问爱欢应该帮边点价钱让给带员团队饭馆车门图线场预颜寻荐览红绿蓝袜视频网试报纸书语译号码热闹卖岁庆贵乐关开见长后从现为";
const TRADITIONAL_ONLY = "這們嗎買東麼說個來時會過對還沒發樣問愛歡應該幫邊點價錢讓給帶員團隊飯館車門圖線場預顏尋薦覽紅綠藍襪視頻網試報紙書語譯號碼熱鬧賣歲慶貴樂關開見長後從現為裡";

// 혼자서는 언어를 정하지 못하는 짧은 대답 (직전 언어 유지).
const SHORT_REPLIES = new Set([
  "yes", "yeah", "yep", "yup", "ya", "ok", "okay", "okey", "sure", "no", "nope", "thanks", "thank", "thx", "ty",
  "cool", "nice", "great", "good", "wow", "lol", "omg", "hi", "hey", "hello", "please", "pls", "plz", "yay", "haha",
]);

export interface DetectOptions {
  previous?: ReplyLanguage | null;
  /** 언어 판단에서 빼는 고유명사(멤버·그룹·지역 이름 등). 소문자로 비교한다. */
  properNouns?: string[];
}

/** 이 메시지만 보고 확실히 말할 수 있는 언어. 판단이 안 되면 null. */
export function detectSentenceLanguage(text: string, options: DetectOptions = {}): ReplyLanguage | null {
  let rest = ` ${(text ?? "").toLowerCase()} `;
  // 고유명사는 언어 신호가 아니다: "I love 사쿠야" 는 영어, "BOYNEXTDOOR!!" 는 판단 불가.
  const nouns = [...new Set((options.properNouns ?? []).map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  for (const noun of nouns) {
    if (!rest.includes(noun)) continue;
    // 영문 이름은 단어 단위로만 뺀다("han"이 "thank"를, "ive"가 "give"를 지우지 않게). 한글 이름은 조사가 붙으니 그대로.
    if (/^[a-z0-9 .'-]+$/.test(noun)) rest = rest.replace(new RegExp(`(^|[^a-z])${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z])`, "g"), "$1 ");
    else rest = rest.split(noun).join(" ");
  }
  // 원문에서 전부 대문자인 단어(NCT, WISH, BTS 등)도 고유명사로 본다.
  const capsWords = new Set((text.match(/\b[A-Z][A-Z0-9]{1,}\b/g) ?? []).map((w) => w.toLowerCase()));

  if (/[぀-ヿ]/.test(rest)) return "ja"; // 히라가나·가타카나
  const hangul = (rest.match(/[가-힣]/g) ?? []).length;
  const han = (rest.match(/[一-鿿]/g) ?? []).length;
  const words = (rest.match(/[a-z]+(?:'[a-z]+)?/g) ?? []).filter((w) => w.length >= 2 && !capsWords.has(w));
  const meaningfulWords = words.filter((w) => !SHORT_REPLIES.has(w));
  // 첫 메시지(직전 언어 없음)면 "hello" 한 단어도 영어로 본다.
  const englishSentence = meaningfulWords.length >= 2 || (meaningfulWords.length >= 1 && words.length >= 2)
    || (!options.previous && words.length >= 1);

  const scores: Array<[ReplyLanguage | "zh", number]> = [];
  if (hangul >= 2) scores.push(["ko", hangul]);
  if (han >= 2) scores.push(["zh", han]);
  if (englishSentence) scores.push(["en", words.length * 2]); // 영어 한 단어 ≈ 한글 두 글자
  if (!scores.length) return null;
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores[0]![0];
  if (top !== "zh") return top;
  let simplified = 0, traditional = 0;
  for (const ch of rest) {
    if (SIMPLIFIED_ONLY.includes(ch)) simplified++;
    if (TRADITIONAL_ONLY.includes(ch)) traditional++;
  }
  if (simplified > traditional) return "zh-CN";
  if (traditional > simplified) return "zh-TW";
  return options.previous === "zh-TW" ? "zh-TW" : "zh-CN";
}

// "영어로 답해줘", "please reply in Korean", "日本語で", "用简体中文"처럼 언어를 직접 요청한 경우.
const REQUESTS: Array<[RegExp, ReplyLanguage]> = [
  [/(간체|简体|簡體|simplified\s*chinese)/i, "zh-CN"],
  [/(번체|繁體|繁体|traditional\s*chinese)/i, "zh-TW"],
  [/(영어로|english|英語で|英语|英語回答|用英文)/i, "en"],
  [/(일본어로|in\s*japanese|日本語で|日语|日語)/i, "ja"],
  [/(한국어로|in\s*korean|韓国語で|韩语|韓語)/i, "ko"],
  [/(중국어로|in\s*chinese|中文)/i, "zh-CN"],
];
const ASKS_TO_REPLY = /(답|말|대답|얘기|reply|answer|speak|talk|respond|switch|で(話|答|返)|回答|回覆|回复|说|說)/i;
export function requestedLanguage(text: string): ReplyLanguage | null {
  if (!ASKS_TO_REPLY.test(text)) return null;
  for (const [re, lang] of REQUESTS) if (re.test(text)) return lang;
  return null;
}

/** 이번 턴에 답할 언어: 직접 요청한 언어 > 이 메시지가 문장이면 그 언어 > 직전 언어 > 한국어. */
export function resolveReplyLanguage(text: string, options: DetectOptions = {}): ReplyLanguage {
  return requestedLanguage(text) ?? detectSentenceLanguage(text, options) ?? options.previous ?? "en";
}
