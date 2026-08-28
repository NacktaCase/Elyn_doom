// 커밋된 배포본만으로 DOOM 이 부팅하는지 본다.
//
//   node tools/doom-smoke.cjs [--name Freedoom] [--ticks 600]
//
// ── doom-selftest.cjs 와 뭐가 다른가 ─────────────────────────────────
// selftest 는 주입된 데이터를 **원본과 대조**한다. 그러려면 doom/build/ 의
// 빌드 산출물이 있어야 하고, 그건 wasi-sdk 34 와 28 MB WAD 다운로드를 뜻한다.
// 개발 기계에서는 맞는 검사지만 **CI 에서는 못 돈다.**
//
// 여기서는 대조를 포기하는 대신 아무것도 요구하지 않는다. dist-freedoom/ 이
// 저장소에 있으니 거기서 엔진과 WAD 를 꺼내 그냥 돌려본다. 이게 답하는 질문은
// 하나고, 그게 붙여넣는 사람에게 유일하게 중요한 질문이다:
//
//   **지금 저장소에 있는 그 파일을 복사해 넣으면 DOOM 이 뜨는가.**
//
// 갓 클론한 상태에서 도는 유일한 검증이라 CI 가 이걸 돌린다.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { findDuplicateDeclarations } = require("./check-dupe-decl.cjs");
const { findUndeclared } = require("./check-undeclared.cjs");

const ROOT = path.join(__dirname, "..");
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const NAME = argOf("--name", "Freedoom");
const TICKS = argOf("--ticks", "600");
const DIST = path.join(ROOT, "dist-" + NAME.toLowerCase());

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

if (!fs.existsSync(DIST)) {
  console.error("배포본이 없다: " + path.relative(ROOT, DIST));
  process.exit(1);
}

// ── 주입된 배열을 꺼낸다 ─────────────────────────────────────────────
// 배포본은 주석이 벗겨져 있어 `// <<WASM-DATA>>` 마커를 쓸 수 없다. 대신
// 선언 이름으로 찾는다 — build-doom-jsx.cjs 가 그 이름으로 주입한다.
function pull(file, varName) {
  const src = fs.readFileSync(path.join(DIST, file), "utf8");
  const head = src.indexOf("const " + varName + " = [");
  if (head < 0) throw new Error(file + " 에서 " + varName + " 를 못 찾았다");
  const body = src.slice(head, src.indexOf("];", head));
  const parts = body.match(/"[^"]*"/g);
  if (!parts) throw new Error(file + " 의 " + varName + " 가 비었다");
  return parts.map((s) => s.slice(1, -1)).join("");
}
const inflate = (b64) => zlib.gunzipSync(Buffer.from(b64, "base64"));

const GAME_FILE = NAME + "Game.jsx";
const wadFiles = fs.readdirSync(DIST)
  .filter((f) => new RegExp("^" + NAME + "Wad[0-9]+[.]jsx$").test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

// ═══ A. 정적 검사 ════════════════════════════════════════════════════
// JSX 라 Node 가 파싱을 못 하는 구간을 메운다. 부팅까지 갈 것도 없이
// 여기서 걸리면 컴포넌트가 통째로 안 뜬다.
console.log("A. 정적 검사");
for (const f of [GAME_FILE].concat(wadFiles)) {
  const src = fs.readFileSync(path.join(DIST, f), "utf8");
  const dups = findDuplicateDeclarations(src);
  const undecl = findUndeclared(src);
  for (const d of dups) fail(f + ":" + d.line + "  `" + d.name + "` 중복 선언");
  for (const u of undecl) fail(f + ":" + u.line + "  `" + u.name + "` 선언 없음");
  if (!dups.length && !undecl.length) ok(f);
}

// ═══ B. 등록에 필요한 것이 다 있나 ═══════════════════════════════════
// 레지스트리가 평면 전역이라 **하나만 빠져도** 로딩에서 멈춘다. 조각이
// 몇 개여야 하는지는 Game 쪽 배선이 알고 있으므로 거기서 읽어 맞춘다.
console.log("");
console.log("B. 구성");
const gameSrc = fs.readFileSync(path.join(DIST, GAME_FILE), "utf8");
const wired = gameSrc.match(new RegExp(NAME + "Wad[0-9]+", "g")) || [];
const wantedParts = new Set(wired);
if (!wadFiles.length) fail("운반체가 하나도 없다");
else if (wantedParts.size !== wadFiles.length) {
  fail("Game 은 " + wantedParts.size + " 조각을 부르는데 파일은 " + wadFiles.length + " 개다");
} else ok(GAME_FILE + " + 운반체 " + wadFiles.length + " 개");

// ═══ C. 데이터를 꺼내 푼다 ═══════════════════════════════════════════
console.log("");
console.log("C. 데이터");
let wasm = null;
let wad = null;
try {
  wasm = inflate(pull(GAME_FILE, "WASM_GZ_B64"));
  if (wasm.slice(0, 4).toString("hex") !== "0061736d") fail("wasm 매직이 아니다");
  else ok("엔진 " + (wasm.length / 1024).toFixed(0) + " KB");
} catch (e) { fail("엔진: " + e.message); }
try {
  wad = inflate(wadFiles.map((f) => pull(f, "DATA")).join(""));
  if (wad.slice(0, 4).toString() !== "IWAD" && wad.slice(0, 4).toString() !== "PWAD") {
    fail("WAD 헤더가 아니다: " + JSON.stringify(wad.slice(0, 4).toString()));
  } else ok("WAD " + (wad.length / 1024 / 1024).toFixed(2) + " MB");
} catch (e) { fail("WAD: " + e.message); }

if (failures || !wasm || !wad) {
  console.log("");
  console.log("✗ " + failures + " 건 — 부팅까지 못 간다.");
  process.exit(1);
}

// ═══ D. 실제로 부팅시킨다 ════════════════════════════════════════════
// 부팅 로직을 여기 옮겨 적지 않는다. 두 벌이 되면 갈라지고, 갈라지면
// **검증하는 쪽이 실기와 달라진다.** doom-boot.cjs 를 그대로 부른다.
console.log("");
console.log("D. 부팅 (" + TICKS + " 틱)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doom-smoke-"));
try {
  const wasmPath = path.join(tmp, "doom.wasm");
  const wadPath = path.join(tmp, "doom.wad");
  fs.writeFileSync(wasmPath, wasm);
  fs.writeFileSync(wadPath, wad);
  execFileSync(process.execPath,
    [path.join(__dirname, "doom-boot.cjs"), TICKS, "--wasm", wasmPath, "--wad", wadPath],
    { stdio: "inherit" });
} catch (e) {
  console.log("");
  console.log("✗ 배포본이 부팅하지 않는다.");
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log("✓ " + path.relative(ROOT, DIST) + " 를 그대로 붙여넣으면 DOOM 이 뜬다.");
