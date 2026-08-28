// 레벨 전환(E1M1 → E1M2)에서 페이지가 죽는 문제 조사.
//   node tools/doom-warp-test.cjs [맵번호]
// IDCLEV 치트로 곧장 넘겨 본다. 메모리 증가와 소요 시간을 같이 찍는다 —
// "페이지가 통째로 죽는다"는 보통 OOM 아니면 무한 루프다.
const fs = require("fs");
const path = require("path");
const { createWasiShim } = require("../doom/src/wasi-shim.js");
const { createDoomAudio } = require("../doom/src/audio.js");

const ROOT = path.join(__dirname, "..");
const MAP = process.argv[2] || "12";
const wasmBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom-Oz.wasm"));
const wadBytes = fs.readFileSync(path.join(ROOT, "doom", "build", "doom.wad"));

const t0 = Date.now();
const nowMs = () => Date.now() - t0;
let memory = null;
const lines = [];
const audio = createDoomAudio(() => memory, {});
const shim = createWasiShim(() => memory, { nowMs, onOut: (l) => lines.push(l) });
const mb = () => (memory.buffer.byteLength / 1048576).toFixed(1);

WebAssembly.instantiate(wasmBytes, {
  wasi_snapshot_preview1: shim,
  env: Object.assign({ js_now_ms: () => nowMs() >>> 0 }, audio.imports),
}).then(({ instance }) => {
  const x = instance.exports;
  memory = x.memory;
  if (x._initialize) x._initialize();
  const ptr = x.doom_wad_alloc(wadBytes.length);
  new Uint8Array(x.memory.buffer).set(wadBytes, ptr);
  x.doom_init();
  console.log("부팅 후 메모리 " + mb() + " MB");

  let exited = null, crashed = null;
  const tick = (n) => {
    for (let i = 0; i < n; i++) {
      if (exited !== null || crashed) return;
      try { x.doom_tick(); }
      catch (e) {
        if (e && e.doomExit === 0) { exited = 0; return; }
        crashed = { msg: (e && e.message) || String(e), code: e && e.doomExit };
        return;
      }
      const until = Date.now() + 16;
      while (Date.now() < until) { /* 프레임 간격 */ }
    }
  };
  const tap = (k, hold) => {
    if (exited !== null || crashed) return;
    x.doom_key(1, k); tick(Math.max(2, Math.round((hold || 90) / 16)));
    x.doom_key(0, k); tick(6);
  };
  const type = (s) => { for (const c of s) tap(c.charCodeAt(0)); };

  // 메뉴로 게임 시작 (Esc → New Game → 에피소드1 → 난이도 기본)
  tick(40);
  tap(27); tick(15);
  tap(13); tick(15);
  tap(13); tick(15);
  tap(13); tick(40);
  console.log("게임 진입, 메모리 " + mb() + " MB");
  if (crashed) { console.log("✗ 진입에서 크래시: " + crashed.msg); return report(); }

  // ⚠ IDCLEV 는 **인터미션을 건너뛴다.** 정상 진행(판을 끝내고 다음으로)은
  //   WI_Start → 인터미션 → G_WorldDone 을 거치므로 경로가 다르다.
  //   실기에서 "스테이지 2로 가면 페이지가 죽는다"는 그쪽이다.
  const USE_EXIT = process.argv.indexOf("--exit") >= 0;
  const t1 = Date.now();
  if (USE_EXIT && typeof x.doom_exit_level === "function") {
    console.log("레벨 종료 → 인터미션 경로…");
    x.doom_exit_level();
    for (let s = 0; s < 12 && !crashed && exited === null; s++) {
      tick(35);
      console.log("  +" + ((s + 1) * 35) + "틱  " + (Date.now() - t1) + "ms  메모리 " + mb() + " MB");
      tap(13);   // 인터미션은 아무 키나 누르면 넘어간다
    }
  } else {
    console.log("IDCLEV" + MAP + " 로 워프…");
    type("idclev" + MAP);
    tick(120);
  }
  console.log("전환 후 " + (Date.now() - t1) + "ms, 메모리 " + mb() + " MB");

  // ⚠ 음악을 **실제로 당기면서** 굴린다. 실기에서는 ScriptProcessorNode 가
  //   메인 스레드에서 doom_music_fill 을 계속 부른다. 그 안에서 멎으면
  //   페이지가 통째로 죽는다 — 잡히는 예외가 아니라 스레드가 멎는 것이라
  //   우리 try/catch 가 아무것도 못 한다.
  const PULL = process.argv.indexOf("--music") >= 0;
  let worstPull = 0, pulls = 0;
  const pullMusic = () => {
    if (!PULL || typeof x.doom_music_fill !== "function") return;
    const t = Date.now();
    x.doom_music_fill(2048);
    const dt = Date.now() - t;
    pulls++;
    if (dt > worstPull) worstPull = dt;
    if (dt > 2000) { crashed = { msg: "doom_music_fill 이 " + dt + "ms 걸렸다 (멎음 의심)", code: null }; }
  };

  console.log("플레이 지속" + (PULL ? " (음악 당기며)" : "") + "…");
  for (let r = 0; r < 40 && !crashed && exited === null; r++) {
    for (let k = 0; k < 6; k++) { tick(5); pullMusic(); }
    // 조금 움직인다
    x.doom_key(1, 0xad); tick(10); x.doom_key(0, 0xad);
    if (r % 10 === 9) {
      console.log("  라운드 " + (r + 1) + "  메모리 " + mb() + " MB"
        + (PULL ? "  음악 " + pulls + "회, 최악 " + worstPull + "ms" : ""));
    }
  }
  report();

  function report() {
    console.log("");
    if (crashed) console.log("✗ 크래시: " + crashed.msg + " (code " + crashed.code + ")");
    else if (exited !== null) console.log("· 정상 종료 (code " + exited + ")");
    else console.log("✓ 크래시 없음, 최종 메모리 " + mb() + " MB");
    console.log("로그 마지막 5줄:");
    for (const l of lines.slice(-5)) console.log("  | " + l);
  }
}).catch((e) => {
  try { shim._flush(); } catch (err) {}
  console.error("✗ " + (e && e.message ? e.message : e));
  for (const l of lines.slice(-6)) console.error("  | " + l);
});
