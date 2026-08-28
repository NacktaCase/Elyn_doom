// DoomGame.jsx + DoomWad*.jsx 자체검증.
//
//   node tools/doom-selftest.cjs
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────
// Elyn 에는 콘솔이 없다. 컴포넌트가 안 뜨면 흰 화면 하나가 전부고, 원인을
// 알 방법이 없다. 그리고 업로드 한 번이 수동 붙여넣기 + 524 재시도 + 스캐너
// 통과라 비싸다. 그러니 올리기 전에 여기서 다 잡아야 한다.
//
// ── 핵심은 D절이다 ───────────────────────────────────────────────────
// **주입된 base64 를 실제로 꺼내 부팅시킨다.** 정찰본 시료에서 이중
// 이스케이프로 한 번 당했다 — 압축 해제는 멀쩡한데 데이터만 어긋나서
// 하마터면 샌드박스를 의심할 뻔했다. 같은 종류의 사고를 여기서 막는다.
//
// ── 한계 ─────────────────────────────────────────────────────────────
// `.jsx` 는 Node 가 파싱을 못 한다.
// <<RENDER>> 아래의 React 배선과 JSX 는 정적 검사만 한다.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { strip } = require("./strip-comments.cjs");
const { createWasiShim } = require("../doom/src/wasi-shim.js");
// 오디오도 **같은 파일**을 쓴다. Node 에는 AudioContext 가 없으므로
// 여기서 도는 건 자동으로 "오디오 없음" 폴백 경로다 — 그게 공짜로 검증된다.
const { createDoomAudio } = require("../doom/src/audio.js");

const ROOT = path.join(__dirname, "..");
// --dist 로 업로드본(dist-doom/)을 검사한다. 주석 제거는 **변환**이므로
// 검증 밖에 두면 안 된다.
// (예전에는 dist 가 저장소본과 줄바꿈 빼고 바이트 동일해서 그 등식이
//  성립했지만, 주석을 벗기면서 깨졌다.)
const DIST = process.argv.includes("--dist");

// ── 이름 붙은 변종 ───────────────────────────────────────────────────
// build-doom-jsx.cjs --name Freedoom 로 뽑은 한 벌을 검사하려면 여기도
// 같은 이름을 줘야 한다. 기본은 Doom 이다.
//   node tools/doom-selftest.cjs --name Freedoom --wad doom/build/freedoom-e1.wad
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const NAME = argOf("--name", "Doom");
const GAME_FILE = NAME + "Game.jsx";
const WAD_RE = new RegExp("^" + NAME + "Wad[0-9]+[.]jsx$");
const SRC_DIR = path.join(ROOT, DIST ? "dist-" + NAME.toLowerCase() : "doom");
const GAME = path.join(SRC_DIR, GAME_FILE);
const WASM_SRC = path.join(ROOT, "doom", "build", "doom-Oz.wasm");
const WAD_SRC = path.resolve(ROOT, argOf("--wad", path.join("doom", "build", "doom.wad")));

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);
const info = (m) => console.log("    " + m);

const gameSrc = fs.readFileSync(GAME, "utf8");
const wadFiles = fs.readdirSync(SRC_DIR)
  .filter((f) => WAD_RE.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

// ═══ A. 구조 ═════════════════════════════════════════════════════════
console.log("\nA. 구조");
{
  const all = [[GAME_FILE, gameSrc]].concat(
    wadFiles.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), "utf8")]));

  for (const [name, src] of all) {
    const fn = name.replace(".jsx", "");
    if (!new RegExp("^function " + fn + "\\(props\\) \\{", "m").test(src)) {
      fail(name + ": `function " + fn + "(props) {` 가 최상위에 없다");
      continue;
    }
    // Elyn: "바깥에 있는 코드는 저장할 때 사라져요"(sandbox.txt).
    // 조용히 사라지는 게 제일 무서운 실패다.
    const lines = src.split("\n");
    const first = lines.findIndex((l) => l.indexOf("function " + fn) === 0);
    const outside = lines.slice(0, first).filter((l) => l.trim() !== "").length;
    if (outside) { fail(name + ": 함수 바깥에 " + outside + "줄"); continue; }

    let depth = 0, bad = false;
    for (const ch of strip(src)) {
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth < 0) bad = true; }
    }
    if (bad || depth !== 0) { fail(name + ": 중괄호 불균형 depth=" + depth); continue; }
    ok(name + " — 최상위 형태 · 바깥 코드 없음 · 괄호 균형");
  }

  // DoomGame 이 운반체를 실제로 렌더하는지. 안 그리면 WAD 가 영영 안 온다.
  for (const f of wadFiles) {
    const tag = "<" + f.replace(".jsx", "");
    if (gameSrc.indexOf(tag) >= 0) ok("DoomGame 이 " + f.replace(".jsx", "") + " 를 렌더한다");
    else fail(NAME + "Game 이 " + f.replace(".jsx", "") + " 를 안 그린다 — WAD 가 안 모인다");
  }
}

