// 맵 하나만 남긴 WAD 를 만든다.
//
//   node tools/build-wad.cjs <원본wad> <맵> [출력] [--intermission]
//   예: node tools/build-wad.cjs doom/vendor/freedoom1.wad E1M1 doom/build/doom.wad
//
// 무엇을 남길지는 tools/wad-lib.cjs 가 판정한다 — 보고 도구(wad-deps)와
// **같은 판단**을 써야 "재 볼 때는 되는데 만들면 죽는" 사태가 안 난다.
//
// ── TEXTURE1 을 다시 쓴다 ────────────────────────────────────────────
// 럼프만 골라 담으면 안 된다. TEXTURE1 에 남아 있는 텍스처가 참조하는 patch 가
// 하나라도 빠지면 R_InitTextures 가 **초기화 때 죽는다**(r_data.c:591).
// 그래서 남길 텍스처만으로 TEXTURE1 을 새로 조립한다.
//
// PNAMES 는 건드리지 않는다(8 KB). 깎으면 patch 인덱스를 전부 다시 매겨야
// 하는데, 아낄 게 없는 곳에서 틀릴 자리만 늘리는 일이다.
const fs = require("fs");
const path = require("path");
const { parseWad, analyze, MAP_LUMPS } = require("./wad-lib.cjs");
const { parseSprNames, spriteMaxFrames } = require("./doom-info.cjs");

// ── 빠진 스프라이트용 1×1 투명 더미 ──────────────────────────────────
// **이게 없으면 실기에서 트랩이 난다.** 우리 의존 추적은 맵에 배치된
// THINGS 만 따라가는데, DOOM 은 코드로도 스폰한다 — 좀비가 죽으며 떨구는
// 탄창, 무기가 쏘는 로켓, 각종 이펙트. 그 스프라이트가 없으면
// sprites[n].numframes 가 0 이고 R_ProjectSprite 가 NULL 인 spriteframes 를
// 역참조한다.
//
// 전부 열거하려 들면 반드시 빠뜨린다. 그러니 **빠진 이름마다 더미를 넣어**
// 원리적으로 막는다. 안 보일 뿐 안 죽는다.
//
// patch_t: width(2) height(2) leftoffset(2) topoffset(2) columnofs[width](4)
//          그다음 컬럼 데이터. 첫 바이트가 0xFF 면 "포스트 없음" = 완전 투명이다
//          (R_DrawMaskedColumn 의 `while (column->topdelta != 0xff)` 가 즉시 끝난다).
const DUMMY_PATCH = (() => {
  const b = Buffer.alloc(13);
  b.writeInt16LE(1, 0);      // width
  b.writeInt16LE(1, 2);      // height
  b.writeInt16LE(0, 4);      // leftoffset
  b.writeInt16LE(0, 6);      // topoffset
  b.writeInt32LE(12, 8);     // columnofs[0] → 아래 0xFF
  b.writeUInt8(0xff, 12);    // 빈 컬럼
  return b;
})();

const argv = process.argv.slice(2);
const KEEP_INTER = argv.includes("--intermission");
const WHOLE = argv.includes("--whole");
const WITH_SOUND = argv.includes("--sound");
const pos = argv.filter((a) => a.indexOf("--") !== 0);
const [SRC, MAP_ARG, OUT_ARG] = pos;
if (!SRC || !MAP_ARG) {
  console.error("사용: node tools/build-wad.cjs <원본wad> <맵> [출력] [--whole|--sound]");
  console.error("  맵은 하나(E1M1), 쉼표 목록(E1M1,E1M2), 또는 에피소드 전체(E1)");
  process.exit(1);
}

// 맵 지정을 풀어낸다.
//   E1M1          한 판
//   E1M1,E1M4     고른 판들
//   E1            에피소드 전체 (E1M1..E1M9)
// 여러 판을 담아도 두 배가 되지 않는다 — 텍스처와 스프라이트를 공유하므로
// 늘어나는 건 대체로 맵 지오메트리와 곡 정도다.
const MAPS = MAP_ARG.toUpperCase().split(",").reduce((acc, tok) => {
  const ep = tok.match(/^E([1-4])$/);
  if (ep) { for (let i = 1; i <= 9; i++) acc.push("E" + ep[1] + "M" + i); }
  else acc.push(tok);
  return acc;
}, []);
const MAP = MAPS[0];
const OUT = OUT_ARG || path.join(__dirname, "..", "doom", "build", "doom.wad");

