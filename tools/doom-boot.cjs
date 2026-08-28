// doom.wasm 을 Node 에서 실제로 부팅시켜 프레임이 나오는지 본다.
//
//   node tools/doom-boot.cjs [틱수]
//
// ── 왜 브라우저 전에 Node 인가 ───────────────────────────────────────
// 여기까지는 전부 계산이었다. WAD 를 5.5% 로 깎았지만 **텍스처 하나만 빠져도
// R_InitTextures 가 I_Error 로 죽는다.** 그걸 Elyn 에서 처음 알게 되면
// 콘솔이 없어서 흰 화면만 보게 된다 — 원인을 알 방법이 없다.
//
// Node 에는 WASI 가 내장이라 같은 wasm 을 그대로 돌릴 수 있고, DOOM 의 printf
// 가 stdout 으로 나온다. **에러 메시지를 읽을 수 있는 유일한 기회다.**
// (engine-selftest 가 컴포넌트를 Node 에서 그대로 돌리는 것과 같은 방침이다.)
const fs = require("fs");
const path = require("path");
// ⚠ node:wasi 를 쓰지 않는다. 브라우저에는 없으므로 그걸로 통과시키면
//   Elyn 에서 도는 코드가 검증 밖에 남는다. 같은 shim 을 양쪽이 쓴다.
const { createWasiShim } = require("../doom/src/wasi-shim.js");
// 오디오도 **같은 파일**을 쓴다. Node 에는 AudioContext 가 없으므로
// 여기서 도는 건 자동으로 "오디오 없음" 폴백 경로다 — 그게 공짜로 검증된다.
const { createDoomAudio } = require("../doom/src/audio.js");

const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "doom", "build", "doom-Oz.wasm");
const WAD = path.join(ROOT, "doom", "build", "doom.wad");
const TICKS = parseInt(process.argv[2], 10) || 60;

for (const f of [WASM, WAD]) {
  if (!fs.existsSync(f)) { console.error("없다: " + f); process.exit(1); }
}

const bytes = fs.readFileSync(WASM);
const wadBytes = fs.readFileSync(WAD);

// ⚠ 시계는 **실시간이어야 한다.** 한때 "틱마다 28ms 씩" 흐르는 가짜 시계를
//   줬다가 doom_init() 안에서 무한 루프에 빠졌다:
//     TryRunTics 는 `I_GetTime() - entertime > 10` 으로만 빠져나오는데
//     (d_loop.c), I_Sleep 은 우리 쪽에서 no-op 이므로 **시계가 스스로 흐르지
//     않으면 영원히 돈다.** 브라우저는 performance.now() 라 저절로 흐른다.
//   즉 이건 엔진 버그가 아니라 하니스 버그였다. 실기와 같은 시계를 쓴다.
const t_start = Date.now();
const nowMs = () => Date.now() - t_start;

let mem = null;
const audio = createDoomAudio(() => mem, {});
const shim = createWasiShim(() => mem, {
  nowMs: nowMs,
  onOut: (line) => console.log("  | " + line),
});

WebAssembly.instantiate(bytes, {
  wasi_snapshot_preview1: shim,
  env: Object.assign({ js_now_ms: () => nowMs() >>> 0 }, audio.imports),
}).then(({ instance }) => {
  const x = instance.exports;
  mem = x.memory;
  // reactor 모델이라 _start 가 없다. _initialize 가 있으면 먼저 부른다.
  if (typeof x._initialize === "function") x._initialize();

  // ⚠ memory.buffer 는 grow 하면 **갈아치워진다.** 뷰를 미리 잡아두고
  //   재사용하면 detached ArrayBuffer 를 읽게 된다. 매번 새로 잡는다.
  //   (ChessEngine 의 wasm 래퍼가 res() 를 매번 만드는 것과 같은 이유다.)
  const u8 = () => new Uint8Array(x.memory.buffer);

  console.log("WAD 적재 " + (wadBytes.length / 1024).toFixed(0) + " KB");
  const ptr = x.doom_wad_alloc(wadBytes.length);
  if (!ptr) { console.error("doom_wad_alloc 실패"); process.exit(1); }
  u8().set(wadBytes, ptr);

  console.log("doom_init …");
  console.log("─".repeat(60));
  const t0 = Date.now();
  x.doom_init();
  console.log("─".repeat(60));
  console.log("init 완료 " + (Date.now() - t0) + "ms");

  const fb = x.doom_frame_ptr();
  const W = x.doom_width();
  const H = x.doom_height();
  console.log("프레임버퍼 ptr=" + fb + "  " + W + "x" + H);
  if (!fb) { console.error("프레임버퍼가 없다"); process.exit(1); }

  // 틱을 돌리며 화면이 실제로 그려지는지 본다.
  const t1 = Date.now();
  // 실시간 시계라 틱을 몰아치면 게임 시간이 안 흐른다(DOOM 은 35Hz).
  // 실기의 rAF 처럼 프레임 간격을 두고 부른다.
  for (let i = 0; i < TICKS; i++) {
    const until = Date.now() + 16;
    x.doom_tick();
    while (Date.now() < until) { /* 프레임 간격 */ }
  }
  const ms = Date.now() - t1;

  // 픽셀 통계. "루프는 도는데 화면이 검다" 를 잡는다.
  const buf = u8();
  const px = new Uint32Array(x.memory.buffer, fb, W * H);
  const seen = new Set();
  let nonBlack = 0;
  for (let i = 0; i < px.length; i += 7) {
    const v = px[i] >>> 0;
    if ((v & 0xffffff) !== 0) nonBlack++;
    if (seen.size < 4096) seen.add(v);
  }
  const sampled = Math.ceil(px.length / 7);

  console.log("");
  console.log(TICKS + " 틱  " + ms + "ms  (" + (ms / TICKS).toFixed(2) + "ms/틱, "
    + (1000 / (ms / TICKS)).toFixed(0) + " tic/s — DOOM 은 35 면 실시간)");
  console.log("픽셀  비검정 " + ((100 * nonBlack) / sampled).toFixed(1) + "%  · 색 "
    + seen.size + "종");

  if (nonBlack === 0) {
    console.log("");
    console.log("✗ 화면이 완전히 검다 — 틱은 도는데 렌더가 안 된다.");
    process.exitCode = 1;
  } else if (seen.size < 8) {
    console.log("");
    console.log("✗ 색이 " + seen.size + "종뿐이다 — 단색 화면일 가능성이 높다.");
    process.exitCode = 1;
  } else {
    console.log("");
    console.log("✓ DOOM 이 돌고 화면이 그려진다.");

    // 눈으로 확인할 수 있게 PPM 으로 떨군다. 포맷이 단순해서 의존성이 없다.
    const out = path.join(ROOT, "doom", "build", "frame.ppm");
    const head = Buffer.from("P6\n" + W + " " + H + "\n255\n", "ascii");
    const rgb = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const v = px[i];
      rgb[i * 3] = (v >> 16) & 255;      // DOOM 은 XRGB 로 채운다
      rgb[i * 3 + 1] = (v >> 8) & 255;
      rgb[i * 3 + 2] = v & 255;
    }
    fs.writeFileSync(out, Buffer.concat([head, rgb]));
    console.log("  프레임을 " + path.relative(ROOT, out) + " 로 떨궜다 (눈으로 확인용)");
  }
}).catch((e) => {
  console.error("");
  console.error("✗ " + (e && e.message ? e.message : e));
  process.exit(1);
});