// ═══ A2. 같은 블록에 같은 이름을 두 번 선언했는가 ════════════════════
// **JSX 라 Node 가 파싱을 못 하는 구간을 메우는 검사다.**
// v2.5 에서 rAF 페이싱을 끼워 넣다가 이미 있던 const now 를 한 번 더
// 선언했고, "Identifier 'now' has already been declared" 로 컴포넌트가
// 통째로 안 떴다. 그때 A절(괄호 균형)·B절(금지어)·C·D절(데이터·부팅)이
// **전부 통과했다** — 아무도 문법을 안 봤기 때문이다.
// 검사 자체는 tools/check-dupe-decl.cjs 에 있다(그 파일 머리말 참조).
console.log("\nA2. 중복 선언");
{
  const { findDuplicateDeclarations } = require("./check-dupe-decl.cjs");
  const all = [[GAME_FILE, gameSrc]].concat(
    wadFiles.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), "utf8")]));
  let bad = 0;
  for (const [name, raw] of all) {
    for (const d of findDuplicateDeclarations(raw)) {
      fail(name + ":" + d.line + " 같은 블록에 " + d.name + " 를 두 번 선언했다");
      bad++;
    }
  }
  if (!bad) ok("같은 블록의 중복 선언 없음 (" + all.length + " 파일)");
}

// ═══ A3. 이 파일에 없는 이름을 참조하는가 ════════════════════════════
// 패치로 다른 파일(정찰본)의 코드를 옮겨오다 DoomGame 에 없는 setKeys · P 를
// 참조한 적이 있다. 그 키를 누르는 순간 ReferenceError 인데, JSX 라 Node 가
// 파싱을 못 해 검증이 전부 통과했다. A2 와 같은 부류의 구멍이다.
// 검사 자체는 tools/check-undeclared.cjs 에 있다(JSX 구간은 제외한다).
console.log("\nA3. 미선언 참조");
{
  const { findUndeclared } = require("./check-undeclared.cjs");
  const targets = [[GAME_FILE, gameSrc]];
  let bad = 0;
  for (const [name, raw] of targets) {
    for (const d of findUndeclared(raw)) {
      fail(name + ":" + d.line + " 선언되지 않은 이름 " + d.name);
      bad++;
    }
  }
  // 주입되는 원본 모듈도 같이 본다 — 그쪽 오류가 그대로 컴포넌트에 들어간다.
  for (const f of ["wasi-shim.js", "audio.js"]) {
    const raw = fs.readFileSync(path.join(ROOT, "doom", "src", f), "utf8");
    for (const d of findUndeclared(raw)) {
      fail("doom/src/" + f + ":" + d.line + " 선언되지 않은 이름 " + d.name);
      bad++;
    }
  }
  if (!bad) ok("미선언 참조 없음 (JSX 구간 제외)");
}

