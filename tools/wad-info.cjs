// WAD 를 열어 럼프를 분류하고 용량을 집계한다.
//
//   node tools/wad-info.cjs <wad> [--lumps] [--map E1M1]
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────
// DOOM 엔진 쪽은 끝났다(378 KB → base64 208 KB). 남은 문제는 WAD 하나인데,
// freedoom1.wad 가 27.5 MB 다. Elyn 페이로드에 올리려면 두 자릿수 배로 깎아야
// 하고, 그러려면 **무엇이 용량을 먹는지** 먼저 알아야 한다.
//
// 추측으로 깎으면 안 된다 — 스프라이트가 대부분일 거라고 짐작했지만
// 실제로 뭐가 얼마인지는 세어봐야 안다.
//
// ── WAD 포맷 ─────────────────────────────────────────────────────────
//   헤더 12B : "IWAD"|"PWAD"(4) · numlumps(i32 LE) · infotableofs(i32 LE)
//   디렉터리 : numlumps × 16B = filepos(i32) · size(i32) · name(8B, NUL 패딩)
// 럼프는 이름만으로 종류를 알 수 없고 **위치(마커 사이)** 로 갈린다.
const fs = require("fs");

const argv = process.argv.slice(2);
const WAD = argv.filter((a) => a.indexOf("--") !== 0)[0];
const SHOW_LUMPS = argv.includes("--lumps");
const mapArg = (() => { const i = argv.indexOf("--map"); return i >= 0 ? argv[i + 1] : null; })();

if (!WAD) { console.error("사용: node tools/wad-info.cjs <wad> [--lumps] [--map E1M1]"); process.exit(1); }

const buf = fs.readFileSync(WAD);
const magic = buf.toString("ascii", 0, 4);
if (magic !== "IWAD" && magic !== "PWAD") { console.error("WAD 가 아니다: " + magic); process.exit(1); }

const numLumps = buf.readInt32LE(4);
const dirOfs = buf.readInt32LE(8);

const lumps = [];
for (let i = 0; i < numLumps; i++) {
  const o = dirOfs + i * 16;
  const name = buf.toString("ascii", o + 8, o + 16).replace(/\0+$/, "");
  lumps.push({ i, pos: buf.readInt32LE(o), size: buf.readInt32LE(o + 4), name });
}

// ── 분류 ─────────────────────────────────────────────────────────────
// 마커(S_START/S_END 등)는 크기 0 인 이름표다. 그 사이에 있는 럼프가
// 그 종류다 — 이름 규칙이 아니라 **위치**가 종류를 정한다.
const MAP_LUMPS = new Set([
  "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS",
  "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP", "BEHAVIOR",
]);
const isMapName = (n) => /^E\dM\d$/.test(n) || /^MAP\d\d$/.test(n);

let zone = null;          // 'sprite' | 'flat' | 'patch'
let currentMap = null;
const maps = new Map();   // 맵이름 → { lumps:[], bytes }

for (let i = 0; i < lumps.length; i++) {
  const L = lumps[i];
  const n = L.name;

  // 마커 전환. Freedoom 은 FF_START/F_START 를 섞어 쓰므로 둘 다 본다.
  if (/^S[S]?_START$/.test(n)) { zone = "sprite"; L.kind = "marker"; continue; }
  if (/^S[S]?_END$/.test(n)) { zone = null; L.kind = "marker"; continue; }
  if (/^F[F]?\d?_START$/.test(n)) { zone = "flat"; L.kind = "marker"; continue; }
  if (/^F[F]?\d?_END$/.test(n)) { zone = null; L.kind = "marker"; continue; }
  if (/^P[P]?\d?_START$/.test(n)) { zone = "patch"; L.kind = "marker"; continue; }
  if (/^P[P]?\d?_END$/.test(n)) { zone = null; L.kind = "marker"; continue; }

  if (isMapName(n)) {
    currentMap = n;
    maps.set(n, { lumps: [L], bytes: 0 });
    L.kind = "map";
    continue;
  }
  if (currentMap && MAP_LUMPS.has(n)) {
    const m = maps.get(currentMap);
    m.lumps.push(L);
    m.bytes += L.size;
    L.kind = "map";
    L.map = currentMap;
    continue;
  }
  currentMap = null;   // 맵 럼프 연속이 끊기면 그 맵은 끝났다

  if (zone) { L.kind = zone; continue; }
  if (/^DS/.test(n) || n === "GENMIDI" || n === "DMXGUS") { L.kind = "sound"; continue; }
  if (/^D_/.test(n)) { L.kind = "music"; continue; }
  if (/^DEMO\d/.test(n)) { L.kind = "demo"; continue; }
  if (n === "PLAYPAL" || n === "COLORMAP") { L.kind = "colour"; continue; }
  if (n === "TEXTURE1" || n === "TEXTURE2" || n === "PNAMES") { L.kind = "texdef"; continue; }
  L.kind = "other";
}

// ── 집계 ─────────────────────────────────────────────────────────────
const cat = new Map();
for (const L of lumps) {
  const k = L.kind || "other";
  const c = cat.get(k) || { n: 0, bytes: 0 };
  c.n++; c.bytes += L.size;
  cat.set(k, c);
}

const total = buf.length;
const mb = (b) => (b / 1048576).toFixed(2) + " MB";
const pct = (b) => ((100 * b) / total).toFixed(1).padStart(5) + "%";

console.log(WAD + "   " + magic + "   " + numLumps + " lumps   " + mb(total));
console.log("");
console.log("종류        개수      크기      비중");
console.log("─".repeat(46));
const order = [...cat.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
for (const [k, c] of order) {
  console.log(k.padEnd(10) + String(c.n).padStart(6) + "  " + mb(c.bytes).padStart(10) + "  " + pct(c.bytes));
}
console.log("─".repeat(46));
console.log("맵 개수: " + maps.size + "  (" + [...maps.keys()].join(" ") + ")");

// 맵별 크기 — "맵 하나만 남기면 얼마인가" 의 출발점이다.
console.log("");
console.log("맵별 지오메트리 크기");
const mapList = [...maps.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
for (const [name, m] of mapList.slice(0, 8)) {
  console.log("  " + name.padEnd(8) + (m.bytes / 1024).toFixed(0).padStart(6) + " KB");
}
if (mapList.length > 8) console.log("  … " + (mapList.length - 8) + "개 더");
const mapTotal = mapList.reduce((s, [, m]) => s + m.bytes, 0);
console.log("  합계    " + (mapTotal / 1024).toFixed(0).padStart(6) + " KB  (" + pct(mapTotal).trim() + ")");

if (SHOW_LUMPS) {
  console.log("");
  console.log("가장 큰 럼프 30개");
  for (const L of [...lumps].sort((a, b) => b.size - a.size).slice(0, 30)) {
    console.log("  " + L.name.padEnd(10) + (L.kind || "?").padEnd(9) + (L.size / 1024).toFixed(1).padStart(9) + " KB");
  }
}

if (mapArg) {
  const m = maps.get(mapArg.toUpperCase());
  if (!m) console.log("\n맵 " + mapArg + " 없음");
  else {
    console.log("");
    console.log(mapArg.toUpperCase() + " 럼프");
    for (const L of m.lumps) console.log("  " + L.name.padEnd(10) + (L.size / 1024).toFixed(1).padStart(9) + " KB");
    console.log("  합계     " + (m.bytes / 1024).toFixed(1).padStart(9) + " KB");
  }
}
