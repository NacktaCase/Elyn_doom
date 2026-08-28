// 맵 하나가 실제로 참조하는 에셋을 추적해 "이 맵만 남기면 얼마인가"를 잰다.
//
//   node tools/wad-deps.cjs <wad> <map>
//
// ── 왜 추적이 필요한가 ───────────────────────────────────────────────
// freedoom1.wad 는 27.5 MB 인데 그중 맵 36개가 10 MB, 벽 패치가 9.6 MB 다.
// 한 맵만 남기면 앞엣것은 138 KB 로 줄지만, **패치는 그 맵이 뭘 쓰느냐에
// 달렸다.** 짐작으로 깎으면 R_TextureNumForName 이 I_Error 로 죽는다.
//
// ── 의존 사슬 ────────────────────────────────────────────────────────
//   SECTORS  → 바닥/천장 flat 이름
//   SIDEDEFS → 벽 텍스처 이름 (upper/lower/middle)
//   텍스처 이름 → TEXTURE1/2 의 정의 → 그 정의가 조합하는 patch 인덱스
//                → PNAMES 로 patch 럼프 이름
//
// ── 애니메이션 함정 ──────────────────────────────────────────────────
// P_InitPicAnims 는 시작/끝 이름 사이의 **모든** 프레임을 요구한다.
// NUKAGE1 만 쓰여도 NUKAGE2·NUKAGE3 이 있어야 하고, 없으면 I_Error 다.
// 그래서 사용된 이름이 애니메이션 그룹에 걸리면 그룹 전체를 끌고 온다.
// (표는 p_spec.c 의 animdefs 원문에서 옮겼다.)
const fs = require("fs");

const [WAD, MAPNAME] = process.argv.slice(2);
if (!WAD || !MAPNAME) {
  console.error("사용: node tools/wad-deps.cjs <wad> <map>");
  process.exit(1);
}

const buf = fs.readFileSync(WAD);
const numLumps = buf.readInt32LE(4);
const dirOfs = buf.readInt32LE(8);

const lumps = [];
const byName = new Map();
for (let i = 0; i < numLumps; i++) {
  const o = dirOfs + i * 16;
  const L = {
    i,
    pos: buf.readInt32LE(o),
    size: buf.readInt32LE(o + 4),
    name: buf.toString("ascii", o + 8, o + 16).replace(/\0.*$/, ""),
  };
  lumps.push(L);
  if (!byName.has(L.name)) byName.set(L.name, L);
}
const data = (L) => buf.subarray(L.pos, L.pos + L.size);
const nameAt = (b, o) => b.toString("ascii", o, o + 8).replace(/\0.*$/, "").toUpperCase();

// ── 맵 럼프 찾기 ─────────────────────────────────────────────────────
const mi = lumps.findIndex((L) => L.name === MAPNAME.toUpperCase());
if (mi < 0) { console.error("맵 없음: " + MAPNAME); process.exit(1); }
const MAP_LUMPS = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS",
  "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP"];
const mapLumps = [lumps[mi]];
for (let i = mi + 1; i < lumps.length && MAP_LUMPS.indexOf(lumps[i].name) >= 0; i++) {
  mapLumps.push(lumps[i]);
}
const mapLump = (n) => mapLumps.find((L) => L.name === n);

// ── SECTORS → flat ───────────────────────────────────────────────────
// 레코드 26B: floorh(2) ceilh(2) floorpic(8) ceilpic(8) light(2) special(2) tag(2)
const flatsUsed = new Set();
{
  const b = data(mapLump("SECTORS"));
  for (let o = 0; o + 26 <= b.length; o += 26) {
    flatsUsed.add(nameAt(b, o + 4));
    flatsUsed.add(nameAt(b, o + 12));
  }
}

// ── SIDEDEFS → 텍스처 ────────────────────────────────────────────────
// 레코드 30B: xoff(2) yoff(2) upper(8) lower(8) middle(8) sector(2)
const texUsed = new Set();
{
  const b = data(mapLump("SIDEDEFS"));
  for (let o = 0; o + 30 <= b.length; o += 30) {
    for (const off of [4, 12, 20]) {
      const n = nameAt(b, o + off);
      if (n && n !== "-") texUsed.add(n);
    }
  }
}

