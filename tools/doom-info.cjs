// vendor 의 info.c / d_items.c 를 파싱해 "이 오브젝트가 쓰는 스프라이트"를 낸다.
//
//   const { spritesForThings } = require('./doom-info.cjs');
//
// ── 왜 파싱하는가 ────────────────────────────────────────────────────
// 맵에 배치된 THINGS 는 doomednum(숫자)일 뿐이다. 그게 어떤 스프라이트를
// 쓰는지는 mobjinfo → 상태들 → states[] → SPR_XXX 사슬을 따라가야 안다.
// 표를 손으로 옮겨 적으면 원본과 어긋나는 순간 조용히 틀린다. 그래서
// **vendor 소스를 직접 읽는다** — chess3d 가 로직을 옮겨 적지 않고 컴포넌트를
// 그대로 실행하는 것과 같은 방침이다.
//
// ── 과다 포함은 안전하다 ─────────────────────────────────────────────
// 스프라이트는 **통째로 빼거나 통째로 남기거나**다. 부분만 남기면
// R_InitSpriteDefs 가 I_Error 로 죽고(회전 빠짐/프레임 구멍), 아예 없으면
// 조용히 넘어간다(r_things.c:233 `numframes = 0; continue;`).
// 그래서 애매하면 남긴다 — 몇 KB 를 아끼려다 게임이 안 뜨는 게 나쁘다.
const fs = require("fs");
const path = require("path");

const VENDOR = path.join(__dirname, "..", "doom", "vendor",
  "doomgeneric-master", "doomgeneric");

// ── states[] ─────────────────────────────────────────────────────────
// 한 줄 형식: {SPR_XXX,frame,tics,{action},S_NEXT,misc1,misc2},	// S_NAME
function parseStates() {
  const src = fs.readFileSync(path.join(VENDOR, "info.c"), "utf8");
  const start = src.indexOf("states[NUMSTATES]");
  const body = src.slice(start);
  // 2번째 필드가 frame 이다. 32768|1 처럼 FF_FULLBRIGHT 가 OR 돼 있을 수 있다.
  const re = /\{\s*(SPR_\w+)\s*,\s*([^,]*),\s*([^,]*),\s*\{[^}]*\}\s*,\s*(S_\w+)\s*,[^,]*,[^}]*\}\s*,?\s*\/\/\s*(S_\w+)/g;
  const byName = new Map();   // S_NAME → { sprite, next }
  let m;
  while ((m = re.exec(body))) {
    if (byName.has(m[5])) continue;   // 첫 정의만
    // frame 은 "0" 이거나 "32768|1"(FF_FULLBRIGHT) 형태다. 하위 15비트만 쓴다.
    const f = m[2].split("|").map((t) => parseInt(t.trim(), 10))
      .filter((v) => !isNaN(v)).reduce((a, b) => a | b, 0) & 0x7fff;
    byName.set(m[5], {
      sprite: m[1], next: m[4], frame: f,
      tics: parseInt(m[3].trim(), 10),
    });
  }
  return byName;
}

// ── mobjinfo[] ───────────────────────────────────────────────────────
// 블록 형식: { // MT_XXX  ...  <값>, // <필드명> ... }
const STATE_FIELDS = ["spawnstate", "seestate", "painstate", "meleestate",
  "missilestate", "deathstate", "xdeathstate", "raisestate"];

function parseMobjInfo() {
  const src = fs.readFileSync(path.join(VENDOR, "info.c"), "utf8");
  const start = src.indexOf("mobjinfo[NUMMOBJTYPES]");
  const body = src.slice(start);
  const blocks = body.split(/\{\s*\/\/\s*(MT_\w+)/).slice(1);
  const out = [];
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const name = blocks[i];
    const text = blocks[i + 1];
    const dm = text.match(/(-?\d+)\s*,\s*\/\/\s*doomednum/);
    const doomednum = dm ? parseInt(dm[1], 10) : -1;
    const states = [];
    for (const f of STATE_FIELDS) {
      const fm = text.match(new RegExp("(S_\\w+)\\s*,?\\s*//\\s*" + f));
      if (fm) states.push(fm[1]);
    }
    out.push({ name, doomednum, states });
  }
  return out;
}

