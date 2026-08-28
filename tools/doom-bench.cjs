// 게임 중 순수 비용 측정: doom_tick(엔진) · 블릿(JS) · 음악(OPL).
//   node tools/doom-bench.cjs
// 부팅 테스트는 틱 사이에 16ms 대기를 넣어 실제 비용이 가려진다. 여기서는
// 대기 없이 잰다 — 메인 스레드 예산을 얼마나 먹는지가 관심사다.
const fs = require("fs"), path = require("path");
const { createWasiShim } = require("../doom/src/wasi-shim.js");
const { createDoomAudio } = require("../doom/src/audio.js");
const ROOT = path.join(__dirname, "..");
const wasmBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom-Oz.wasm"));
const wadBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom.wad"));
const t0 = Date.now(); const nowMs = () => Date.now() - t0;
let memory = null;
const audio = createDoomAudio(() => memory, {});
const shim = createWasiShim(() => memory, { nowMs, onOut: () => {} });

WebAssembly.instantiate(wasmBytes, {
  wasi_snapshot_preview1: shim,
  env: Object.assign({ js_now_ms: () => nowMs() >>> 0 }, audio.imports),
}).then(({ instance }) => {
  const x = instance.exports; memory = x.memory;
  if (x._initialize) x._initialize();
  const p = x.doom_wad_alloc(wadBytes.length);
  new Uint8Array(x.memory.buffer).set(wadBytes, p);
  x.doom_init();
  const W = x.doom_width(), H = x.doom_height();

  const tick = (n) => { for (let i = 0; i < n; i++) { x.doom_tick(); const u = Date.now() + 16; while (Date.now() < u); } };
  const tap = (k) => { x.doom_key(1, k); tick(6); x.doom_key(0, k); tick(6); };
  tick(40); tap(27); tick(10); tap(13); tick(10); tap(13); tick(10); tap(13); tick(40);
  for (const c of "idclev12") tap(c.charCodeAt(0));
  tick(60);

  // 블릿(컴포넌트가 매 프레임 하는 일)
  const img = new Uint8ClampedArray(W * H * 4);
  const dst = new Uint32Array(img.buffer);
  const blit = () => {
    const src = new Uint32Array(x.memory.buffer, x.doom_frame_ptr(), W * H);
    for (let i = 0, n = W * H; i < n; i++) {
      const v = src[i];
      dst[i] = (0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255)) >>> 0;
    }
  };

  const N = 200;
  // (a) 쉬지 않고 부르기 — rAF 마다 부르는 지금 방식
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) x.doom_tick();
  const tickMs = Number(process.hrtime.bigint() - t) / 1e6 / N;

  // (b) DOOM 의 35Hz 에 맞춰 부르기
  //     TryRunTics 는 다음 틱이 될 때까지 I_Sleep(1)(우리는 no-op)로 **바쁜
  //     대기**를 한다. 너무 자주 부르면 그 차이를 그냥 태운다.
  const TIC = 1000 / 35;
  let busy = 0, next = Date.now();
  for (let i = 0; i < 60; i++) {
    const w = next - Date.now();
    if (w > 0) { const u = Date.now() + w; while (Date.now() < u); }
    const a = process.hrtime.bigint();
    x.doom_tick();
    busy += Number(process.hrtime.bigint() - a) / 1e6;
    next += TIC;
  }
  const pacedMs = busy / 60;

  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) blit();
  const blitMs = Number(process.hrtime.bigint() - t) / 1e6 / N;

  t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) x.doom_music_fill(2048);
  const musMs = Number(process.hrtime.bigint() - t) / 1e6 / 20;

  console.log("해상도      " + W + "x" + H + "  (" + (W * H / 1000).toFixed(0) + "k 픽셀)");
  console.log("doom_tick   " + tickMs.toFixed(2) + " ms   (쉬지 않고 = 지금 방식)");
  console.log("doom_tick   " + pacedMs.toFixed(2) + " ms   (35Hz 로 맞춰 부를 때)");
  console.log("블릿(JS)    " + blitMs.toFixed(2) + " ms");
  console.log("음악 2048프레임 " + musMs.toFixed(2) + " ms  (오디오 46ms 분량)");
  console.log("");
  console.log("프레임 예산: 60fps 면 16.7ms. 틱+블릿 = " + (tickMs + blitMs).toFixed(2) + " ms");
  console.log("음악은 46ms 마다 " + musMs.toFixed(2) + "ms → 메인스레드의 "
    + (100 * musMs / 46).toFixed(0) + "%");
}).catch((e) => console.error("✗ " + (e && e.message ? e.message : e)));