// ── THINGS → 배치된 오브젝트 종류 ────────────────────────────────────
// 레코드 10B: x(2) y(2) angle(2) type(2) flags(2)
// doomednum → 스프라이트 변환은 info.c 표가 필요해서 여기서는 종류만 센다.
// (스프라이트 프루닝은 별도 단계다 — 통째로 빼거나 통째로 남기거나이므로
//  부분 최적화가 안 되고, 그래서 지금 단계의 숫자에 영향이 없다.)
const thingTypes = new Map();
{
  const b = data(mapLump("THINGS"));
  for (let o = 0; o + 10 <= b.length; o += 10) {
    const t = b.readInt16LE(o + 6);
    thingTypes.set(t, (thingTypes.get(t) || 0) + 1);
  }
}

// ── 애니메이션 그룹 (p_spec.c animdefs 원문) ─────────────────────────
// [마지막, 처음] 순서로 적혀 있고 그 사이 번호가 전부 필요하다.
const ANIMS = [
  ["NUKAGE3", "NUKAGE1"], ["FWATER4", "FWATER1"], ["SWATER4", "SWATER1"],
  ["LAVA4", "LAVA1"], ["BLOOD3", "BLOOD1"],
  ["RROCK08", "RROCK05"], ["SLIME04", "SLIME01"], ["SLIME08", "SLIME05"],
  ["SLIME12", "SLIME09"],
  ["BLODGR4", "BLODGR1"], ["SLADRIP3", "SLADRIP1"], ["BLODRIP4", "BLODRIP1"],
  ["FIREWALL", "FIREWALA"], ["GSTFONT3", "GSTFONT1"], ["FIRELAVA", "FIRELAV3"],
  ["FIREMAG3", "FIREMAG1"], ["FIREBLU2", "FIREBLU1"], ["ROCKRED3", "ROCKRED1"],
  ["BFALL4", "BFALL1"], ["SFALL4", "SFALL1"], ["WFALL4", "WFALL1"],
  ["DBRAIN4", "DBRAIN1"],
];
// 이름의 꼬리 숫자를 늘려가며 그룹을 편다. 원본 P_InitPicAnims 가 럼프
// 번호를 세는 것과 같은 방식이다(이름이 연속이라는 전제).
const expandAnim = (name) => {
  for (const [last, first] of ANIMS) {
    if (name !== last && name !== first) continue;
    const stem = first.replace(/(\d+)$/, "");
    const a = parseInt(first.slice(stem.length), 10);
    const c = parseInt(last.slice(stem.length), 10);
    const width = first.length - stem.length;
    const out = [];
    for (let k = a; k <= c; k++) out.push(stem + String(k).padStart(width, "0"));
    return out;
  }
  return null;
};
const applyAnims = (set) => {
  for (const n of [...set]) {
    const g = expandAnim(n);
    if (g) for (const m of g) set.add(m);
  }
};
applyAnims(flatsUsed);
applyAnims(texUsed);

// ── TEXTURE1/2 + PNAMES → patch ──────────────────────────────────────
const pnames = [];
{
  const L = byName.get("PNAMES");
  const b = data(L);
  const n = b.readInt32LE(0);
  for (let i = 0; i < n; i++) pnames.push(nameAt(b, 4 + i * 8));
}
const texDefs = new Map();   // 텍스처이름 → { size, patches:[pnames 인덱스] }
for (const tn of ["TEXTURE1", "TEXTURE2"]) {
  const L = byName.get(tn);
  if (!L) continue;
  const b = data(L);
  const count = b.readInt32LE(0);
  for (let i = 0; i < count; i++) {
    const o = b.readInt32LE(4 + i * 4);
    const name = nameAt(b, o);
    const patchCount = b.readInt16LE(o + 20);
    const patches = [];
    for (let p = 0; p < patchCount; p++) patches.push(b.readInt16LE(o + 22 + p * 10));
    // 정의 자체의 바이트 크기 (프루닝 후 TEXTURE1 을 다시 쓸 때 필요)
    texDefs.set(name, { patches, defBytes: 22 + patchCount * 10 });
  }
}

const patchesUsed = new Set();
const missingTex = [];
for (const t of texUsed) {
  const d = texDefs.get(t);
  if (!d) { missingTex.push(t); continue; }
  for (const pi of d.patches) {
    const pn = pnames[pi];
    if (pn) patchesUsed.add(pn);
  }
}

// ── 집계 ─────────────────────────────────────────────────────────────
const sizeOf = (names) => {
  let total = 0;
  let found = 0;
  const miss = [];
  for (const n of names) {
    const L = byName.get(n);
    if (L) { total += L.size; found++; } else miss.push(n);
  }
  return { total, found, miss };
};

