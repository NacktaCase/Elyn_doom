// doom.wasm · doom.wad · wasi-shim.js 를 JSX 컴포넌트에 주입한다.
//
//   node tools/build-doom-jsx.cjs [--parts N]
//
// `// <<WASM-DATA>>` 같은 마커를 찾아 그 자리를 채운다. 주입 블록은
// 생성물이므로 손으로 고치지 말 것.
//
// ── 왜 gzip 인가 ─────────────────────────────────────────────────────
// 샌드박스가 DecompressionStream 으로 gzip 을 네이티브로 푸는 것을 실측으로
// 확인했다. 그래서 원본이 아니라 **압축한 것을 base64 로 싣고 런타임에
// 푼다.** WAD 는 2.7 MB 지만 gzip 이 956 KB 라 페이로드가 3분의 1이 된다.
//
// ── 왜 WAD 를 쪼개는가 ───────────────────────────────────────────────
// 페이로드는 리비전 단위라 나눠도 총량이 같다. 쪼개는 건 **에디터** 때문이다:
// 큰 파일을 붙여넣으면 CodeMirror 가 터지면서 **붙여넣은 것과 저장된 것이
// 달라진다**(README "CRLF 로 뽑는다"). ChessPieces.jsx 가 693 KB 로 도는 것은
// 확인됐으므로 그 근처로 끊는다.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "doom", "build", "doom-Oz.wasm");
const WAD = path.join(ROOT, "doom", "build", "doom.wad");
const SHIM = path.join(ROOT, "doom", "src", "wasi-shim.js");
const AUDIO = path.join(ROOT, "doom", "src", "audio.js");
const GAME = path.join(ROOT, "doom", "DoomGame.jsx");

const argv = process.argv.slice(2);
const opt = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
const PARTS = parseInt(opt("--parts", "2"), 10);

// ── 이름 붙은 변종 ───────────────────────────────────────────────────
// Elyn 레지스트리는 **평면 전역**이라 같은 이름을 두 번 등록할 수 없다.
// 그래서 다른 에셋(예: Freedoom)으로 한 벌 더 만들려면 컴포넌트 이름
// 자체가 달라야 한다: --name Freedoom → FreedoomGame · FreedoomWad1..N
//
// 원본 DoomGame.jsx 는 **언제나 템플릿**이다. 기본(--name Doom)일 때만
// 제자리에 쓰고, 변종은 새 파일로 뽑는다 — 그래야 변종을 만들다 원본을
// 망가뜨리지 않는다.
const NAME = opt("--name", "Doom");
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(NAME)) {
  console.error("--name 은 식별자여야 한다: " + NAME);
  process.exit(1);
}
const IN_PLACE = NAME === "Doom";
const GAME_OUT = path.join(ROOT, "doom", NAME + "Game.jsx");
const WAD_IN = opt("--wad", WAD);

for (const f of [WASM, WAD_IN, SHIM, AUDIO, GAME]) {
  if (!fs.existsSync(f)) { console.error("없다: " + f); process.exit(1); }
}

// base64 한 줄 길이. 줄마다 들여쓰기·따옴표·쉼표·CRLF 로 11자가 붙으므로
// 120 이면 오버헤드가 9%(1275 KB 중 ~100 KB)다. 500 이면 2%로 떨어진다.
// CodeMirror 사고는 **파일 크기**에서 났지 줄 길이에서 난 게 아니다
// (README "CRLF 로 뽑는다" — LF 로 붙여넣은 큰 파일이 원인이었다).
const CHUNK = 500;
const wrapB64 = (b64, indent) => {
  const lines = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    lines.push(indent + '  "' + b64.slice(i, i + CHUNK) + '",');
  }
  return "[\n" + lines.join("\n") + "\n" + indent + "].join('')";
};

const replaceBlock = (src, begin, end, body, file) => {
  const i = src.indexOf(begin);
  const j = src.indexOf(end);
  if (i < 0 || j < 0 || j <= i) {
    console.error(file + " 에 " + begin + " … " + end + " 블록이 없다.");
    process.exit(1);
  }
  return src.slice(0, i) + body + src.slice(j + end.length);
};

let game = fs.readFileSync(GAME, "utf8");