// ── 상태 사슬을 따라가며 스프라이트를 모은다 ────────────────────────
// nextstate 를 계속 따라간다. 순환이 흔하므로(대기 상태) 방문 표시를 한다.
function walk(states, from, out, seen) {
  let s = from;
  let guard = 0;
  while (s && s !== "S_NULL" && !seen.has(s) && guard++ < 4096) {
    seen.add(s);
    const st = states.get(s);
    if (!st) break;
    out.add(st.sprite.slice(4));   // SPR_TROO → TROO
    s = st.next;
  }
}

// ── 무기 HUD 스프라이트 ──────────────────────────────────────────────
// 플레이어가 **드는** 무기의 스프라이트는 mobjinfo 가 아니라 weaponinfo
// (d_items.c) 에 있다. 바닥에 놓인 픽업 스프라이트(SHOT)와 손에 든
// 스프라이트(SHTG)가 **다른 럼프**라 둘 다 필요하다.
//
// 전부 포함한다. 맵에 없는 무기라도 치트나 향후 맵 교체로 손에 들어올 수
// 있고, 8종 합쳐도 크지 않다 — 위의 "애매하면 남긴다" 원칙 그대로다.
function weaponSprites(states) {
  const src = fs.readFileSync(path.join(VENDOR, "d_items.c"), "utf8");
  const out = new Set();
  const seen = new Set();
  for (const m of src.matchAll(/S_\w+/g)) walk(states, m[0], out, seen);
  return out;
}

// 항상 필요한 것. 총알 자국·피·텔레포트 연기는 어떤 맵에서도 난다.
const ALWAYS_MT = ["MT_PLAYER", "MT_PUFF", "MT_BLOOD", "MT_TFOG", "MT_IFOG", "MT_TELEPORTMAN"];

function spritesForThings(doomednums) {
  const states = parseStates();
  const mobj = parseMobjInfo();
  const byNum = new Map();
  const byName = new Map();
  for (const m of mobj) {
    byName.set(m.name, m);
    if (m.doomednum > 0) byNum.set(m.doomednum, m);
  }

  const sprites = new Set();
  const seen = new Set();
  const unknown = [];

  const take = (entry) => { for (const s of entry.states) walk(states, s, sprites, seen); };

  for (const n of ALWAYS_MT) { const e = byName.get(n); if (e) take(e); }
  for (const num of doomednums) {
    const e = byNum.get(num);
    if (e) take(e);
    else unknown.push(num);
  }
  for (const s of weaponSprites(states)) sprites.add(s);

  return { sprites, unknown, numStates: states.size, numMobj: mobj.length };
}

// ── 애니메이션 정의 (p_spec.c animdefs) ──────────────────────────────
// {istexture, endname, startname, speed} 순서다. **끝 이름이 먼저** 온다.
//
// P_InitPicAnims 는 시작 이름이 없으면 그 항목을 건너뛰지만, 시작이 있으면
// **끝도 반드시 있어야 하고**(R_TextureNumForName → I_Error), 사이 프레임이
// 번호 순으로 이어져 있어야 한다:
//     numpics = picnum - basepic + 1;  numpics < 2 면 I_Error
// 그래서 그룹을 남길 때는 **원본 순서까지** 지켜야 한다.
function parseAnimDefs() {
  const src = fs.readFileSync(path.join(VENDOR, "p_spec.c"), "utf8");
  const start = src.indexOf("animdefs[]");
  const body = src.slice(start, src.indexOf("};", start));
  const out = [];
  for (const m of body.matchAll(/\{\s*(true|false)\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(\d+)/g)) {
    out.push({ istexture: m[1] === "true", end: m[2], start: m[3] });
  }
  return out;
}

// ── 스위치 텍스처 (p_switch.c alphSwitchList) ────────────────────────
// ⚠ 이걸 빼먹고 만든 WAD 는 "R_TextureNumForName: SW1BRCOM not found" 로
//   죽었다. P_InitSwitchList 가 **맵이 스위치를 쓰든 말든** 해당 에피소드의
//   스위치를 전부 R_TextureNumForName 으로 찾기 때문이다(p_switch.c:138).
//   맵 의존이 아니라 게임모드 의존이다.
//
// episode 판정(p_switch.c:106): shareware=1, registered/retail=2, commercial=3.
// 우리는 WAD 이름을 doom.wad 로 실어 retail 로 인식되므로 2 다.
function parseSwitches(episode) {
  const ep = episode || 2;
  const src = fs.readFileSync(path.join(VENDOR, "p_switch.c"), "utf8");
  const start = src.indexOf("alphSwitchList[]");
  const body = src.slice(start, src.indexOf("};", start));
  const out = [];
  for (const m of body.matchAll(/\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\}/g)) {
    const e = parseInt(m[3], 10);
    if (e === 0) break;          // 0 은 목록 끝 표시다
    if (e <= ep) out.push(m[1], m[2]);
  }
  return out;
}