const mapBytes = mapLumps.reduce((s, L) => s + L.size, 0);
const flats = sizeOf(flatsUsed);
const patches = sizeOf(patchesUsed);

// ── 스프라이트 ───────────────────────────────────────────────────────
// 배치된 THINGS 의 doomednum 을 vendor 의 info.c 표에 물려 상태 사슬을
// 따라간다. 표를 손으로 옮겨 적지 않는 이유는 doom-info.cjs 머리말 참조.
const { spritesForThings } = require("./doom-info.cjs");
const spr = spritesForThings([...thingTypes.keys()]);

let spriteBytes = 0;
let spriteCount = 0;
let keepSpriteBytes = 0;
let keepSpriteCount = 0;
{
  const s = lumps.findIndex((L) => /^S[S]?_START$/.test(L.name));
  const e = lumps.findIndex((L) => /^S[S]?_END$/.test(L.name));
  if (s >= 0 && e > s) {
    for (let i = s + 1; i < e; i++) {
      const L = lumps[i];
      spriteBytes += L.size;
      spriteCount++;
      // 럼프 이름은 <4자 스프라이트><프레임><회전>[<프레임><회전>] 이다.
      if (spr.sprites.has(L.name.slice(0, 4))) { keepSpriteBytes += L.size; keepSpriteCount++; }
    }
  }
}

// 반드시 있어야 하는 것
const MUST = ["PLAYPAL", "COLORMAP", "PNAMES", "TEXTURE1"];
const must = sizeOf(MUST);

// ── HUD·메뉴 (엔진이 맵과 무관하게 요구하는 그림) ────────────────────
// 처음에 이걸 빼고 계산했다가 추정이 낙관적으로 나왔다. 맵 의존이 아니라고
// 안 세면 안 된다 — DOOM 은 상태바를 **항상** 그리고, 없으면 W_GetNumForName
// 이 I_Error 로 죽는다.
//
// 세 단계로 나눈다. 어디까지 버릴지가 페이로드를 좌우한다.
const chrome = { need: [], maybe: [], drop: [] };
{
  // 한 판짜리 데모에서 절대 안 쓰는 것들. 에피소드 종료 화면과 도움말이다.
  const DROP = /^(HELP\d?|CREDIT|BOSSBACK|VICTORY2|PFUB\d|ENDPIC|ENDOOM)$/;
  // 판을 끝내야 뜨는 것 — 인터미션 통계 화면.
  const MAYBE = /^(WI|INTERPIC$)/;
  const isChrome = (n) => /^(ST|M_|BRDR|AMMNUM|WI|TITLEPIC$|INTERPIC$|HELP|CREDIT|BOSSBACK|VICTORY2|PFUB|ENDPIC|END$)/.test(n);

  const inSprite = new Set();
  {
    const s = lumps.findIndex((L) => /^S[S]?_START$/.test(L.name));
    const e = lumps.findIndex((L) => /^S[S]?_END$/.test(L.name));
    for (let i = s + 1; i < e; i++) inSprite.add(lumps[i].i);
  }
  for (const L of lumps) {
    if (inSprite.has(L.i) || !isChrome(L.name)) continue;
    if (DROP.test(L.name)) chrome.drop.push(L);
    else if (MAYBE.test(L.name)) chrome.maybe.push(L);
    else chrome.need.push(L);
  }
}
const sum = (a) => a.reduce((s, L) => s + L.size, 0);

const kb = (b) => (b / 1024).toFixed(0).padStart(7) + " KB";
console.log(WAD + "  →  " + MAPNAME.toUpperCase() + " 만 남긴다면");
console.log("");
console.log("맵 지오메트리   " + kb(mapBytes) + "   (" + mapLumps.length + " 럼프)");
console.log("flat            " + kb(flats.total) + "   " + flats.found + " 종 (애니메이션 확장 포함)");
console.log("벽 텍스처 정의  " + flatsUsed.size + " flat / " + texUsed.size + " 텍스처 이름");
console.log("patch           " + kb(patches.total) + "   " + patches.found + " / " + pnames.length + " 개");
console.log("필수 럼프       " + kb(must.total) + "   " + MUST.join(" "));
console.log("HUD·폰트·메뉴   " + kb(sum(chrome.need)) + "   " + chrome.need.length
  + " 럼프  (상태바를 항상 그리므로 필수)");
console.log("인터미션        " + kb(sum(chrome.maybe)) + "   " + chrome.maybe.length
  + " 럼프  (판을 끝내야 뜬다 — 버릴 수 있다)");