// ── 1. 엔진 wasm ─────────────────────────────────────────────────────
const wasm = fs.readFileSync(WASM);
if (!(wasm[0] === 0 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) {
  console.error("WASM 매직이 아니다.");   // 엉뚱한 파일을 실으면 런타임에야 터진다
  process.exit(1);
}
const wasmGz = zlib.gzipSync(wasm, { level: 9 });
const wasmB64 = wasmGz.toString("base64");
game = replaceBlock(game, "  // <<WASM-DATA>>", "  // <</WASM-DATA>>", [
  "  // <<WASM-DATA>>",
  "  // 생성물이다 — 손으로 고치지 말 것. `node tools/build-doom-jsx.cjs`.",
  "  // doomgeneric, wasi-sdk clang -Oz. Emscripten glue 없음.",
  "  //   원본 " + wasm.length + "B → gzip " + wasmGz.length + "B ("
    + ((100 * wasmGz.length) / wasm.length).toFixed(0) + "%)",
  "  const WASM_GZ_B64 = " + wrapB64(wasmB64, "  ") + ";",
  "  // <</WASM-DATA>>",
].join("\n"), "DoomGame.jsx");

// ── 2. JS 모듈 옮겨심기 (WASI shim · 오디오) ─────────────────────────
// 원본 파일을 그대로 옮긴다. **여기서 로직을 다시 쓰지 않는다** — Node 검증
// (doom-boot.cjs, doom-selftest.cjs)이 돌린 바로 그 코드가 실기에도 올라가야
// 한다. 두 벌이 되는 순간 검증이 실기를 안 지킨다.
const inlineModule = (file, fnName) => {
  let src = fs.readFileSync(file, "utf8");
  const at = src.indexOf("function " + fnName);
  if (at < 0) { console.error(path.basename(file) + " 에 " + fnName + " 가 없다."); process.exit(1); }
  src = src.slice(at);
  const modIdx = src.indexOf('if (typeof module !== "undefined"');
  if (modIdx > 0) src = src.slice(0, modIdx);
  src = src.replace("function " + fnName + "(", "const " + fnName + " = function (");
  src = src.replace(/\}\s*$/, "};");
  // 컴포넌트 본문 안이므로 두 칸 들여쓴다.
  return src.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n").replace(/\s+$/, "");
};

game = replaceBlock(game, "  // <<WASI-SHIM>>", "  // <</WASI-SHIM>>", [
  "  // <<WASI-SHIM>>",
  "  // 생성물이다 — 원본은 doom/src/wasi-shim.js 다. 손으로 고치지 말 것.",
  "  // Node 검증이 돌리는 바로 그 코드다.",
  inlineModule(SHIM, "createWasiShim"),
  "  // <</WASI-SHIM>>",
].join("\n"), "DoomGame.jsx");

game = replaceBlock(game, "  // <<AUDIO>>", "  // <</AUDIO>>", [
  "  // <<AUDIO>>",
  "  // 생성물이다 — 원본은 doom/src/audio.js 다. 손으로 고치지 말 것.",
  inlineModule(AUDIO, "createDoomAudio"),
  "  // <</AUDIO>>",
].join("\n"), "DoomGame.jsx");

// ⚠ 자리표시자가 남아 있으면 **주입이 안 된 것이다.** 한 번 이렇게 당했다:
//   빌더 패치가 조용히 안 먹어 `const createDoomAudio = null;` 이 그대로
//   올라갔고, 실기에서 "createDoomAudio is not a function" 으로 죽었다.
//   자체검증은 데이터 블록만 보느라 못 잡았다. 여기서 막는다.
for (const name of ["WASM_GZ_B64", "createWasiShim", "createDoomAudio"]) {
  if (game.indexOf("const " + name + " = null") >= 0) {
    console.error("주입 실패: " + name + " 이 자리표시자 그대로다.");
    process.exit(1);
  }
}