module.exports = { spritesForThings, parseStates, parseMobjInfo, parseAnimDefs, parseSwitches };

// 직접 실행하면 표가 제대로 읽혔는지 보여준다.
if (require.main === module) {
  const st = parseStates();
  const mo = parseMobjInfo();
  console.log("states  : " + st.size + " 개 파싱");
  console.log("mobjinfo: " + mo.length + " 개 파싱 ("
    + mo.filter((m) => m.doomednum > 0).length + " 개가 맵에 배치 가능)");
  const r = spritesForThings([]);
  console.log("아무것도 배치 안 해도 필요한 스프라이트: " + r.sprites.size + " 종");
  console.log("  " + [...r.sprites].sort().join(" "));
}

// ── sprnames[] (info.c) ──────────────────────────────────────────────
// DOOM 이 아는 스프라이트 이름 전부. 프루닝에서 빠진 것을 알아내는 데 쓴다.
//
// ⚠ 왜 필요한가: 우리 의존 추적은 **맵에 배치된** THINGS 만 따라간다.
//   그런데 DOOM 은 코드로도 오브젝트를 스폰한다 — P_KillMobj 가 좀비에서
//   떨어뜨리는 탄창(MT_CLIP), 무기가 쏘는 로켓·플라즈마, 각종 이펙트.
//   그것들 스프라이트가 없으면 sprites[n].numframes 가 0 이고
//   R_ProjectSprite 가 NULL 인 spriteframes 를 역참조한다 → 실기에서 트랩.
//
//   전부 열거하려 들면 반드시 빠뜨린다. 그래서 **빠진 이름마다 1×1 투명
//   더미를 넣어** 원리적으로 막는다. 더미 하나가 13바이트라 전체가 몇 KB다.
function parseSprNames() {
  const src = fs.readFileSync(path.join(VENDOR, "info.c"), "utf8");
  const start = src.indexOf("sprnames[");
  const body = src.slice(start, src.indexOf("};", start));
  const out = [];
  for (const m of body.matchAll(/"([A-Z0-9]{4})"/g)) out.push(m[1]);
  return out;
}

module.exports.parseSprNames = parseSprNames;

// ── 스프라이트별 최대 프레임 번호 ────────────────────────────────────
// **더미 스프라이트를 몇 장 넣어야 하는지 정하는 값이다.**
//
// R_ProjectSprite 는 RANGECHECK 로 `frame >= numframes` 를 검사하고 걸리면
// I_Error 다(r_things.c). 그래서 빠진 스프라이트에 프레임 A 한 장만 넣으면,
// 그 오브젝트가 프레임 B 로 넘어가는 순간 죽는다. 실기에서 정확히 그렇게 났다:
//     R_ProjectSprite: invalid sprite frame 18 : 32769
//     (32769 = FF_FULLBRIGHT|1 → 프레임 B 가 필요했다)
//
// 게다가 R_InitSpriteDefs 는 0..max 사이에 **구멍이 있으면** 또 I_Error 다.
// 그러니 0 부터 max 까지 빠짐없이 채워야 한다.
function spriteMaxFrames() {
  const states = parseStates();
  const max = new Map();   // 스프라이트 이름 → 최대 프레임 번호
  for (const st of states.values()) {
    // ⚠ tics 가 0 인 상태는 **화면에 머물지 않는다.** P_SetMobjState /
    //   P_SetPsprite 의 `do { ... } while (!tics)` 가 즉시 다음 상태로
    //   넘기기 때문이다. 그래서 그 프레임은 그려질 일이 없고, 있어야 할
    //   이유도 없다.
    //
    //   이걸 안 빼면 오탐이 난다: S_LIGHTDONE 이 SPR_SHTG 프레임 E 를
    //   들고 있는데(A_Light0 용 껍데기다) **셰어웨어 doom1.wad 정품에도
    //   SHTGE0 이 없다.** 바닐라 DOOM 이 30년간 그대로 배포됐다는 게
    //   그려지지 않는다는 증거다.
    if (st.tics === 0) continue;
    const n = st.sprite.slice(4);
    const cur = max.has(n) ? max.get(n) : -1;
    if (st.frame > cur) max.set(n, st.frame);
  }
  return max;
}
module.exports.spriteMaxFrames = spriteMaxFrames;