console.log("버릴 수 있는 것 " + kb(sum(chrome.drop)) + "   " + chrome.drop.length
  + " 럼프  (도움말·에피소드 종료 화면)");
console.log("─".repeat(52));
const geo = mapBytes + flats.total + patches.total + must.total + sum(chrome.need);
console.log("소계(스프라이트 제외) " + kb(geo));
console.log("");
console.log("스프라이트 전체 " + kb(spriteBytes) + "   " + spriteCount + " 럼프 / "
  + "필요 " + spr.sprites.size + " 종");
console.log("스프라이트 유지 " + kb(keepSpriteBytes) + "   " + keepSpriteCount + " 럼프  ("
  + ((100 * keepSpriteBytes) / spriteBytes).toFixed(0) + "%)");
console.log("─".repeat(52));
console.log("총계            " + kb(geo + keepSpriteBytes)
  + "   ← 프루닝 후 WAD 크기 추정");
// ── 페이로드 환산 ────────────────────────────────────────────────────
// 정찰 결과 DecompressionStream 이 gzip 을 네이티브로 푼다. 그러니 WAD 는
// **압축한 채로** 컴포넌트에 싣고 런타임에 푼다. 페이로드에 실리는 건
// 원본 크기가 아니라 gzip → base64 크기다.
//
// ⚠ 여기서 재는 건 선택된 럼프를 이어붙여 압축한 값이다. 실제 WAD 는
//   헤더·디렉터리가 붙어 조금 커진다. 어림이지 확정이 아니다.
{
  const zlib = require("zlib");
  const picked = [];
  const wanted = new Set([...flatsUsed, ...patchesUsed, ...MUST, ...chrome.need.map((L) => L.name)]);
  for (const L of mapLumps) picked.push(data(L));
  for (const L of lumps) {
    if (wanted.has(L.name)) picked.push(data(L));
  }
  const s = lumps.findIndex((L) => /^S[S]?_START$/.test(L.name));
  const e = lumps.findIndex((L) => /^S[S]?_END$/.test(L.name));
  for (let i = s + 1; i < e; i++) {
    if (spr.sprites.has(lumps[i].name.slice(0, 4))) picked.push(data(lumps[i]));
  }
  const raw = Buffer.concat(picked);
  const gz = zlib.gzipSync(raw, { level: 9 });
  const b64 = Math.ceil(gz.length / 3) * 4;

  // 엔진 wasm 실측치 (doom/build/doom-Oz.wasm, gzip level 9)
  const ENGINE_GZ = 156 * 1024;
  const engineB64 = Math.ceil(ENGINE_GZ / 3) * 4;

  console.log("");
  console.log("페이로드 환산 (gzip → base64, 런타임에 DecompressionStream 으로 푼다)");
  console.log("  WAD     " + kb(raw.length) + " → gzip " + kb(gz.length)
    + " (" + ((100 * gz.length) / raw.length).toFixed(0) + "%) → base64 " + kb(b64));
  console.log("  엔진             " + "→ gzip " + kb(ENGINE_GZ) + "        → base64 " + kb(engineB64));
  console.log("  합계                                     → base64 " + kb(b64 + engineB64)
    + "  = " + ((b64 + engineB64) / 1048576).toFixed(3) + " MiB");
  console.log("");
  console.log("  참고: chess3d 배포본 1.251 MiB 는 성공한다 (간헐적 524 는 재시도).");
  console.log("        3.15 MiB 는 실패했다. 상한이 아니라 확률 곡선이다.");
}

console.log("");
console.log("THINGS " + thingTypes.size + " 종류 배치 · info.c 에서 " + spr.numStates
  + " states / " + spr.numMobj + " mobjinfo 파싱");
if (spr.unknown.length) {
  console.log("⚠ mobjinfo 에 없는 doomednum " + spr.unknown.length + "개: "
    + spr.unknown.slice(0, 10).join(" "));
}

if (missingTex.length) {
  console.log("");
  console.log("⚠ TEXTURE1/2 에 정의가 없는 텍스처 " + missingTex.length + "개: "
    + missingTex.slice(0, 8).join(" ") + (missingTex.length > 8 ? " …" : ""));
}
if (flats.miss.length) {
  console.log("⚠ 럼프가 없는 flat " + flats.miss.length + "개: " + flats.miss.slice(0, 8).join(" "));
}
if (patches.miss.length) {
  console.log("⚠ 럼프가 없는 patch " + patches.miss.length + "개: " + patches.miss.slice(0, 8).join(" "));
}