// ── 2.5. 운반체 배선을 다시 짠다 ─────────────────────────────────────
// 운반체 개수와 이름은 **빌드 인자**로 정해지는데 JSX 에는 손으로 적혀
// 있었다. 그래서 `--parts 4` 를 줘도 컴포넌트는 여전히 `want: 2` 에
// 운반체 두 개만 렌더했다 — 조각 4개를 만들어놓고 2개만 받으니 영원히
// 'wad' 단계에서 멈춘다. 배선을 생성물로 돌려 원리적으로 막는다.
game = game.replace(/\bfunction DoomGame\s*\(/, "function " + NAME + "Game(");
game = game.replace(/want:\s*\d+/, "want: " + PARTS);

{
  // 줄 단위로 바꾼다. 운반체 줄들을 걷어내고 그 자리에 생성한 줄을 넣는다.
  const isCarrier = (L) => /^\s*<[A-Za-z0-9]+Wad\d+ onData=\{\(t\) => onWadPart\(\d+, t\)\} \/>\s*$/.test(L);
  const src = game.split("\n");
  const at = src.findIndex(isCarrier);
  if (at < 0) {
    console.error("운반체 배선을 못 찾았다 — DoomGame.jsx 의 <...WadN onData=.../> 줄이 바뀌었나?");
    process.exit(1);
  }
  let stop = at;
  while (stop < src.length && isCarrier(src[stop])) stop++;

  const made = [];
  for (let q = 0; q < PARTS; q++) {
    made.push("      <" + NAME + "Wad" + (q + 1) + " onData={(t) => onWadPart(" + q + ", t)} />");
  }
  src.splice(at, stop - at, ...made);
  game = src.join("\n");

  // 개수를 세는 안내 문구도 같이 맞춘다(운반체 + 게임 컴포넌트).
  game = game.replace(/⚠ (?:셋 다|\d+개 모두) 레지스트리에/, "⚠ " + (PARTS + 1) + "개 모두 레지스트리에");
  game = game.replace(/\/\/   [A-Za-z0-9]+Wad1 [^\n]*?   WAD /,
    "//   " + made.map((_, i) => NAME + "Wad" + (i + 1)).join(" · ") + "   WAD ");
}

fs.writeFileSync(GAME_OUT, game);

// ── 3. WAD 를 조각내 운반체 컴포넌트로 ───────────────────────────────
const wad = fs.readFileSync(WAD_IN);
const wadGz = zlib.gzipSync(wad, { level: 9 });
const wadB64 = wadGz.toString("base64");
const per = Math.ceil(wadB64.length / PARTS);

// 조각 경계는 base64 4바이트 단위에 맞출 필요가 없다 — 받는 쪽이 join 한 뒤
// 한 번에 디코드하기 때문이다. 그래도 4의 배수로 끊어두면 사람이 조각 하나만
// 떼어 확인할 수 있어 편하다.
const cut = per - (per % 4);

const wadFiles = [];
for (let p = 0; p < PARTS; p++) {
  const name = NAME + "Wad" + (p + 1);
  const slice = wadB64.slice(p * cut, p === PARTS - 1 ? undefined : (p + 1) * cut);
  const src = [
    "function " + name + "(props) {",
    "  // ═══════════════════════════════════════════════════════════",
    "  // WAD 운반체 " + (p + 1) + "/" + PARTS + " — **생성물이다.** 손으로 고치지 말 것.",
    "  //   node tools/build-doom-jsx.cjs",
    "  //",
    "  // 헤드리스다. 아무것도 그리지 않고 자기 몫의 base64 를 onData 로 넘긴다.",
    "  // ChessPieces 가 onResult 로 기물 데이터를 넘기는 것과 같은 패턴이다.",
    "  //",
    "  // DoomGame 이 조각을 다 모으면 이어붙여 gzip 해제한다. 쪼개는 이유는",
    "  // 페이로드가 아니라 에디터다 — 큰 파일은 붙여넣기 중 CodeMirror 가",
    "  // 터지면서 붙여넣은 것과 저장된 것이 조용히 달라진다.",
    "  // ═══════════════════════════════════════════════════════════",
    "  const DATA = " + wrapB64(slice, "  ") + ";",
    "",
    "  // 마운트당 한 번만 넘긴다. 리렌더로 여러 번 불려도 DoomGame 쪽에서",
    "  // 같은 인덱스를 무시하지만, 여기서도 안 보내는 게 맞다.",
    "  useEffect(() => {",
    "    if (typeof props.onData === 'function') props.onData(DATA);",
    "  }, []);",
    "",
    "  return null;",
    "}",
    "",
  ].join("\n");
  const file = path.join(ROOT, "doom", name + ".jsx");
  fs.writeFileSync(file, src);
  wadFiles.push({ name, file, bytes: Buffer.byteLength(src, "utf8") });
}

// ── 보고 ─────────────────────────────────────────────────────────────
const kb = (b) => (b / 1024).toFixed(0).padStart(6) + " KB";
const gameBytes = Buffer.byteLength(fs.readFileSync(GAME_OUT, "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
let total = gameBytes;

console.log("주입 완료");
console.log("");
console.log("  엔진   " + kb(wasm.length) + " → gzip " + kb(wasmGz.length)
  + " → base64 " + kb(wasmB64.length));
console.log("  WAD    " + kb(wad.length) + " → gzip " + kb(wadGz.length)
  + " → base64 " + kb(wadB64.length) + "  (" + PARTS + " 조각)");
console.log("");
console.log("  파일 (CRLF 기준)");
console.log("    " + path.basename(GAME_OUT) + "  " + kb(gameBytes));
for (const f of wadFiles) {
  const crlf = Buffer.byteLength(fs.readFileSync(f.file, "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
  total += crlf;
  console.log("    " + (f.name + ".jsx").padEnd(14) + kb(crlf));
}
console.log("    " + "합계".padEnd(14) + kb(total) + "  = " + (total / 1048576).toFixed(3) + " MiB");
console.log("");
// 2026-08-28 실측: 660 KB × 7 = **4.515 MiB 가 전부 무결로 통과**했다
// (tools/make-payload-probe.cjs — 각 조각이 자기 해시를 대조한다).
// 그 이전의 "3.15 MiB 실패"는 옛 공개 제출 경로의 관측이고, 비공개 저장은
// 그때도 3 MiB 가 됐다고 한다. **용량 때문에 기능을 깎을 이유가 없다.**
console.log("  관측: 4.515 MiB 무결 확인(2026-08-28) · 그 이전 3.15 MiB 실패는 옛 공개 제출 경로");
if (total > 4.5 * 1048576) {
  console.log("  ⚠ 실측 확인된 4.515 MiB 를 넘었다. 여기서부터는 미지수다.");
}
