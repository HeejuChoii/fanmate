// 덕메 답변 텍스트에서 표정 마커를 느슨하게 찾아 표정으로 쓰고, 글자는 화면에서 지운다.
// 모델이 ":happy:" 대신 ": happy:", ":happy :", "：happy："(전각), ":Happy:"처럼 보내도 잡는다.
// 스트리밍 중에는 조각 경계에서 잘린 마커(": hap")가 잠깐이라도 보이지 않게 끝부분을 숨긴다 —
// 매번 지금까지 받은 전체 원문을 다시 정리하므로 다음 조각이 오면 제자리에 나타난다.
// 브라우저(window.DukmeMarkers)와 테스트(scripts/markers.test.ts) 양쪽에서 이 파일 하나를 쓴다.
(function (root) {
  var KNOWN = ['happy', 'think', 'cheer', 'sorry'];
  var PRIORITY = ['cheer', 'happy', 'sorry', 'think'];
  var COLON = '[:\\uFF1A]';
  var SPACE = '[ \\t\\u3000]';
  var KNOWN_RE = new RegExp(COLON + '\\s*(happy|think|cheer|sorry)\\s*' + COLON, 'gi');
  // 답변 맨 앞의 알 수 없는 :word: (예: ":wave: Hi") 는 화면에 보이지 않게.
  var LEADING_UNKNOWN_RE = new RegExp('^(?:\\s*' + COLON + '\\s*[a-z][a-z_-]{0,19}\\s*' + COLON + ')+', 'i');
  // 스트리밍 중: 끝에 열린 채 잘린 마커 후보(":", ": hap", ":happy ").
  var TRAILING_PARTIAL_RE = new RegExp(COLON + '\\s*[a-z_-]{0,20}\\s*$', 'i');
  // 지운 자리 표시(HOLE)와 그 주변 공백 한 덩어리.
  var HOLE = '\u0000';
  var HOLE_RUN_RE = new RegExp(SPACE + '*\\u0000(?:' + SPACE + '*\\u0000)*' + SPACE + '*', 'g');
  var PUNCT_RE = /[,.!?;:。、！？，]/;

  /**
   * @param {string} text 지금까지 받은 답변 원문
   * @param {{ streaming?: boolean }} [options]
   * @returns {{ text: string, markers: string[] }} 마커를 뺀 글자, 찾은 마커(소문자, 순서대로)
   */
  function extractMarkers(text, options) {
    var streaming = Boolean(options && options.streaming);
    var markers = [];
    // 지운 자리는 잠깐 HOLE로 표시해 두고, 그 자리 주변 공백만 정리한다(마커와 상관없는 글은 건드리지 않게).
    var out = String(text == null ? '' : text).replace(KNOWN_RE, function (_m, name) {
      markers.push(name.toLowerCase());
      return HOLE;
    });
    out = out.replace(LEADING_UNKNOWN_RE, HOLE);
    if (streaming) out = out.replace(TRAILING_PARTIAL_RE, HOLE);
    out = out.replace(HOLE_RUN_RE, function (match, offset, whole) {
      var before = whole.charAt(offset - 1);
      var after = whole.charAt(offset + match.length);
      // 줄 처음·끝, 문장부호 앞이면 공백 없이 / 단어 사이면 공백 하나.
      if (!before || before === '\n' || !after || after === '\n' || PUNCT_RE.test(after)) return '';
      return ' ';
    });
    return { text: out, markers: markers };
  }

  /** 마커 목록 → 표정 하나 (cheer > happy > sorry > think > idle). */
  function resolveExpression(markers) {
    var list = (markers || []).map(function (m) { return String(m).toLowerCase(); });
    for (var i = 0; i < PRIORITY.length; i++) if (list.indexOf(PRIORITY[i]) >= 0) return PRIORITY[i];
    return 'idle';
  }

  root.DukmeMarkers = { KNOWN: KNOWN, extractMarkers: extractMarkers, resolveExpression: resolveExpression };
})(typeof window !== 'undefined' ? window : globalThis);
