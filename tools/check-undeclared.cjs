// 파일 어디에도 선언되지 않은 이름을 참조하는지 본다.
//
// **왜 필요한가:** DOOM 컴포넌트를 패치로 고치다 다른 파일(정찰본)의 코드를
// 옮겨오면서 `setKeys` 와 `P` 를 참조했다. 둘 다 DoomGame 에는 없는 이름이라
// 그 키를 누르는 순간 ReferenceError 가 났을 것이다. JSX 라 Node 가 파싱을
// 못 해 자체검증이 전부 통과했다 — check-dupe-decl.cjs 와 같은 부류의 구멍이다.
//
// 완전한 스코프 분석이 아니다. 한 파일 = 한 컴포넌트 함수라는 이 프로젝트의
// 구조를 전제하고, **파일 전체에서 한 번도 선언되지 않은 이름**만 잡는다.
// "다른 블록의 것을 잘못 참조"는 못 잡지만, 실제로 났던 "아예 없는 이름" 은 잡는다.
"use strict";

const KEYWORDS = new Set(["if", "else", "for", "while", "do", "return", "break",
  "continue", "switch", "case", "default", "new", "typeof", "instanceof", "in",
  "of", "delete", "void", "this", "function", "const", "let", "var", "class",
  "extends", "super", "try", "catch", "finally", "throw", "yield", "await",
  "async", "static", "get", "set", "import", "export", "from", "as"]);

// 어디에나 있는 것들. 여기 없는 전역을 새로 쓰면 한 번은 걸리는데, 그때
// **정말 그 전역을 써도 되는지** 확인하는 계기가 된다 — Elyn 은 window·
// document 조차 없는 환경이라 그 확인이 값싸지 않다.
const GLOBALS = new Set([
  "Array", "Object", "String", "Number", "Boolean", "Math", "JSON", "Date",
  "Error", "TypeError", "RangeError", "Promise", "Symbol", "Map", "Set",
  "WeakMap", "WeakSet", "Infinity", "NaN", "undefined", "console",
  "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array",
  "BigInt", "BigInt64Array", "ArrayBuffer", "DataView", "RegExp", "Function",
  "parseInt", "parseFloat", "isNaN", "isFinite", "globalThis",
  "WebAssembly", "TextDecoder", "TextEncoder", "atob", "btoa",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "performance",
  "ReadableStream", "WritableStream", "Response", "Request",
  "DecompressionStream", "CompressionStream", "AudioContext",
  "webkitAudioContext", "ImageData", "URL", "crypto", "window", "document",
  "Worker", "SharedArrayBuffer", "fetch",
  // Elyn 이 컴포넌트에 넣어주는 것
  "useState", "useEffect", "useMemo", "useCallback", "useRef",
  "sendMessage", "showNotification", "randomInt", "rollDice", "getCurrentTime",
  // Node (도구 파일용)
  "require", "module", "exports", "process", "Buffer", "__dirname", "__filename",
]);

const BACKSLASH = String.fromCharCode(92);

// 문자열·주석·정규식을 공백으로 지운다. 줄 수는 보존한다.
function blankOutLiterals(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < src.length && src[j] !== "\n") j++;
      blank(i, j); i = j; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, j + 2); i = j + 2; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === BACKSLASH) j++;
        j++;
      }
      blank(i, j + 1); i = j + 1; prev = q; continue;
    }
    // 정규식 리터럴인지 나눗셈인지는 앞 토큰으로 갈린다.
    if (c === "/" && "(,=:[!&|?{};+-*%~^".indexOf(prev) >= 0) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j];
        if (d === BACKSLASH) { j += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j++;
      }
      blank(i, j + 1); i = j + 1; prev = "/"; continue;
    }
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n") prev = c;
    i++;
  }
  return out.join("");
}

const isIdStart = (c) => c !== undefined && /[A-Za-z_$]/.test(c);
const isIdPart = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

// `const a = 1, b = 2;` 처럼 여러 개를 한 번에 선언하는 형태를 제대로 읽는다.
// (이걸 안 하면 두 번째부터가 "선언 안 된 이름" 으로 오인된다.)
function collectDeclarators(code, from, into) {
  let i = from;
  let depth = 0;
  let expectName = true;
  while (i < code.length) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--; i++; continue;
    }
    if (c === ";") break;
    if (c === "," && depth === 0) { expectName = true; i++; continue; }
    if (c === "=" && depth === 0) { expectName = false; i++; continue; }
    if (isIdStart(c)) {
      let j = i;
      while (j < code.length && isIdPart(code[j])) j++;
      const id = code.slice(i, j);
      // 구조분해 안(depth>0)의 이름도 선언이다.
      if ((expectName && depth === 0) || depth > 0) into.add(id);
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

// JSX 는 여기서 검사하지 않는다. 태그·속성·본문 텍스트가 전부 식별자처럼
// 보여 오탐이 쏟아지고, 그걸 걸러내려면 사실상 JSX 파서를 써야 한다.
// **실제로 났던 실수는 전부 JSX 이전 구간(로직)에서 났으므로** 거기까지만
// 본다 — 컴포넌트의 `return (` 앞까지다.
function cutBeforeJsx(code) {
  const at = code.indexOf("\n  return (");
  return at >= 0 ? code.slice(0, at) : code;
}

function findUndeclared(src) {
  const code = cutBeforeJsx(blankOutLiterals(src));
  const declared = new Set();

  // const / let / var — 여러 개 선언을 전부 훑는다.
  const declRe = /\b(?:const|let|var)\s+/g;
  let m;
  while ((m = declRe.exec(code))) collectDeclarators(code, m.index + m[0].length, declared);

  // function 이름, catch 인자, 화살표·일반 함수 인자, 객체 메서드 축약
  const others = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /\(([^()]*)\)\s*=>/g,
    /\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g,
    /\b([A-Za-z_$][\w$]*)\s*=>/g,
    /([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g,
  ];
  for (const re of others) {
    let x;
    while ((x = re.exec(code))) {
      for (let g = 1; g < x.length; g++) {
        const raw = x[g];
        if (!raw) continue;
        for (const id of raw.match(/[A-Za-z_$][\w$]*/g) || []) declared.add(id);
      }
    }
  }

  const undeclared = [];
  const seen = new Set();
  const useRe = /([.]?)\s*\b([A-Za-z_$][\w$]*)\b\s*(:?)/g;
  let u;
  while ((u = useRe.exec(code))) {
    if (u[1] === "." || u[3] === ":") continue;   // 프로퍼티 / 객체 키
    const id = u[2];
    if (KEYWORDS.has(id) || GLOBALS.has(id) || declared.has(id)) continue;
    if (id === "true" || id === "false" || id === "null") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    undeclared.push({ name: id, line: code.slice(0, u.index).split("\n").length });
  }
  return undeclared;
}

module.exports = { findUndeclared, blankOutLiterals, GLOBALS };

if (require.main === module) {
  const fs = require("fs");
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const d = findUndeclared(fs.readFileSync(f, "utf8"));
    for (const x of d) { console.log("  ? " + f + ":" + x.line + "  " + x.name); bad++; }
    if (!d.length) console.log("  ok " + f);
  }
  process.exitCode = bad ? 1 : 0;
}
