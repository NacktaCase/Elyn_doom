// 죽음·종료 경로를 Node 에서 몰아보는 일회성 조사 도구.
//
//   node tools/doom-death-test.cjs
//
// 브라우저에서 하려다 화면 판정이 애매해 옮겼다 — Node 는 프레임을 PNG 로
// 떨궈 **눈으로 확인**할 수 있다. 메뉴를 짚어 게임에 들어간 뒤 나이트메어에서
// 죽을 때까지 굴린다.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createWasiShim } = require("../doom/src/wasi-shim.js");
const { createDoomAudio } = require("../doom/src/audio.js");

const ROOT = path.join(__dirname, "..");
const wasmBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom-Oz.wasm"));
const wadBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom.wad"));

const t0 = Date.now();
const nowMs = () => Date.now() - t0;
let memory = null;
const lines = [];
const audio = createDoomAudio(() => memory, {});
const shim = createWasiShim(() => memory, { nowMs, onOut: (l) => lines.push(l) });

const KEY = { ESC: 27, ENTER: 13, DOWN: 0xaf, UP: 0xad, FIRE: 0xa3, USE: 0xa2, Y: 121 };

WebAssembly.instantiate(wasmBytes, {
  wasi_snapshot_preview1: shim,
  env: Object.assign({ js_now_ms: () => nowMs() >>> 0 }, audio.imports),
}).then(({ instance }) => {
  const x = instance.exports;
  memory = x.memory;
  if (typeof x._initialize === "function") x._initialize();

  const ptr = x.doom_wad_alloc(wadBytes.length);
  new Uint8Array(x.memory.buffer).set(wadBytes, ptr);
  x.doom_init();

  const W = x.doom_width(), H = x.doom_height();
  let exited = null, crashed = null;

  const tick = (n) => {
    for (let i = 0; i < n; i++) {
      if (exited || crashed) return;
      try {
        x.doom_tick();
      } catch (e) {
        if (e && e.doomExit === 0) { exited = 0; return; }
        crashed = { msg: (e && e.message) || String(e), code: e && e.doomExit };
        return;
      }
      // 실기의 rAF 간격을 흉내낸다. 몰아치면 게임 시간이 안 흐른다.
      const until = Date.now() + 16;
      while (Date.now() < until) { /* 프레임 간격 */ }
    }
  };
  const tap = (k, hold) => {
    if (exited !== null || crashed) return;
    x.doom_key(1, k); tick(Math.max(2, Math.round((hold || 90) / 16)));
    x.doom_key(0, k); tick(6);
  };

  const dump = (name) => {
    const px = new Uint32Array(x.memory.buffer, x.doom_frame_ptr(), W * H);
    const raw = Buffer.alloc(H * (1 + W * 3));
    for (let y = 0; y < H; y++) {
      raw[y * (1 + W * 3)] = 0;
      for (let xx = 0; xx < W; xx++) {
        const v = px[y * W + xx], o = y * (1 + W * 3) + 1 + xx * 3;
        raw[o] = (v >> 16) & 255; raw[o + 1] = (v >> 8) & 255; raw[o + 2] = v & 255;
      }
    }
    const T = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
    const crc = (b) => { let c = 0xFFFFFFFF; for (const v of b) c = T[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const ck = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
    const out = path.join(ROOT, "doom", "build", name + ".png");
    fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ck("IHDR", ih), ck("IDAT", zlib.deflateSync(raw, { level: 9 })), ck("IEND", Buffer.alloc(0))]));
    return path.relative(ROOT, out);
  };

  console.log("타이틀 대기…");
  tick(40);
  console.log("  " + dump("t1-title"));

  // 메뉴: Esc → New Game → 에피소드1 → 난이도(맨 아래 = Nightmare) → 확인
  tap(KEY.ESC); tick(15);
  tap(KEY.ENTER); tick(15);          // New Game
  tap(KEY.ENTER); tick(15);          // Knee-Deep in the Dead
  for (let i = 0; i < 4; i++) tap(KEY.DOWN);
  tap(KEY.ENTER); tick(15);          // Nightmare!
  tap(KEY.Y); tick(60);              // "정말?" 확인
  console.log("  " + dump("t2-ingame"));

  console.log("나이트메어에서 죽을 때까지…");
  let rounds = 0;
  for (; rounds < 120 && !exited && !crashed; rounds++) {
    x.doom_key(1, KEY.UP); tick(15); x.doom_key(0, KEY.UP); tick(25);
    if (rounds % 20 === 19) console.log("  " + rounds + " 라운드");
  }
  console.log("  " + dump("t3-after"));

  console.log("");
  if (crashed) console.log("✗ 크래시: " + crashed.msg + "  (code " + crashed.code + ")");
  else if (exited !== null) console.log("✓ 정상 종료 (code " + exited + ")");
  else console.log("· " + rounds + " 라운드 동안 크래시도 종료도 없음");
  console.log("");
  console.log("DOOM 로그 마지막 3줄:");
  for (const l of lines.slice(-3)) console.log("  | " + l);
}).catch((e) => {
  try { shim._flush(); } catch (err) { /* 무시 */ }
  console.error("✗ " + (e && e.message ? e.message : e));
  for (const l of lines.slice(-5)) console.error("  | " + l);
});
