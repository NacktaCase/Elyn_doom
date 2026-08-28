// doomgeneric 을 wasm32-wasip1 로 빌드한다.
//
//   node tools/build-doom-wasm.cjs [--O2]
//
// ── 왜 Emscripten 이 아닌가 ──────────────────────────────────────────
// 이유가 둘이고 두 번째가 결정적이다:
//   1. Elyn 컴포넌트는 function 하나에 다 들어가야 해서 glue 모듈을 import
//      할 수 없다.
//   2. **Elyn 은 소스를 정적 스캔해 등록을 막는다.** Emscripten glue 에는
//      네트워크·URL·파일 계열 이름이 수십 개 박혀 있어 그대로는 등록조차
//      안 될 공산이 크다. glue 가 없으면 걸릴 이름이 애초에 안 생긴다.
//
// ── vendor 를 고치지 않는다 ─────────────────────────────────────────
// 우리 코드는 doom/src/ 넷뿐이고, 그중 둘은 vendor 파일을 **대체**한다:
//   doomgeneric_wasm.c  ← 플랫폼 6함수 (doomgeneric_*.c 자리)
//   w_file_memory.c     ← w_file_stdc.c 대체 (WAD 를 메모리에서 읽는다)
//   i_sound_wasm.c      ← i_sound.c 대체 (SDL 없이, JS 가 재생)
// vendor 트리는 한 줄도 안 고친다.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "doom", "vendor", "doomgeneric-master", "doomgeneric");
const SRC = path.join(ROOT, "doom", "src");
const OPL = path.join(ROOT, "doom", "vendor", "opl");
const BUILD = path.join(ROOT, "doom", "build");

const WASI_SDK = process.env.WASI_SDK
  || path.join(process.env.USERPROFILE || process.env.HOME || "", "wasi-sdk-34.0-x86_64-windows");
const CLANG = path.join(WASI_SDK, "bin", "clang" + (process.platform === "win32" ? ".exe" : ""));

if (!fs.existsSync(CLANG)) {
  console.error("wasi-sdk 를 못 찾았다: " + CLANG);
  console.error("WASI_SDK 환경변수로 경로를 줄 수 있다.");
  process.exit(1);
}

// -Oz 가 기본이다. -O2 는 735 KB, -Oz 는 422 KB 인데 DOOM 은 1993년 게임이라
// 속도가 남아돈다 — 쉬지 않고 돌려 14.3ms/틱(≈70 tic/s)이고 필요한 건 35 다.
// 35Hz 로 맞춰 부르면 틱당 0.39ms 로 떨어진다(doom-bench.cjs, 2026-08-28).
// 페이로드가 리비전 전체에 걸리므로 313 KB 차이는 그냥 못 낸다.
const OPT = process.argv.includes("--O2") ? "-O2" : "-Oz";

// vendor 에서 가져올 것. Makefile.emscripten 의 목록에서 SDL·플랫폼 종속을
// 뺀 것이다. **우리가 대체하는 파일은 여기 없다.**
const VENDOR_SRC = `dummy am_map doomdef doomstat dstrings d_event d_items d_iwad
d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus
i_endoom i_joystick i_scale i_system i_timer memio m_argv m_bbox m_cheat
m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy
p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup
p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main
r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound
tables v_video wi_stuff w_checksum w_file w_main w_wad z_zone i_input i_video
doomgeneric mus2mid`.split(/\s+/).filter(Boolean);

// 우리 것. 이름이 vendor 와 겹치는 것은 **대체**다.
const OUR_SRC = ["doomgeneric_wasm", "w_file_memory", "i_sound_wasm", "opl_wasm"];

// chocolate-doom 에서 따로 들여온 OPL 음악 부분. doomgeneric 이 들어낸 것들이다.
//   opl3.c       Nuked OPL3 에뮬레이터 (소리를 실제로 만드는 곳)
//   opl_queue.c  콜백 큐
//   i_oplmusic.c MUS/MIDI → OPL 레지스터, GENMIDI 악기 해석
//   midifile.c   i_oplmusic 이 요구한다 (doomgeneric 엔 mus2mid 만 있다)
// opl.c 와 opl_sdl.c 는 **안 쓴다** — doom/src/opl_wasm.c 가 대체한다(그 파일 머리말).
const OPL_SRC = ["opl3", "opl_queue", "midifile", "i_oplmusic"];

fs.mkdirSync(BUILD, { recursive: true });