// ═══ B. 샌드박스 규약 + 정적 스캐너 ══════════════════════════════════
console.log("\nB. 샌드박스 규약 · 정적 스캐너");
{
  const all = [[GAME_FILE, gameSrc]].concat(
    wadFiles.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), "utf8")]));

  // 확인된 차단어 + 같은 부류. **주석도 소스다** — 업로드본은 주석을
  // 남기고 뽑으므로 사고를 기록한답시고 이름을 적으면 똑같이 막힌다.
  const CONFIRMED = ["Blob", "createObjectURL"];
  const LIKELY = ["XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage",
    "indexedDB", "importScripts", "innerHTML", "eval("];
  // base64 리터럴을 걷어낸다. **식별자 검사에만** 쓴다 —
  // `\buse[A-Z]\w*` 가 base64 안의 "useH8gxwz…" 를 훅으로 오인했다.
  const noData = (src) => src.replace(/"[A-Za-z0-9+/=]{40,}"/g, '""');

  let dirty = 0;
  for (const [name, src] of all) {
    // ⚠ 금지어는 **base64 를 포함해 원문 전체**에서 본다.
    //   Elyn 스캐너가 AST 를 보는지 단순 문자열 검색인지 모른다. 후자라면
    //   base64 안에 우연히 생긴 "Blob" 도 컴포넌트를 막는다.
    //   걸리면 gzip 레벨을 바꿔 바이트를 흔들면 사라진다.
    for (const w of CONFIRMED) if (src.indexOf(w) >= 0) { fail(name + ": 차단 확인된 이름 " + w + " (base64 안일 수도 있다)"); dirty++; }
    for (const w of LIKELY) if (src.indexOf(w) >= 0) { fail(name + ": 위험 이름 " + w); dirty++; }
    const bare = strip(noData(src));
    if (/\bReact\s*\./.test(bare)) { fail(name + ": React.* 사용"); dirty++; }
    if (/\b(import|export|require)\s*[({'"]/.test(bare)) { fail(name + ": 모듈 문법"); dirty++; }
    if (/\bdocument\s*\./.test(bare)) { fail(name + ": document.* 직접 접근"); dirty++; }
    if (/\bwindow\s*\./.test(bare)) { fail(name + ": window.* 직접 접근"); dirty++; }
    const hooks = [...new Set((bare.match(/\buse[A-Z]\w*/g) || []))];
    const badHooks = hooks.filter((h) =>
      ["useState", "useEffect", "useMemo", "useCallback", "useRef"].indexOf(h) < 0);
    if (badHooks.length) { fail(name + ": 지원 안 되는 훅 " + badHooks.join(",")); dirty++; }
  }
  if (!dirty) ok("차단어 없음 · React.* 없음 · 전역 직접 접근 없음 · 훅 5종만");
  info("목록은 관측에서 나온 것이지 Elyn 의 실제 규칙이 아니다 —");
  info("또 막히면 메시지에 뜬 이름을 CONFIRMED 에 추가할 것.");
}

// ═══ C. 주입된 데이터가 원본과 같은가 ════════════════════════════════
// 되읽기 대조. 정찰본 시료가 이중 이스케이프로 어긋난 적이 있다.
console.log("\nC. 주입 데이터 대조");
const grabB64 = (src, varName) => {
  const i = src.indexOf("const " + varName + " = ");
  if (i < 0) return null;
  const j = src.indexOf(".join('')", i);
  if (j < 0) return null;
  return new Function(src.slice(i, j + 9) + ";\nreturn " + varName + ";")();
};

let wasmBytes = null;
let wadBytes = null;
{
  const wasmB64 = grabB64(gameSrc, "WASM_GZ_B64");
  // ⚠ 자리표시자가 남아 있는지 먼저 본다. **데이터만 검사하면 못 잡는다** —
  //   실제로 `const createDoomAudio = null;` 이 그대로 올라가
  //   "createDoomAudio is not a function" 으로 죽은 적이 있다.
  //   그때 C·D절은 전부 통과했다. 데이터는 멀쩡했으니까.
  {
    let stale = 0;
    for (const n of ["WASM_GZ_B64", "createWasiShim", "createDoomAudio"]) {
      if (gameSrc.indexOf("const " + n + " = null") >= 0) { fail("주입 안 됨: " + n + " 이 자리표시자 그대로다"); stale++; }
    }
    if (!stale) ok("주입 자리표시자 없음 (wasm · shim · audio)");
  }

  if (!wasmB64) fail(GAME_FILE + " 에서 WASM_GZ_B64 를 못 읽었다 (주입 안 됨?)");
  else {
    wasmBytes = zlib.gunzipSync(Buffer.from(wasmB64, "base64"));
    const orig = fs.readFileSync(WASM_SRC);
    if (wasmBytes.equals(orig)) ok("엔진 wasm — 주입본이 원본과 바이트 동일 (" + (orig.length / 1024).toFixed(0) + " KB)");
    else fail("엔진 wasm 이 원본과 다르다 (" + wasmBytes.length + " vs " + orig.length + ")");
  }

  const parts = [];
  for (const f of wadFiles) {
    const s = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
    const d = grabB64(s, "DATA");
    if (!d) { fail(f + " 에서 DATA 를 못 읽었다"); parts.length = 0; break; }
    parts.push(d);
  }
  if (parts.length === wadFiles.length && parts.length > 0) {
    wadBytes = zlib.gunzipSync(Buffer.from(parts.join(""), "base64"));
    const orig = fs.readFileSync(WAD_SRC);
    if (wadBytes.equals(orig)) {
      ok("WAD — " + parts.length + "조각을 이어붙인 것이 원본과 바이트 동일 ("
        + (orig.length / 1024).toFixed(0) + " KB)");
    } else {
      fail("WAD 가 원본과 다르다 (" + wadBytes.length + " vs " + orig.length + ")");
      wadBytes = null;
    }
  }
}

// ═══ C2. 스프라이트 프레임 커버리지 ══════════════════════════════════
// **회귀 방지.** 실기에서 전투 중에만 죽던 버그가 여기였다:
//     R_ProjectSprite: invalid sprite frame 18 : 32769
// sprnames[18] = BAL1(임프 불덩이). 더미를 프레임 A 한 장만 넣었는데
// R_ProjectSprite 가 RANGECHECK 로 `frame >= numframes` 를 검사한다.
// R_InitSpriteDefs 는 0..max 사이 구멍도 I_Error 다. 그래서 **모든**
// 스프라이트가 0..max 를 빠짐없이 갖췄는지 본다.
console.log("\nC2. 스프라이트 프레임 커버리지");
if (wadBytes) {
  const { parseSprNames, spriteMaxFrames } = require("./doom-info.cjs");
  const { parseWad } = require("./wad-lib.cjs");
  const tmp = path.join(ROOT, "doom", "build", "_selftest.wad");
  fs.writeFileSync(tmp, wadBytes);
  const w = parseWad(tmp);
  fs.unlinkSync(tmp);
  const have = new Set(w.lumps.map((L) => L.name.toUpperCase()));
  const max = spriteMaxFrames();
  // ⚠ 판정 규칙은 r_things.c:233 이 정한다:
  //     · 프레임이 **하나도 없으면** numframes=0 으로 조용히 넘어간다 → 안전.
  //       (셰어웨어 doom1.wad 에 Doom 2 전용 스프라이트가 없는 게 정확히 이 경우다.
  //        바닐라 DOOM 이 원래 그렇게 배포됐고, Doom 1 에서는 스폰되지도 않는다.)
  //     · **일부만 있으면** I_Error 다 → 위험. 이것만 잡는다.
  const partial = [];
  const absent = [];
  for (const nm of parseSprNames()) {
    const last = max.has(nm) ? max.get(nm) : 0;
    const missing = [];
    let present = 0;
    for (let f = 0; f <= last; f++) {
      const letter = String.fromCharCode(65 + f);
      let found = false;
      for (let r = 0; r <= 8; r++) if (have.has(nm + letter + r)) { found = true; break; }
      if (!found) {
        // 8자 표기는 한 럼프가 두 프레임을 겸한다(<이름><F><R><F2><R2>).
        for (const n of have) {
          if (n.length === 8 && n.slice(0, 4) === nm && n[6] === letter) { found = true; break; }
        }
      }
      if (found) present++; else missing.push(letter);
    }
    if (present === 0) absent.push(nm);
    else if (missing.length) partial.push(nm + "[" + missing.join("") + "]");
  }
  if (partial.length === 0) {
    ok("프레임이 반쯤 빠진 스프라이트 없음 (전체 " + parseSprNames().length + "종)");
    if (absent.length) {
      info("통째로 없는 것 " + absent.length + "종 — 엔진이 조용히 넘어간다: "
        + absent.slice(0, 8).join(" ") + (absent.length > 8 ? " …" : ""));
    }
  } else {
    fail("프레임이 반쯤 빠진 스프라이트 " + partial.length + "종: " + partial.slice(0, 8).join(" ")
      + "  → 전투 중 R_ProjectSprite 가 I_Error 로 죽는다");
  }
} else {
  fail("WAD 를 못 읽어 프레임 검사를 건너뛴다");
}

// ═══ D. 주입된 바이트로 실제 부팅 ════════════════════════════════════
// **이 절이 핵심이다.** 파일에 적힌 그 base64 로 DOOM 이 뜨는지 본다.
console.log("\nD. 주입본 부팅");
if (!wasmBytes || !wadBytes) {
  fail("C절이 실패해 부팅을 시도하지 않는다");
  report();
} else {
  const t0 = Date.now();
  const nowMs = () => Date.now() - t0;
  let memory = null;
  const lines = [];
  const audio = createDoomAudio(() => memory, {});
  const shim = createWasiShim(() => memory, { nowMs, onOut: (l) => lines.push(l) });

  WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: shim,
    env: Object.assign({ js_now_ms: () => nowMs() >>> 0 }, audio.imports),
  }).then(({ instance }) => {
    const x = instance.exports;
    memory = x.memory;
    if (typeof x._initialize === "function") x._initialize();

    const ptr = x.doom_wad_alloc(wadBytes.length);
    if (!ptr) throw new Error("doom_wad_alloc 실패");
    // ⚠ 뷰는 매번 새로 잡는다. grow 하면 buffer 가 갈아치워진다.
    new Uint8Array(x.memory.buffer).set(wadBytes, ptr);

    x.doom_init();
    ok("doom_init 통과 (" + (Date.now() - t0) + "ms)");

    const W = x.doom_width(), H = x.doom_height();
    const fb = x.doom_frame_ptr();
    if (!fb) throw new Error("프레임버퍼가 없다");
    ok("프레임버퍼 " + W + "x" + H);

    // 실기의 rAF 처럼 간격을 두고 돌린다. 몰아치면 게임 시간이 안 흐른다.
    for (let i = 0; i < 30; i++) {
      const until = Date.now() + 16;
      x.doom_tick();
      while (Date.now() < until) { /* 프레임 간격 */ }
    }

    const px = new Uint32Array(x.memory.buffer, x.doom_frame_ptr(), W * H);
    const seen = new Set();
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 7) {
      if ((px[i] & 0xffffff) !== 0) nonBlack++;
      if (seen.size < 512) seen.add(px[i] >>> 0);
    }
    const pct = (100 * nonBlack) / Math.ceil(px.length / 7);
    if (pct > 50 && seen.size >= 8) ok("화면이 그려진다 — 비검정 " + pct.toFixed(0) + "% · 색 " + seen.size + "종");
    else fail("화면이 이상하다 — 비검정 " + pct.toFixed(0) + "% · 색 " + seen.size + "종");

    // 키가 크래시 없이 들어가는지. 실제 반응은 여기서 못 본다.
    try {
      x.doom_key(1, 0xa3); x.doom_tick(); x.doom_key(0, 0xa3); x.doom_tick();
      ok("doom_key 왕복 (발사)");
    } catch (e) { fail("doom_key 에서 throw: " + e.message); }

    info("DOOM 로그 " + lines.length + "줄 — 마지막: " + (lines[lines.length - 2] || "").trim());
    report();
  }).catch((e) => {
    fail("부팅 실패: " + (e && e.message ? e.message : e));
    for (const l of lines.slice(-6)) info("| " + l);
    report();
  });
}

