// WAD 파싱 + "이 맵만 남기려면 무엇이 필요한가" 분석.
//
// wad-deps.cjs(보고)와 build-wad.cjs(생성)가 **같은 판단을 쓰게** 하려고
// 분리했다. 둘이 각자 계산하면 "재 볼 때는 되는데 만들면 죽는" 사태가 난다.
//
// ── 엔진이 강제하는 규칙 (전부 vendor 소스에서 확인한 것이다) ────────
//   · R_InitTextures  : TEXTURE1 의 텍스처가 참조하는 patch 가 하나라도 없으면
//                       **초기화 때 I_Error** (r_data.c:591). 그래서 TEXTURE1 도
//                       같이 깎아야 한다.
//   · R_InitSpriteDefs: 스프라이트가 **아예 없으면 조용히 넘어가고**
//                       (r_things.c:233) 일부만 있으면 I_Error 다. 즉
//                       **통째로 빼거나 통째로 남기거나**.
//   · P_InitPicAnims  : 애니메이션 그룹은 중간 프레임이 다 있어야 한다.
//   · R_FlatNumForName / R_TextureNumForName : 맵이 쓰는 이름이 없으면 I_Error.
const fs = require("fs");

const MAP_LUMPS = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS",
  "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP"];

// 애니메이션·스위치 표는 vendor 소스에서 읽는다 — 손으로 옮겨 적으면
// 원본과 어긋나는 순간 조용히 틀린다(doom-info.cjs 참조).
const { parseAnimDefs, parseSwitches } = require("./doom-info.cjs");

function parseWad(file) {
  const buf = fs.readFileSync(file);
  const magic = buf.toString("ascii", 0, 4);
  if (magic !== "IWAD" && magic !== "PWAD") throw new Error("WAD 가 아니다: " + magic);
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
  return { buf, magic, lumps, byName, data };
}

const nameAt = (b, o) => b.toString("ascii", o, o + 8).replace(/\0.*$/, "").toUpperCase();

const isMarker = (n) => /^(S[S]?|F[F]?\d?|P[P]?\d?)_(START|END)$/.test(n);

function zoneRanges(lumps) {
  // 마커 사이가 어떤 종류인지. 이름 규칙이 아니라 **위치**가 종류를 정한다.
  const find = (re) => lumps.findIndex((L) => re.test(L.name));
  return {
    sprite: [find(/^S[S]?_START$/), find(/^S[S]?_END$/)],
    flat: [find(/^F[F]?_START$/), find(/^F[F]?_END$/)],
    patch: [find(/^P[P]?_START$/), find(/^P[P]?_END$/)],
  };
}

const ANIM_PAIRS = parseAnimDefs().map((d) => [d.end, d.start]);
function expandAnim(name) {
  for (const [last, first] of ANIM_PAIRS) {
    if (name !== last && name !== first) continue;
    const stem = first.replace(/(\d+)$/, "");
    const a = parseInt(first.slice(stem.length), 10);
    const c = parseInt(last.slice(stem.length), 10);
    if (!(c >= a)) return null;          // FIREWALA 처럼 숫자가 아닌 것
    const width = first.length - stem.length;
    const out = [];
    for (let k = a; k <= c; k++) out.push(stem + String(k).padStart(width, "0"));
    return out;
  }
  return null;
}

// ── HUD·메뉴 분류 ────────────────────────────────────────────────────
// 맵과 무관하게 엔진이 그리는 그림들. 처음에 이걸 빼고 계산했다가 추정이
// 낙관적으로 나왔다 — DOOM 은 상태바를 **항상** 그린다.
// ── 프런트엔드(타이틀·메뉴·인터미션·피날레) ─────────────────────────
//
// **이 목록은 `-warp` 를 쓰던 시절에 짜였다.** 그때는 부팅하자마자 맵에
// 떨어졌으니 타이틀도 데모도 인터미션도 필요 없었다. 지금은 타이틀 화면부터
// 시작하고 맵을 끝내면 인터미션을 지나 피날레까지 간다. 그래서 여기서
// 버리면 **그 화면에 닿는 순간 I_Error 로 죽는다.**
//
// 그래서 방침을 뒤집었다: CHROME_ANY 에 걸리는 건 전부 남긴다.
// 데모만 예외인데, 그건 아래에서 따로 다룬다(참조하는 맵이 있어야 한다).
const CHROME_ANY = /^(ST|M_|BRDR|AMMNUM|WI|TITLEPIC$|INTERPIC$|HELP|CREDIT|BOSSBACK|VICTORY2|PFUB|ENDPIC|END$|DEMO\d)/;
const CHROME_DEMO = /^DEMO\d$/;

/**
 * 맵 하나를 남길 때 필요한 럼프를 판정한다.
 * @param {object} wad parseWad 결과
 * @param {string} mapName 예 "E1M1"
 * @param {object} opts { keepIntermission: boolean }
 */
/**
 * @param {string|string[]} mapNames  맵 하나 또는 여러 개. 여러 개를 주면
 *   에셋 의존을 **합집합**으로 모은다 — 맵끼리 텍스처·스프라이트를 많이
 *   공유하므로 두 판이 두 배가 되지 않는다.
 */
