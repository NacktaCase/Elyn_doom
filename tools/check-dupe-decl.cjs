// 같은 블록에서 같은 이름을 두 번 선언했는지 본다.
//
// **JSX 라 Node 가 파싱을 못 하는 구간을 메우는 검사다.**
// DOOM 컴포넌트 v2.5 에서 rAF 페이싱을 끼워 넣다가 이미 있던 `const now` 를
// 한 번 더 선언했고, "Identifier 'now' has already been declared" 로 컴포넌트가
// 통째로 안 떴다. 그때 자체검증의 A절(괄호 균형)·B절(금지어)·C·D절(데이터·부팅)이
// **전부 통과했다** — 아무도 문법을 안 봤기 때문이다.
//
// 완전한 파서가 아니다. **패치로 코드를 끼워 넣다 생기는 중복 선언**만 노린다.
// 문자열·주석·정규식 리터럴을 건너뛰며 중괄호 깊이를 따라가고, 괄호 밖
// (= for 초기화절이나 인자 목록이 아닌) 단순 `const/let 이름` 선언만 센다.
"use strict";

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

function isWordChar(c) { return c !== undefined && ID_PART.test(c); }

/**
 * @param {string} src  검사할 소스 (주석은 미리 벗겨도 되고 아니어도 된다)
 * @returns {{name:string,line:number}[]}  중복된 선언들
 */
function findDuplicateDeclarations(src) {
  const dups = [];
  const stack = [new Set()];
  let paren = 0;
  let line = 1;
  let i = 0;

  // 정규식 리터럴인지 나눗셈인지는 앞선 토큰으로 갈린다. 앞의 의미 있는
  // 문자가 아래 중 하나면 정규식이 올 자리다.
  let prevMeaningful = "";

  while (i < src.length) {
    const c = src[i];

    if (c === "\n") { line++; i++; continue; }

    // 줄 주석
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // 블록 주석
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // 문자열 (', ", `)
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\n") line++;
        if (src[i] === String.fromCharCode(92)) i++;   // 역슬래시 이스케이프
        i++;
      }
      i++;
      prevMeaningful = quote;
      continue;
    }
    // 정규식 리터럴
    if (c === "/" && "(,=:[!&|?{};+-*%~^".indexOf(prevMeaningful) >= 0) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\n") break;                          // 한 줄을 넘으면 정규식이 아니다
        if (d === String.fromCharCode(92)) { i += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { i++; break; }
        i++;
      }
      prevMeaningful = "/";
      continue;
    }

    if (c === "(") { paren++; prevMeaningful = c; i++; continue; }
    if (c === ")") { paren = Math.max(0, paren - 1); prevMeaningful = c; i++; continue; }
    if (c === "{") { stack.push(new Set()); prevMeaningful = c; i++; continue; }
    if (c === "}") { if (stack.length > 1) stack.pop(); prevMeaningful = c; i++; continue; }

    // const / let 선언
    if (ID_START.test(c)) {
      let j = i;
      while (j < src.length && ID_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      const before = src[i - 1];

      if ((word === "const" || word === "let") && !isWordChar(before)) {
        // 이름을 읽는다. 구조분해(`{`/`[`)는 이 검사의 대상이 아니다.
        let k = j;
        while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
        if (k < src.length && ID_START.test(src[k])) {
          let e = k;
          while (e < src.length && ID_PART.test(src[e])) e++;
          const id = src.slice(k, e);
          // 괄호 안이면 for 초기화절이나 인자라 자체 스코프다.
          if (paren === 0) {
            const top = stack[stack.length - 1];
            if (top.has(id)) dups.push({ name: id, line });
            else top.add(id);
          }
          i = e;
          prevMeaningful = "x";
          continue;
        }
      }
      i = j;
      prevMeaningful = "x";
      continue;
    }

    if (c !== " " && c !== "\t" && c !== "\r") prevMeaningful = c;
    i++;
  }

  return dups;
}

module.exports = { findDuplicateDeclarations };

// 직접 실행하면 인수로 준 파일들을 검사한다.
if (require.main === module) {
  const fs = require("fs");
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const d = findDuplicateDeclarations(fs.readFileSync(f, "utf8"));
    for (const x of d) { console.log("  ✗ " + f + ":" + x.line + "  `" + x.name + "` 중복 선언"); bad++; }
    if (!d.length) console.log("  ✓ " + f);
  }
  process.exitCode = bad ? 1 : 0;
}