// ═══ E. 크기 ═════════════════════════════════════════════════════════
function report() {
  console.log("\nE. 크기 (CRLF 업로드본 기준)");
  let total = 0;
  for (const f of [GAME_FILE].concat(wadFiles)) {
    const b = Buffer.byteLength(
      fs.readFileSync(path.join(SRC_DIR, f), "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
    total += b;
    info(f.padEnd(15) + (b / 1024).toFixed(0).padStart(6) + " KB");
  }
  info("합계".padEnd(15) + (total / 1024).toFixed(0).padStart(6) + " KB = "
    + (total / 1048576).toFixed(3) + " MiB");
  // 2026-08-28 실측: 4.515 MiB 가 무결로 통과했다(tools/make-payload-probe.cjs).
  if (total > 4.5 * 1048576) {
    console.log("  ⚠ 실측 확인된 4.515 MiB 를 넘었다 — 여기서부터는 미지수다.");
  }

  console.log("");
  if (failures === 0) {
    console.log("전부 통과. `node tools/export-doom.cjs` 로 뽑아 올려라.");
    console.log("⚠ <<RENDER>> 아래(React 배선·JSX)는 여기서 검증되지 않는다.");
  } else {
    console.log(failures + "건 실패. 고치기 전에는 올리지 말 것.");
    process.exitCode = 1;
  }
}