// ── 라이선스 가드 ────────────────────────────────────────────────────
// **셰어웨어 doom1.wad 는 "완전하고 변형되지 않은" 재배포만 허용한다.**
// 맵 하나만 남기는 건 명백한 변형이다. 그래서 프루닝을 아예 막는다 —
// 주석으로만 적어두면 언젠가 무심코 어긴다.
//
// Freedoom 은 BSD 라 자유롭게 깎아도 된다. 그래서 해시로 가른다.
const srcBytes = fs.readFileSync(SRC);
const SHAREWARE_MD5 = "f0cefca49926d00903cf57551d901abe";   // doom1.wad v1.9
const srcMd5 = require("crypto").createHash("md5").update(srcBytes).digest("hex");
if (srcMd5 === SHAREWARE_MD5 && !WHOLE) {
  console.error("셰어웨어 doom1.wad 는 **변형 없이 통째로만** 재배포할 수 있다.");
  console.error("맵 하나만 남기는 건 그 조건을 벗어난다. --whole 로 그대로 실어라:");
  console.error("  node tools/build-wad.cjs " + SRC + " E1M1 " + OUT + " --whole");
  process.exit(1);
}

// ── --whole: 손대지 않고 그대로 옮긴다 ───────────────────────────────
if (WHOLE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, srcBytes);
  const gzW = require("zlib").gzipSync(srcBytes, { level: 9 });
  const kbW = (b) => (b / 1024).toFixed(0).padStart(6) + " KB";
  console.log(path.basename(SRC) + "  →  " + OUT + "   (변형 없음)");
  console.log("");
  console.log("  md5       " + srcMd5 + (srcMd5 === SHAREWARE_MD5 ? "  (셰어웨어 v1.9 정본)" : ""));
  console.log("  크기      " + kbW(srcBytes.length));
  console.log("  gzip      " + kbW(gzW.length) + "  → base64 "
    + kbW(Math.ceil(gzW.length / 3) * 4) + "  ("
    + ((100 * gzW.length) / srcBytes.length).toFixed(0) + "%)");
  console.log("");
  console.log("  프루닝하지 않았다 — 맵 9개·음악·효과음이 전부 들어 있다.");
  process.exit(0);
}

let demoReport = null;
const wad = parseWad(SRC);
const A = analyze(wad, MAPS, { keepIntermission: KEEP_INTER, sound: WITH_SOUND });

// ── 새 TEXTURE1 조립 ─────────────────────────────────────────────────
// 포맷: numtextures(i32) · offsets[n](i32) · maptexture_t 들
function buildTexture1(keep) {
  // ⚠ **원본 순서를 지켜야 한다.** P_InitPicAnims 는 애니메이션 프레임이
  //   텍스처 번호로 이어져 있다고 전제하고 numpics = 끝 - 시작 + 1 로 센다.
  //   Set 순서로 쓰면 그 전제가 깨져 numpics 가 음수가 되고 I_Error 다.
  //   texDefs 는 TEXTURE1 → TEXTURE2 순으로 채워졌으므로 키 순서가 원본 순서다.
  const defs = [...A.texDefs.keys()].filter((n) => keep.has(n))
    .map((n) => A.texDefs.get(n));
  const header = 4 + defs.length * 4;
  let ofs = header;
  const offsets = [];
  for (const d of defs) { offsets.push(ofs); ofs += d.raw.length; }
  const out = Buffer.alloc(ofs);
  out.writeInt32LE(defs.length, 0);
  for (let i = 0; i < defs.length; i++) out.writeInt32LE(offsets[i], 4 + i * 4);
  for (let i = 0; i < defs.length; i++) defs[i].raw.copy(out, offsets[i]);
  return out;
}
const newTexture1 = buildTexture1(A.keepTex);

// ── 남길 럼프를 원본 순서대로 고른다 ─────────────────────────────────
// 순서를 지켜야 하는 이유가 둘이다:
//   · 맵 럼프는 맵 이름 럼프 **바로 뒤에** 정해진 순서로 와야 한다.
//   · flat/patch/sprite 는 마커(F_START…F_END) **안쪽에** 있어야 그 종류가 된다.
const keepNames = new Set([
  ...A.must,
  ...A.flatsUsed,
  ...A.patchesUsed,
  ...A.chromeKeep,
  ...A.music,
  ...A.sounds,
]);
const mapLumpSet = new Set(A.mapLumps.map((L) => L.i));

