// DoomGame.jsx + DoomWad*.jsx 를 Elyn 에 붙여넣을 형태로 뽑는다.
//
//   node tools/export-doom.cjs [출력폴더] [--keep-comments]   (기본: dist-doom/)
//
// ── 하는 일 둘 ───────────────────────────────────────────────────────
// 1. 주석 제거. 제약이 리비전 전체 페이로드라 작을수록 좋기는 하다. 다만
//    2026-08-28 에 4.515 MiB 무결이 확인됐으므로 **쥐어짜야 할 이유는 없다.**
//    그래도 벗기는 건 공짜라서다(16 KB).
// 2. LF → CRLF. **Elyn 에디터는 LF 만 있는 큰 파일을 제대로 못 받는다.**
//    CodeMirror 가 터지면서 붙여넣은 것과 저장된 것이 조용히 달라진다.
//    650 KB 짜리가 둘이나 있으므로 이건 선택이 아니다.
//
// 저장소는 LF + 주석 그대로 둔다. 결정 근거가 주석에 있고, 도구가 주석을
// 마커로 쓴다(`// <<WASM-DATA>>` 등).
const fs = require("fs");
const path = require("path");
const { stripFile } = require("./strip-comments.cjs");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "doom");
const argv = process.argv.slice(2);
const KEEP = argv.indexOf("--keep-comments") >= 0;

// build-doom-jsx.cjs --name 으로 뽑은 변종을 그대로 받는다.
//   node tools/export-doom.cjs --name Freedoom
// 출력은 기본으로 dist-<소문자이름> 이다 — 한 폴더에 섞이면 어느 쪽을
// 붙여넣는지 헷갈리고, 실제로 그런 사고가 제일 비싸다.
const ni = argv.indexOf("--name");
const NAME = ni >= 0 ? argv[ni + 1] : "Doom";
const GAME_FILE = NAME + "Game.jsx";
const WAD_RE = new RegExp("^" + NAME + "Wad[0-9]+[.]jsx$");
const outArg = argv.filter((a, i) => a.indexOf("--") !== 0 && argv[i - 1] !== "--name")[0];
const OUT = path.resolve(outArg || path.join(ROOT, "dist-" + NAME.toLowerCase()));

const FILES = [GAME_FILE].concat(
  fs.readdirSync(SRC_DIR)
    .filter((f) => WAD_RE.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));

for (const f of FILES) {
  if (!fs.existsSync(path.join(SRC_DIR, f))) { console.error("없다: " + f); process.exit(1); }
}

// 주입이 끝났는지 확인한다. 안 돌린 채로 뽑으면 엔진이 null 인 컴포넌트가
// 올라가고, 실기에서는 "엔진이 주입되지 않았다"만 보인다.
const game = fs.readFileSync(path.join(SRC_DIR, GAME_FILE), "utf8");
if (game.indexOf("const WASM_GZ_B64 = null") >= 0 || game.indexOf("const createWasiShim = null") >= 0) {
  console.error("주입이 안 됐다. `node tools/build-doom-jsx.cjs` 를 먼저 돌려라.");
  process.exit(1);
}
const buildNum = (game.match(/const DOOM_BUILD = '([^']+)'/) || [])[1] || "(없음)";

fs.mkdirSync(OUT, { recursive: true });

const kb = (b) => (b / 1024).toFixed(0).padStart(6) + " KB";
let total = 0;
let rawTotal = 0;

console.log(NAME + "  v" + buildNum + (KEEP ? "   (주석 유지 — 대조군)" : ""));
console.log("");
for (const f of FILES) {
  const src = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
  // stripFile 은 { text, cuts, cutChars } 를 돌려준다.
  const body = KEEP ? src : stripFile(src, f).text;
  const crlf = body.replace(/\r?\n/g, "\r\n");
  fs.writeFileSync(path.join(OUT, f), crlf, "utf8");
  const raw = Buffer.byteLength(src.replace(/\r?\n/g, "\r\n"), "utf8");
  const now = Buffer.byteLength(crlf, "utf8");
  rawTotal += raw;
  total += now;
  console.log("  " + f.padEnd(15) + kb(now)
    + (KEEP ? "" : "   (주석 포함 " + kb(raw) + ")"));
}
console.log("  " + "합계".padEnd(15) + kb(total) + "  = " + (total / 1048576).toFixed(3) + " MiB"
  + (KEEP ? "" : "   아낀 것 " + kb(rawTotal - total)));
console.log("");
console.log("→ " + OUT);
console.log("");

// 관측 기록이지 상한선이 아니다 — 실제 실패는 413 이 아니라 Cloudflare 524
// (타임아웃)이고 간헐적이며, 0.960 MiB 에서도 난 적이 있다.
console.log("관측: 4.515 MiB 무결 확인(2026-08-28). 용량 때문에 기능을 깎을 이유가 없다.");
if (total > 4.5 * 1048576) {
  console.log("⚠ 실측 확인된 4.515 MiB 를 넘었다 — 여기서부터는 미지수다.");
}
console.log("");
console.log("등록 순서");
console.log("  1. 컴포넌트 " + FILES.length + "개를 각각 새로 만든다:");
for (const f of FILES) console.log("       " + f.replace(".jsx", ""));
console.log("     (레지스트리가 평면 전역이라 이름이 겹치면 안 되고,");
console.log("      하나라도 빠지면 화면이 'wad' 단계에서 멈춘다)");
console.log("  2. 프리뷰 입력에  <" + NAME + "Game />");
console.log("  3. 화면을 클릭해 포커스를 잡는다 — window 가 없어서");
console.log("     포커스를 잃으면 키가 안 들어온다.");
console.log("  4. 이동 WASD/방향키 · 발사 Space · 사용 E · 메뉴 Esc");
