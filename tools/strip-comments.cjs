// 업로드본에서 주석과 빈 줄을 걷어낸다.
//
//   const { strip, tidy, stripFile } = require("./strip-comments.cjs");
//
// 왜 필요한가 — **제약은 파일당이 아니라 리비전 전체 페이로드다.** 샌드박스
// 컴포넌트는 캐릭터 리비전에 통째로 실려 제출되고, OBJ 텍스트 시절 3.15 MiB 에서
// `POST .../revisions/.../submit` 이 실패했다(README "왜 바이너리인가" 절).
//
// **상한선이 있는 게 아니라 타임아웃이다** — 실패는 413 이 아니라 Cloudflare 524
// 이고 간헐적이다. 작을수록 확률이 좋을 뿐 어떤 크기도 보장하지 않는다.
// 주석과 빈 줄이 133 KB(9%)라 그 확률을 벌어둘 값어치가 있다.
//
// **저장소 주석은 그대로 둔다.** 결정 근거가 거기 남아 있고(실기 버그는 전부
// 코어 바깥에서 났다), `// <<WASM-DATA>>` 같은 마커를 빌드 도구가 읽는다.
// 그래서 이 모듈은 배포본을 내보낼 때만 쓴다.
//
// 안전장치는 §불변식 두 개다 — 지운 게 전부 주석이었는지, 그 외 바이트를 한 톨도
// 안 건드렸는지. 위반이면 throw 한다. 조용히 깨진 파일을 올리는 것보다 export 가
// 실패하는 게 낫다.

// `/` 뒤가 정규식일 수 있는 키워드들. 식별자·숫자 뒤면 나눗셈이다.
const KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void",
  "do", "else", "yield", "await", "instanceof", "throw",
]);

const IDENT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const SPACE = " \t\r\n";
// 이 문자들 뒤의 `/` 는 피연산자가 올 자리이므로 정규식이다.
const REGEX_OK_AFTER = "(,=:[!&|?{};+-*%~^<>\n";

// 직전 유의미 토큰으로 `/` 가 정규식인지 나눗셈인지 가른다.
// 이걸 틀리면 `a / b // c` 같은 줄에서 주석이 아닌 곳을 지우게 된다.
function canBeRegex(out) {
  let j = out.length - 1;
  while (j >= 0 && SPACE.indexOf(out[j]) >= 0) j--;
  const end = j;
  while (j >= 0 && IDENT.indexOf(out[j]) >= 0) j--;
  const word = out.slice(j + 1, end + 1);
  if (word) return KEYWORDS.has(word);          // 식별자/숫자 뒤 = 나눗셈
  const prev = end >= 0 ? out[end] : "";
  return prev === "" || REGEX_OK_AFTER.indexOf(prev) >= 0;
}

// 원본을 훑어 주석 구간만 잘라낸다. 문자열·템플릿·정규식 안은 안 건드린다.
// 반환: { out: 제거본, cuts: [[시작, 끝), …] }
function scan(src) {
  let out = "";
  const cuts = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      const start = i;
      while (i < n && src[i] !== "\n") i++;   // 줄바꿈은 남긴다 (tidy 가 정리)
      cuts.push([start, i]);
      continue;
    }
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = i + 2 > n ? n : i + 2;
      cuts.push([start, i]);
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        out += src[i];
        const done = src[i] === quote;
        i++;
        if (done) break;
      }
      continue;
    }

    if (c === "`") {
      // 템플릿은 ${} 안까지 통째로 보존한다. 거기 주석이 있어도 놔둔다 —
      // 덜 지우는 쪽이 잘못 지우는 쪽보다 안전하다.
      out += c;
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") { depth++; out += "${"; i += 2; continue; }
        if (src[i] === "}" && depth > 0) { depth--; out += "}"; i++; continue; }
        if (src[i] === "`" && depth === 0) { out += "`"; i++; break; }
        out += src[i];
        i++;
      }
      continue;
    }

    if (c === "/" && canBeRegex(out)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { out += "/"; i++; break; }
        else if (src[i] === "\n") break;      // 정규식이 아니었다 — 그대로 흘려보낸다
        out += src[i];
        i++;
      }
      while (i < n && LOWER.indexOf(src[i]) >= 0) { out += src[i]; i++; }   // 플래그
      continue;
    }

    out += c;
    i++;
  }
  return { out, cuts };
}

function strip(src) {
  return scan(src).out;
}

// 후행 공백과 빈 줄을 없앤다.
//
// **주석 제거와 짝이다.** 이 저장소는 주석이 대부분 독립된 줄이라, 주석만 걷으면
// 그 자리에 빈 줄이 1476줄 들어앉는다 (원래 있던 빈 줄은 568줄뿐). 안 하면
// 지운 만큼을 빈 줄로 도로 물어주는 셈이다.
function tidy(text) {
  const lines = text.split("\n");
  const kept = [];
  for (const line of lines) {
    let e = line.length;
    while (e > 0 && (line[e - 1] === " " || line[e - 1] === "\t" || line[e - 1] === "\r")) e--;
    const trimmed = line.slice(0, e);
    if (trimmed !== "") kept.push(trimmed);
  }
  return kept.join("\n") + "\n";
}

// 주석 제거 + 빈 줄 정리 + 불변식 검사.
// 위반이면 throw — 조용히 깨진 파일을 내보내지 않는다.
function stripFile(src, label) {
  const { out, cuts } = scan(src);
  const where = label ? label + ": " : "";

  // 불변식 1 — 지운 구간이 전부 주석 여는 기호로 시작한다.
  for (const cut of cuts) {
    const s = cut[0];
    if (!(src[s] === "/" && (src[s + 1] === "/" || src[s + 1] === "*"))) {
      throw new Error(where + "주석이 아닌 구간을 지웠습니다 (offset " + s + "): "
        + JSON.stringify(src.slice(s, s + 60)));
    }
  }

  // 불변식 2 — 제거본 + 지운 길이 = 원본. 그 외 바이트를 안 건드렸다는 증거다.
  let cutChars = 0;
  for (const cut of cuts) cutChars += cut[1] - cut[0];
  if (out.length + cutChars !== src.length) {
    throw new Error(where + "길이가 안 맞습니다 — 주석 외의 문자를 건드렸습니다 ("
      + (out.length + cutChars) + " != " + src.length + ")");
  }

  return { text: tidy(out), cuts: cuts.length, cutChars };
}

module.exports = { scan, strip, tidy, stripFile };