// ── 채워야 할 스프라이트 프레임 ──────────────────────────────────────
// **(스프라이트, 프레임) 쌍 단위로 본다.** 처음에는 "통째로 없는 스프라이트"만
// 채웠는데, 그것만으로는 부족했다. 두 종류의 구멍이 있다:
//
//   1. 통째로 없는 것 — 코드로만 스폰되는 오브젝트(임프 불덩이 BAL1,
//      좀비가 떨구는 탄창, 로켓·플라즈마). 맵에 배치된 적이 없어
//      의존 추적에서 빠진다.
//   2. **남긴 스프라이트의 프레임 구멍** — 원본 WAD 자체에 없는 프레임이다.
//      freedoom1.wad 의 SHTG 는 A~D 뿐인데 info.c 는 E 를 참조하고,
//      SHT2(슈퍼샷건)는 1편이라 아예 없다.
//
// 둘 다 결과가 같다: R_ProjectSprite 가 RANGECHECK 로 `frame >= numframes` 를
// 잡아 I_Error 를 내고, 그 I_Error 가 종료 함수를 함수 포인터로 부르다
// 트랩이 난다. 실기에서는 원인 대신 "function signature mismatch" 만 보였다.
//
// R_InitSpriteDefs 는 0..max 사이 구멍도 I_Error 이므로 빠짐없이 채운다.
const maxFrames = spriteMaxFrames();

// 유지할 스프라이트 럼프에서 (스프라이트, 프레임) 존재 집합을 만든다.
const havePair = new Set();
{
  const [ss, se] = A.zones.sprite;
  for (let i = ss + 1; i < se; i++) {
    const n = wad.lumps[i].name.toUpperCase();
    if (!A.sprites.has(n.slice(0, 4))) continue;   // 어차피 안 싣는다
    havePair.add(n.slice(0, 4) + n[4]);
    // 8자 표기는 한 럼프가 두 프레임을 겸한다(<이름><F><R><F2><R2>).
    if (n.length === 8) havePair.add(n.slice(0, 4) + n[6]);
  }
}

const dummyFrames = [];
for (const nm of parseSprNames()) {
  const last = maxFrames.has(nm) ? maxFrames.get(nm) : 0;
  for (let f = 0; f <= last; f++) {
    const letter = String.fromCharCode(65 + f);
    if (!havePair.has(nm + letter)) dummyFrames.push(nm + letter + "0");
  }
}

const picked = [];
for (const L of wad.lumps) {
  const n = L.name;

  // 마커는 그대로 남긴다(0바이트). 안쪽이 비어도 두는 게 안전하다 —
  // W_InitMultipleFiles 가 마커 쌍을 전제한다.
  if (/^(S[S]?|F[F]?\d?|P[P]?\d?)_(START|END)$/.test(n)) {
    // 스프라이트 구역이 닫히기 **직전에** 더미를 넣는다. 마커 바깥에 두면
    // 스프라이트로 인식되지 않아 아무 소용이 없다.
    if (/^S[S]?_END$/.test(n)) {
      // 회전 0 하나면 R_InitSpriteDefs 가 "첫 회전만 필요"로 보고
      // 통과시킨다(rotate = false).
      for (const nm of dummyFrames) picked.push({ name: nm, replace: DUMMY_PATCH });
    }
    picked.push({ L, name: n });
    continue;
  }

  if (mapLumpSet.has(L.i)) { picked.push({ L, name: n }); continue; }

  // 다른 맵의 럼프는 전부 버린다.
  if (/^E\dM\d$/.test(n) || /^MAP\d\d$/.test(n)) continue;
  if (MAP_LUMPS.indexOf(n) >= 0) continue;

  if (n === "TEXTURE1") { picked.push({ L, name: n, replace: newTexture1 }); continue; }
  if (n === "TEXTURE2") continue;   // 남길 텍스처는 전부 TEXTURE1 로 합쳤다

  // 스프라이트 구역: 4자 접두어가 필요한 목록에 있으면 남긴다.
  const [ss, se] = A.zones.sprite;
  if (ss >= 0 && L.i > ss && L.i < se) {
    if (A.sprites.has(n.slice(0, 4))) picked.push({ L, name: n });
    continue;
  }
  if (keepNames.has(n)) picked.push({ L, name: n });
}