function analyze(wad, mapNames, opts) {
  const options = opts || {};
  const { lumps, byName, data } = wad;
  const MAPS = (Array.isArray(mapNames) ? mapNames : [mapNames]).map((m) => m.toUpperCase());
  const MAP = MAPS[0];

  // 맵마다 이름 럼프 + 뒤따르는 지오메트리 럼프를 모은다.
  const mapLumps = [];
  const perMap = [];
  for (const name of MAPS) {
    const mi = lumps.findIndex((L) => L.name === name);
    if (mi < 0) throw new Error("맵 없음: " + name);
    const own = [lumps[mi]];
    for (let i = mi + 1; i < lumps.length && MAP_LUMPS.indexOf(lumps[i].name) >= 0; i++) {
      own.push(lumps[i]);
    }
    perMap.push({ name, lumps: own });
    for (const L of own) mapLumps.push(L);
  }
  const lumpOf = (own, n) => own.find((L) => L.name === n);

  // SECTORS(26B) → flat / SIDEDEFS(30B) → 텍스처 / THINGS(10B) → 종류
  const flatsUsed = new Set();
  const texUsed = new Set();
  const thingTypes = new Map();

  for (const m of perMap) {
    const sect = lumpOf(m.lumps, "SECTORS");
    if (sect) {
      const b = data(sect);
      for (let o = 0; o + 26 <= b.length; o += 26) {
        flatsUsed.add(nameAt(b, o + 4));
        flatsUsed.add(nameAt(b, o + 12));
      }
    }
    const side = lumpOf(m.lumps, "SIDEDEFS");
    if (side) {
      const b = data(side);
      for (let o = 0; o + 30 <= b.length; o += 30) {
        for (const off of [4, 12, 20]) {
          const t = nameAt(b, o + off);
          if (t && t !== "-") texUsed.add(t);
        }
      }
    }
    const thg = lumpOf(m.lumps, "THINGS");
    if (thg) {
      const b = data(thg);
      for (let o = 0; o + 10 <= b.length; o += 10) {
        const t = b.readInt16LE(o + 6);
        thingTypes.set(t, (thingTypes.get(t) || 0) + 1);
      }
    }
  }

  for (const set of [flatsUsed, texUsed]) {
    for (const n of [...set]) {
      const g = expandAnim(n);
      if (g) for (const m of g) set.add(m);
    }
  }

  // PNAMES 는 **깎지 않는다.** 8 KB 남짓이라 아낄 게 없고, 깎으면 TEXTURE1 의
  // patch 인덱스를 전부 다시 매겨야 해서 틀릴 자리만 늘어난다.
  const pnames = [];
  {
    const b = data(byName.get("PNAMES"));
    const n = b.readInt32LE(0);
    for (let i = 0; i < n; i++) pnames.push(nameAt(b, 4 + i * 8));
  }

  // TEXTURE1/2 의 정의를 모두 읽어둔다. 남길 것만 골라 TEXTURE1 을 다시 쓴다.
  const texDefs = new Map();
  for (const tn of ["TEXTURE1", "TEXTURE2"]) {
    const L = byName.get(tn);
    if (!L) continue;
    const b = data(L);
    const count = b.readInt32LE(0);
    for (let i = 0; i < count; i++) {
      const o = b.readInt32LE(4 + i * 4);
      const name = nameAt(b, o);
      const patchCount = b.readInt16LE(o + 20);
      if (!texDefs.has(name)) texDefs.set(name, { name, raw: b.subarray(o, o + 22 + patchCount * 10), patchCount });
    }
  }

  // 텍스처 0번은 DOOM 이 "텍스처 없음" 자리로 쓰므로 항상 남긴다.
  const firstTexName = (() => {
    const b = data(byName.get("TEXTURE1"));
    return nameAt(b, b.readInt32LE(4));
  })();

  const keepTex = new Set([firstTexName]);
  const missingTex = [];
  for (const t of texUsed) {
    if (texDefs.has(t)) keepTex.add(t);
    else missingTex.push(t);
  }

  // ⚠ 스위치 텍스처는 **맵이 안 써도** 있어야 한다. P_InitSwitchList 가
  //   게임모드의 스위치를 전부 R_TextureNumForName 으로 찾기 때문이다.
  //   빼먹고 만들었다가 "SW1BRCOM not found" 로 죽었다.
  // 게임모드는 **어떤 맵이 들어 있느냐**로 정해진다(D_IdentifyVersion):
  // E4M1 이 있으면 retail, E2M1 이 있으면 registered, 아니면 shareware.
  // 우리는 E1Mx 하나만 남기므로 shareware → episode 1 이다.
  // (실기 부팅 로그가 "DOOM Shareware" 를 찍어 확인했다.)
  const switchTex = parseSwitches(1);
  for (const t of switchTex) if (texDefs.has(t)) keepTex.add(t);

  // 애니메이션 그룹도 텍스처 쪽으로 편다. 시작이 있으면 끝이 반드시 있어야 한다.
  for (const t of [...keepTex]) {
    const g = expandAnim(t);
    if (g) for (const m of g) if (texDefs.has(m)) keepTex.add(m);
  }

  const patchesUsed = new Set();
  for (const t of keepTex) {
    const d = texDefs.get(t);
    if (!d) continue;
    for (let p = 0; p < d.patchCount; p++) {
      // ⚠ mappatch_t 는 originx(2) originy(2) patch(2) stepdir(2) colormap(2) 다.
      //   patch 인덱스는 +4 지 +0 이 아니다. 여기를 +0 으로 읽었다가
      //   모든 텍스처가 PNAMES[0] 하나만 쓰는 것처럼 보였고, 패치를
      //   29개만 실어 "Missing patch in texture MC5" 로 죽었다.
      const pi = d.raw.readInt16LE(22 + p * 10 + 4);
      if (pnames[pi]) patchesUsed.add(pnames[pi]);
    }
  }
  // ⚠ patch 럼프가 실제로 없으면 그 텍스처를 통째로 빼야 한다 —
  //   남겨두면 R_InitTextures 가 I_Error 로 죽는다(r_data.c:591).
  const droppedForMissingPatch = [];
  for (const t of [...keepTex]) {
    const d = texDefs.get(t);
    if (!d) continue;
    for (let p = 0; p < d.patchCount; p++) {
      const pn = pnames[d.raw.readInt16LE(22 + p * 10 + 4)];
      if (!pn || !byName.has(pn)) {
        keepTex.delete(t);
        droppedForMissingPatch.push(t);
        break;
      }
    }
  }

  // 스프라이트 — vendor 의 info.c 표를 직접 읽어 상태 사슬을 따라간다.
  const { spritesForThings } = require("./doom-info.cjs");
  const spr = spritesForThings([...thingTypes.keys()]);

  // ── 음악 ─────────────────────────────────────────────────────────
  // 사운드는 전부 버렸는데 음악은 **버릴 수 없다.** S_ChangeMusic 이
  // -nomusic 과 무관하게 W_GetNumForName("d_"+이름) 을 부르고, 없으면
  // I_Error 다(s_sound.c). 실제로 "W_GetNumForName: d_e1m1 not found!" 로
  // 죽었다. 재생은 안 되지만 럼프는 있어야 한다.
  //
  // 필요한 것만: 그 맵의 곡 + 인터미션 + 승리 화면.
  // 타이틀 곡(d_intro)은 -warp 로 타이틀을 건너뛰므로 안 쓴다.
  // 타이틀 곡(D_INTRO/D_INTROA)과 피날레 곡(D_BUNNY)도 넣는다 — 타이틀
  // 화면부터 시작하므로 **부팅 직후 바로 필요하다.**
  const music = new Set(MAPS.map((m) => "D_" + m)
    .concat(["D_INTER", "D_VICTOR", "D_INTRO", "D_INTROA", "D_BUNNY"])
    .filter((n) => byName.has(n)));

  // ── 효과음 ───────────────────────────────────────────────────────
  // **전부 넣는다.** 어떤 소리가 울릴지는 맵 배치가 아니라 코드가 정한다 —
  // 무기·문·스위치·픽업·메뉴 소리는 THINGS 에 안 나온다. 스프라이트에서
  // "열거하려 들면 반드시 빠뜨린다"를 이미 겪었고, 효과음은 하나 빠져도
  // I_Error 는 아니지만(W_CheckNumForName 을 쓴다) 조용히 안 울린다.
  // 69개 1.4 MB 인데 페이로드에 4.5 MiB 가 확인됐으므로 아낄 이유가 없다.
  const sounds = new Set();
  if (options.sound) {
    for (const L of lumps) if (/^DS/.test(L.name)) sounds.add(L.name);
  }

  // HUD·메뉴
  const zones = zoneRanges(lumps);
  const inZone = (L) => Object.values(zones).some(([s, e]) => s >= 0 && e > s && L.i > s && L.i < e);
  const chromeKeep = new Set();
  const demoLumps = [];
  for (const L of lumps) {
    if (inZone(L) || !CHROME_ANY.test(L.name)) continue;
    if (CHROME_DEMO.test(L.name)) { demoLumps.push(L); continue; }
    chromeKeep.add(L.name);
  }

  return {
    map: MAP, maps: MAPS, mapLumps, flatsUsed, texUsed, keepTex, patchesUsed,
    thingTypes, sprites: spr.sprites, spriteInfo: spr,
    chromeKeep, music, sounds, pnames, texDefs, zones,
    missingTex, droppedForMissingPatch,
    demoLumps,
    // GENMIDI 는 OPL 악기 정의다. i_oplmusic 이 **I_InitMusic 에서**
    // W_GetNumForName("genmidi") 을 부르므로 없으면 부팅 자체가 죽는다
    // ("W_GetNumForName: genmidi not found!"). 음악을 끄든 말든 있어야 한다.
    must: ["PLAYPAL", "COLORMAP", "PNAMES", "GENMIDI"],
  };
}

module.exports = { parseWad, analyze, nameAt, isMarker, zoneRanges, MAP_LUMPS };