// ⚠ 프레임버퍼를 **320×200 원본 해상도**로 둔다. 기본값 640×400 이면
// DOOM 이 내부에서 2배 확대(I_InitGraphics 의 "Auto-scaling factor: 2")를
// 하고, 우리는 그 25만 픽셀을 매 프레임 JS 로 복사한다. 캔버스는 어차피
// CSS 로 확대되므로(image-rendering: pixelated) **그 확대는 순수한 낭비다.**
// 320×200 이면 픽셀이 1/4 이라 확대 비용과 복사 비용이 함께 사라진다.
// 화면은 같거나 더 또렷하다.
const RES = ["-DDOOMGENERIC_RESX=320", "-DDOOMGENERIC_RESY=200"];
const CFLAGS = ["-c", OPT, "-DNORMALUNIX"].concat(RES).concat(["-I" + VENDOR, "-I" + OPL]);
let fails = 0;
const objs = [];

// chocolate-doom 쪽 파일에만 어댑터 헤더를 강제로 끼운다. doomgeneric 쪽에는
// 안 끼운다 — 거기서는 이름을 바꿀 이유가 없다(doom/src/opl_compat.h 머리말).
// ⚠ `-I OPL` 이 **앞에** 와야 한다. chocolate 의 i_sound.h 를 먼저 보게 해서
//   music_opl_module 의 const 충돌과 opl_driver_ver_t 누락을 한 번에 푼다
//   (doom/src/opl_compat.h 2절에 근거가 있다).
const COMPAT = ["-I" + OPL, "-include", path.join(SRC, "opl_compat.h")];

const compile = (name, dir, extra) => {
  const out = path.join(BUILD, name + ".o");
  try {
    execFileSync(CLANG, CFLAGS.concat(extra || []).concat(["-o", out, path.join(dir, name + ".c")]),
      { stdio: ["ignore", "pipe", "pipe"] });
    objs.push(out);
  } catch (e) {
    fails++;
    console.log("  ✗ " + name + ".c");
    const msg = (e.stderr || Buffer.from("")).toString();
    for (const l of msg.split("\n").filter((l) => /error:/.test(l)).slice(0, 3)) {
      console.log("      " + l.trim());
    }
  }
};

console.log("컴파일 " + (VENDOR_SRC.length + OPL_SRC.length + OUR_SRC.length) + "개  (" + OPT + ")");
// d_main.c 만 특별 취급한다. 이유는 doom/src/doomgeneric_wasm.c 의
// DoomWasm_CheckDemoStatus 주석 참조 — vendor 의 잘못된 함수 포인터 캐스팅이
// wasm 에서 트랩을 만든다.
const DMAIN_FIX = ["-DG_CheckDemoStatus=DoomWasm_CheckDemoStatus"];
for (const n of VENDOR_SRC) compile(n, VENDOR, n === "d_main" ? DMAIN_FIX : null);
for (const n of OPL_SRC) compile(n, OPL, COMPAT);
for (const n of OUR_SRC) compile(n, SRC);
if (fails) { console.error("\n" + fails + "개 실패."); process.exit(1); }

// 오래된 .o 가 남아 있으면 대체한 파일이 되살아나 심볼이 중복된다.
// (i_sound.o 를 지우지 않으면 i_sound_wasm.o 와 충돌한다.)
for (const f of fs.readdirSync(BUILD)) {
  if (!f.endsWith(".o")) continue;
  const full = path.join(BUILD, f);
  if (objs.indexOf(full) < 0) { fs.unlinkSync(full); console.log("  (오래된 " + f + " 제거)"); }
}

const OUT = path.join(BUILD, "doom-Oz.wasm");
console.log("링크 → " + path.basename(OUT));
try {
  execFileSync(CLANG, [OPT, "-Wl,--no-entry", "-Wl,--export-dynamic", "-Wl,--strip-all",
    "-mexec-model=reactor", "-o", OUT].concat(objs).concat(["-lm"]),
    { stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  console.error((e.stderr || Buffer.from("")).toString().split("\n").slice(0, 12).join("\n"));
  process.exit(1);
}

const wasm = fs.readFileSync(OUT);
const zlib = require("zlib");
const gz = zlib.gzipSync(wasm, { level: 9 });
console.log("");
console.log("  " + (wasm.length / 1024).toFixed(0) + " KB  → gzip " + (gz.length / 1024).toFixed(0)
  + " KB → base64 " + (Math.ceil(gz.length / 3) * 4 / 1024).toFixed(0) + " KB");

// import 를 찍는다. **여기에 네트워크·URL 계열 이름이 보이면 안 된다** —
// Elyn 정적 스캐너에 걸린다.
const mod = new WebAssembly.Module(wasm);
const byMod = {};
for (const i of WebAssembly.Module.imports(mod)) (byMod[i.module] = byMod[i.module] || []).push(i.name);
for (const k of Object.keys(byMod)) {
  console.log("  import " + k + ": " + byMod[k].sort().join(", "));
}