// ── 데모(어트랙트 루프) ──────────────────────────────────────────────
//
// 타이틀 화면에 가만히 두면 DOOM 은 DEMO1 → 크레딧 → DEMO2 → … 를 재생한다.
// 그런데 **데모는 자기가 어느 맵인지 헤더에 적어두고 그 맵을 요구한다.**
// Freedoom Phase 1 의 데모는 E1M6 · E2M4 · E3M9 · E4M6 를 가리키는데
// 우리는 에피소드 1 만 싣는다. 그대로 두면 타이틀에서 몇 초 기다린 것만으로
// "W_GetNumForName: E2M4 not found!" 로 죽는다 — 가만히 있다가 죽는 셈이라
// 제일 나쁜 종류의 버그다.
//
// 그래서 **싣는 맵을 가리키는 데모로 바꿔친다.** 쓸 수 있는 데모가 하나라도
// 있으면 그것을 복제하고(어트랙트 루프가 실제로 돌아간다), 하나도 없으면
// 즉시 끝나는 14바이트짜리를 넣는다(루프가 다음 화면으로 넘어가기만 한다).
//
// 헤더(v1.9): version skill episode map deathmatch respawn fast nomonsters
//             consoleplayer  +  playeringame[4]   = 13바이트, 그다음 틱 데이터.
//             0x80(DEMOMARKER) 이 끝이다.
{
  const shipped = new Set(A.maps);
  const demoMap = (b) => "E" + b[2] + "M" + b[3];

  // 그대로 쓸 수 있는 데모 하나를 고른다.
  let donor = null;
  for (const L of A.demoLumps) {
    if (shipped.has(demoMap(wad.data(L)))) { donor = wad.data(L); break; }
  }

  const stub = (() => {
    const m = A.maps[0].match(/^E(\d)M(\d)$/);
    const b = Buffer.alloc(14);
    b[0] = 109;                       // 버전 1.9
    b[1] = 2;                         // 스킬
    b[2] = m ? Number(m[1]) : 1;
    b[3] = m ? Number(m[2]) : 1;
    b[8] = 0;                         // consoleplayer
    b[9] = 1;                         // playeringame[0]
    b[13] = 0x80;                     // 즉시 종료
    return b;
  })();

  let kept = 0;
  let swapped = 0;
  for (const L of A.demoLumps) {
    const own = wad.data(L);
    if (shipped.has(demoMap(own))) { picked.push({ L, name: L.name }); kept++; continue; }
    picked.push({ L, name: L.name, replace: donor || stub });
    swapped++;
  }
  demoReport = { kept, swapped, donor: !!donor };
}

// ── 쓰기 ─────────────────────────────────────────────────────────────
// 헤더 12B · 럼프 데이터 · 디렉터리(16B × n)
const bodies = picked.map((p) => (p.replace ? p.replace : wad.data(p.L)));
const bodyLen = bodies.reduce((s, b) => s + b.length, 0);
const out = Buffer.alloc(12 + bodyLen + picked.length * 16);

out.write("IWAD", 0, "ascii");
out.writeInt32LE(picked.length, 4);
out.writeInt32LE(12 + bodyLen, 8);

let p = 12;
const dirStart = 12 + bodyLen;
for (let i = 0; i < picked.length; i++) {
  const b = bodies[i];
  b.copy(out, p);
  const d = dirStart + i * 16;
  out.writeInt32LE(b.length ? p : 0, d);      // 0바이트 마커는 위치 0 이 관례다
  out.writeInt32LE(b.length, d + 4);
  out.write(picked[i].name.padEnd(8, "\0").slice(0, 8), d + 8, "ascii");
  p += b.length;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);

// ── 보고 ─────────────────────────────────────────────────────────────
const zlib = require("zlib");
const gz = zlib.gzipSync(out, { level: 9 });
const b64 = Math.ceil(gz.length / 3) * 4;
const kb = (b) => (b / 1024).toFixed(0).padStart(6) + " KB";

console.log(path.basename(SRC) + " (" + kb(wad.buf.length) + ")  →  " + OUT);
console.log("");
console.log("  럼프      " + wad.lumps.length + " → " + picked.length);
console.log("  텍스처    " + A.texDefs.size + " → " + A.keepTex.size + " (TEXTURE1 재작성)");
console.log("  스프라이트 " + A.sprites.size + " 종  + 더미 " + dummyFrames.length
  + " 장 (코드 스폰 · 원본 결손 프레임 대비)");
console.log("  크기      " + kb(wad.buf.length) + " → " + kb(out.length)
  + "  (" + ((100 * out.length) / wad.buf.length).toFixed(1) + "%)");
console.log("  gzip      " + kb(gz.length) + "  → base64 " + kb(b64));
console.log("  효과음    " + (WITH_SOUND ? A.sounds.size + "개 포함" : "제외 (--sound 로 포함)"));
console.log("  맵        " + A.maps.length + "개  " + A.maps.join(" "));
console.log("  프런트엔드 타이틀 · 메뉴 · 인터미션 · 피날레 포함");
if (demoReport) {
  console.log("  데모      " + demoReport.kept + "개 그대로 · " + demoReport.swapped
    + "개 교체 (" + (demoReport.donor ? "싣는 맵의 데모로 복제" : "즉시 끝나는 더미") + ")");
}

if (A.missingTex.length) {
  console.log("");
  console.log("⚠ 맵이 쓰는데 TEXTURE1/2 에 정의가 없는 텍스처 " + A.missingTex.length + "개:");
  console.log("  " + A.missingTex.slice(0, 10).join(" "));
  console.log("  → R_TextureNumForName 이 죽는다. 원본 WAD 문제다.");
}
if (A.droppedForMissingPatch.length) {
  console.log("");
  console.log("⚠ patch 가 없어 뺀 텍스처 " + A.droppedForMissingPatch.length + "개: "
    + A.droppedForMissingPatch.slice(0, 6).join(" "));
}
