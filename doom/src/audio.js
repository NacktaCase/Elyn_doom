// DOOM 효과음 재생 — wasm 이 "이 럼프를 울려라"라고만 하고, 실제 재생은 여기서.
//
// wasi-shim.js 와 같은 방침이다: Node 검증과 실기가 **같은 파일**을 쓴다.
// 다르면 검증이 실기를 안 지킨다.
//
// ── 왜 재생을 JS 가 하는가 ───────────────────────────────────────────
//   · DOOM sfx 는 8비트 unsigned PCM 이라 브라우저가 바로 못 먹는다. Float32
//     변환과 AudioBuffer 캐시는 JS 쪽이 짧다.
//   · **오디오가 아예 막힌 환경일 수 있다.** sandbox.txt 가 오디오를 제한
//     목록에 올려놨고 실측한 적이 없다. 여기서 조용히 무시하면 게임은 그대로
//     돈다 — C 쪽에 재생 상태를 두면 그 폴백이 지저분해진다.
//
// ── 반드시 사용자 제스처 뒤에 만든다 ────────────────────────────────
// 브라우저는 클릭 같은 제스처 없이 만든 오디오 컨텍스트를 suspended 로 둔다.
// 그래서 컨텍스트를 **미리 만들지 않고** resume() 이 처음 불릴 때 만든다.
// DoomGame 은 "클릭해서 조작" 이 이미 필수라(window 가 없어 포커스가 있어야
// 키가 온다) 그 클릭을 그대로 쓴다.
function createDoomAudio(getMemory, opts) {
  var options = opts || {};
  var onNote = options.onNote || function () {};

  var ctx = null;
  var master = null;
  var engine = null;         // wasm exports (음악을 당겨오려면 필요하다)
  var musicNode = null;
  var OPL_RATE = 44100;      // opl_wasm.c 의 기본 샘플레이트
  var resamplePhase = 0;     // 리샘플 위상. 블록 사이에 이어져야 한다.
  var state = "idle";        // idle → on | muted | unavailable | failed
  var VOLUME = 0.6;          // DOOM 효과음은 원래 크다
  var buffers = {};          // 럼프 주소 → AudioBuffer
  var channels = {};         // 채널 번호 → { src, gain, pan, endsAt }

  var hasAudio = function () {
    try {
      return typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined";
    } catch (e) { return false; }
  };

  // ── DOOM sfx 럼프 → AudioBuffer ──────────────────────────────────
  // 포맷: format(2) samplerate(2) length(4) 그다음 8비트 unsigned PCM.
  //
  // ⚠ 앞뒤 16바이트는 건너뛴다. DMX 사운드 라이브러리가 그렇게 했고
  //   chocolate-doom 의 ExpandSoundData 도 `data += 16; length -= 32;` 로
  //   따라간다. 안 건너뛰면 소리 앞뒤에 딱 소리가 붙는다.
  var decode = function (ptr, len) {
    if (buffers[ptr]) return buffers[ptr];
    var m = new Uint8Array(getMemory().buffer);
    if (len < 8) return null;

    var rate = m[ptr + 2] | (m[ptr + 3] << 8);
    var count = m[ptr + 4] | (m[ptr + 5] << 8) | (m[ptr + 6] << 16) | (m[ptr + 7] << 24);
    // 헤더가 럼프보다 길다고 하면 깨진 럼프다. 조용히 포기한다.
    if (count > len - 8 || count <= 48) return null;
    if (!(rate > 0)) rate = 11025;

    var start = ptr + 16;
    var n = count - 32;
    if (n <= 0) return null;

    var buf;
    try { buf = ctx.createBuffer(1, n, rate); }
    catch (e) {
      // 일부 브라우저는 22050 미만 샘플레이트로 만든 버퍼를 거부한다.
      // 그때는 컨텍스트 기본 레이트로 만들고 재생 속도로 보정한다.
      try { buf = ctx.createBuffer(1, n, ctx.sampleRate); } catch (e2) { return null; }
    }
    var ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) ch[i] = (m[start + i] - 128) / 128;

    buffers[ptr] = { buf: buf, rate: rate };
    return buffers[ptr];
  };

  // ── 음악 ─────────────────────────────────────────────────────────
  // 효과음은 "한 방 쏘고 끝"이지만 음악은 **계속 당겨가야** 한다.
  // AudioWorklet 은 모듈을 URL 로 불러와야 하는데, 그 URL 을 만드는 흔한
  // 방법(이진 덩어리 객체 + 오브젝트 URL)이 Elyn 정적 스캐너에 막힌다.
  // 그래서 URL 이 필요 없는 ScriptProcessorNode 를 쓴다. 구식이지만
  // 어디서나 돌고, 측정해 보니 메인스레드의 2% 밖에 안 쓴다.
  //
  // ⚠ 그 API 이름들을 **주석에도 적지 말 것.** 업로드본은 주석을 남기고
  //   뽑으므로 스캐너에는 코드와 똑같이 보인다. 여기서 한 번 어겼다가
  //   자체검증 B절에 잡혔다.
  var startMusic = function () {
    if (musicNode || !ctx || !engine || typeof engine.doom_music_fill !== "function") return;
    try {
      musicNode = ctx.createScriptProcessor(2048, 0, 2);
      musicNode.onaudioprocess = function (e) {
        var L = e.outputBuffer.getChannelData(0);
        var R = e.outputBuffer.getChannelData(1);
        var need = L.length;
        try {
          var ratio = OPL_RATE / ctx.sampleRate;

          // 레이트가 같으면(요청이 받아들여진 보통의 경우) 그대로 옮긴다.
          // 보간이 없으니 OPL 이 만든 파형 그대로다.
          if (ratio === 1) {
            var p1 = engine.doom_music_fill(need);
            if (!p1) { L.fill(0); R.fill(0); return; }
            // ⚠ 뷰는 **매번** 새로 잡는다. 메모리가 grow 하면 갈아치워진다.
            var d1 = new Int16Array(getMemory().buffer, p1, need * 2);
            for (var j = 0; j < need; j++) {
              L[j] = d1[j * 2] / 32768;
              R[j] = d1[j * 2 + 1] / 32768;
            }
            return;
          }

          // 브라우저가 레이트 요청을 무시했을 때만 리샘플한다.
          // 위상을 블록 사이에 **이어간다** — 매번 0 으로 되돌리면 블록
          // 경계(약 43ms)마다 미세한 이음매가 들린다.
          var srcFrames = Math.ceil((need * ratio) + resamplePhase) + 2;
          var ptr = engine.doom_music_fill(srcFrames);
          if (!ptr) { L.fill(0); R.fill(0); return; }
          var pcm = new Int16Array(getMemory().buffer, ptr, srcFrames * 2);
          var sp = resamplePhase;
          for (var i = 0; i < need; i++) {
            var i0 = sp | 0;
            var fr = sp - i0;
            if (i0 + 1 >= srcFrames) { i0 = srcFrames - 2; fr = 1; }
            var a0 = pcm[i0 * 2], a1 = pcm[(i0 + 1) * 2];
            var b0 = pcm[i0 * 2 + 1], b1 = pcm[(i0 + 1) * 2 + 1];
            L[i] = (a0 + (a1 - a0) * fr) / 32768;
            R[i] = (b0 + (b1 - b0) * fr) / 32768;
            sp += ratio;
          }
          resamplePhase = sp - (sp | 0);
        } catch (err) { L.fill(0); R.fill(0); }
      };
      musicNode.connect(master);
    } catch (e) { musicNode = null; }
  };

  var stop = function (channel) {
    var c = channels[channel];
    if (!c) return;
    try { c.src.stop(); } catch (e) { /* 이미 끝났다 */ }
    delete channels[channel];
  };

  return {
    // 사용자 제스처 안에서 부른다. 두 번 이상 불러도 안전하다.
    resume: function () {
      if (state === "unavailable" || state === "failed") return state;
      if (!ctx) {
        if (!hasAudio()) { state = "unavailable"; onNote(state); return state; }
        try {
          var C = (typeof AudioContext !== "undefined") ? AudioContext : webkitAudioContext;
          // ⚠ **OPL 과 같은 레이트를 요청한다.** 다르면 JS 가 리샘플해야 하는데,
          //   ScriptProcessor 블록마다 보간 위상이 0 으로 되돌아가 43ms 주기의
          //   미세한 이음매가 생긴다. 레이트를 맞추면 그 경로 자체가 사라진다.
          //   브라우저가 요청을 무시하면 아래 리샘플 경로가 받는다.
          try { ctx = new C({ sampleRate: OPL_RATE }); }
          catch (e) { ctx = new C(); }
          master = ctx.createGain();
          master.gain.value = VOLUME;
          master.connect(ctx.destination);
          state = "on";
        } catch (e) { state = "failed"; onNote(state + ": " + e); return state; }
      }
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        try { ctx.resume(); } catch (e) { /* 무시 */ }
      }
      startMusic();
      onNote(state);
      return state;
    },

    // 껐다 켠다. **처음 부를 때는 반드시 사용자 제스처 안이어야 한다** —
    // 그때 컨텍스트가 만들어지기 때문이다. 그 뒤로는 게인만 오간다.
    toggle: function () {
      if (!ctx) return this.resume();
      if (state === "on") { state = "muted"; try { master.gain.value = 0; } catch (e) {} }
      else if (state === "muted") { state = "on"; try { master.gain.value = VOLUME; } catch (e) {} }
      onNote(state);
      return state;
    },

    // 인스턴스화 직후 exports 를 넘겨준다. 음악은 이게 있어야 당겨올 수 있다.
    setEngine: function (x) { engine = x; startMusic(); },

    state: function () { return state + (ctx ? "/" + ctx.state : ""); },

    // wasm 에 넘길 import 넷. **어떤 경우에도 throw 하면 안 된다** —
    // import 에서 throw 하면 wasm 이 통째로 트랩한다.
    imports: {
      js_snd_start: function (ptr, len, channel, vol, sep) {
        try {
          if (state !== "on" || !ctx) return;   // muted 면 여기서 끝난다
          var d = decode(ptr, len);
          if (!d) return;
          stop(channel);

          var src = ctx.createBufferSource();
          src.buffer = d.buf;
          // 버퍼를 기본 레이트로 만들었으면 속도로 음정을 되돌린다.
          if (d.buf.sampleRate !== d.rate) src.playbackRate.value = d.rate / d.buf.sampleRate;

          var gain = ctx.createGain();
          gain.gain.value = Math.max(0, Math.min(1, vol / 127));

          var node = gain;
          var pan = null;
          if (typeof ctx.createStereoPanner === "function") {
            pan = ctx.createStereoPanner();
            // DOOM 의 sep 는 0=왼쪽, 128=가운데, 254=오른쪽이다.
            pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
            gain.connect(pan);
            node = pan;
          }
          src.connect(gain);
          node.connect(master);

          src.onended = function () {
            if (channels[channel] && channels[channel].src === src) delete channels[channel];
          };
          src.start();
          channels[channel] = { src: src, gain: gain, pan: pan };
        } catch (e) { /* 소리 하나 못 울린 것뿐이다 */ }
      },

      js_snd_stop: function (channel) {
        try { stop(channel); } catch (e) { /* 무시 */ }
      },

      js_snd_playing: function (channel) {
        try { return channels[channel] ? 1 : 0; } catch (e) { return 0; }
      },

      js_snd_update: function (channel, vol, sep) {
        try {
          var c = channels[channel];
          if (!c) return;
          c.gain.gain.value = Math.max(0, Math.min(1, vol / 127));
          if (c.pan) c.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
        } catch (e) { /* 무시 */ }
      },
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createDoomAudio: createDoomAudio };
}
