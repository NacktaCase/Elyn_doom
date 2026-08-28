// WASI preview1 최소 구현 — doom.wasm 이 요구하는 15개만.
//
// ── 왜 직접 쓰는가 ───────────────────────────────────────────────────
// Node 에는 node:wasi 가 내장이라 그걸 쓰면 부팅 테스트는 당장 된다. 하지만
// 브라우저에는 없으니 결국 하나를 더 써야 하고, 그러면 **Node 에서 통과한
// 코드와 Elyn 에서 도는 코드가 달라진다.** 실기 버그는 전부 그런 자리
// (검증 밖 경로)에서 났다. 그래서 하나만 쓰고 양쪽이 나눠 쓴다.
//
// ── 인메모리 파일시스템 ──────────────────────────────────────────────
// 브라우저에 파일은 없다. 그런데 DOOM 은 파일을 두 가지로 쓴다:
//
//   1. **존재 확인** — WAD 를 열기 전에 d_iwad.c 가 M_FileExists(fopen) 로
//      확인한다(d_iwad.c:635). 막히면 "IWAD file 'doom.wad' not found!" 로
//      죽는다. 실제로 처음에 그렇게 죽었다.
//   2. **진짜 왕복** — i_oplmusic 은 MUS 를 MIDI 로 바꿔 **임시 파일에 쓴 뒤
//      다시 읽는다.** 처음엔 쓰기를 버리고 읽기를 EOF 로 돌려줬더니
//      "I_OPL_RegisterSong: Failed to load MID." 로 음악이 통째로 죽었다.
//
// 그래서 껍데기가 아니라 **진짜 인메모리 파일시스템**이다. 쓴 것을 들고
// 있다가 읽을 때 돌려준다. 덤으로 설정·세이브도 (그 세션 안에서는) 산다.
//
// WAD 의 실제 바이트는 여기로 오지 않는다 — w_file_memory.c 가 선형 메모리에서
// 직접 읽는다. 4 MB 를 이 경로로 넘길 이유가 없다.
function createWasiShim(getMemory, opts) {
  var options = opts || {};
  var onOut = options.onOut || function () {};
  var nowMs = options.nowMs || function () { return 0; };

  // WASI errno
  var OK = 0, EBADF = 8, ENOSYS = 52;

  var view = function () { return new DataView(getMemory().buffer); };
  var u8 = function () { return new Uint8Array(getMemory().buffer); };

  // fd 0/1/2 는 표준 스트림, 3 은 preopen "." 이다.
  // 4번부터는 path_open 이 내주는 빈 파일이다.
  var PREOPEN_FD = 3;
  var PREOPEN_NAME = ".";
  var nextFd = 4;
  var openFds = {};        // fd → { path, pos, append }
  var files = {};          // 경로 → Uint8Array

  // 경로 정규화. wasi-libc 는 preopen 기준 상대경로를 준다("./x" 나 "x").
  var normPath = function (p) {
    return String(p).replace(/^\.\//, "").replace(/^\//, "");
  };

  var readStr = function (ptr, len) {
    var m = u8(), s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(m[ptr + i]);
    return normPath(s);
  };

  // stdout/stderr 는 줄 단위로 모아 넘긴다. DOOM 은 printf 를 조각내 부르므로
  // 조각마다 콜백을 때리면 로그가 읽을 수 없게 된다.
  var pending = "";
  var flushLines = function (force) {
    var i;
    while ((i = pending.indexOf("\n")) >= 0) {
      onOut(pending.slice(0, i));
      pending = pending.slice(i + 1);
    }
    if (force && pending) { onOut(pending); pending = ""; }
  };

  // iovec 배열을 하나의 바이트열로 모은다. {buf:u32, len:u32} 가 반복된다.
  var readIovs = function (ptr, cnt) {
    var v = view(), m = u8(), parts = [], total = 0, i;
    for (i = 0; i < cnt; i++) {
      var b = v.getUint32(ptr + i * 8, true);
      var l = v.getUint32(ptr + i * 8 + 4, true);
      parts.push(m.subarray(b, b + l));
      total += l;
    }
    return { parts: parts, total: total };
  };

  return {
    // ── 남은 출력을 강제로 뱉는다 ────────────────────────────────────
    // ⚠ 이게 없으면 **에러 메시지를 영영 못 본다.**
    //   DOOM 은 printf 를 조각내 부르므로 줄 단위로 모으는데, 개행 없이
    //   출력한 뒤 트랩이 나면 그 조각이 pending 에 갇힌 채 사라진다.
    //   실제로 그렇게 됐다: 실기에서 D_CheckNetGame 줄(개행 없음)과 그
    //   뒤의 진짜 에러 메시지가 통째로 안 보이고 트랩만 보고됐다.
    //   Elyn 에는 콘솔이 없어서 이걸 놓치면 추측밖에 할 게 없다.
    //   호출자는 wasm 호출을 try/catch 로 감싸고 catch 에서 이걸 불러야 한다.
    _flush: function () { flushLines(true); },

    // ── 표준 출력 ────────────────────────────────────────────────────
    fd_write: function (fd, iovs, cnt, nwritten) {
      var r = readIovs(iovs, cnt);
      if (fd === 1 || fd === 2) {
        var s = "";
        for (var i = 0; i < r.parts.length; i++) {
          var p = r.parts[i];
          for (var j = 0; j < p.length; j++) s += String.fromCharCode(p[j]);
        }
        pending += s;
        flushLines(false);
      }
      else {
        // 진짜 파일이면 실제로 쓴다. i_oplmusic 이 여기에 MIDI 를 쓰고
        // 곧바로 다시 읽는다 — 버리면 음악이 안 나온다.
        var f = openFds[fd];
        if (f) {
          var cur = files[f.path] || new Uint8Array(0);
          var need = f.pos + r.total;
          var buf = cur;
          if (need > cur.length) { buf = new Uint8Array(need); buf.set(cur); }
          var o = f.pos;
          for (var k = 0; k < r.parts.length; k++) { buf.set(r.parts[k], o); o += r.parts[k].length; }
          files[f.path] = buf;
          f.pos = need;
        }
      }
      view().setUint32(nwritten, r.total, true);
      return OK;
    },

    // ── 읽기 ─────────────────────────────────────────────────────────
    fd_read: function (fd, iovs, cnt, nread) {
      var f = openFds[fd];
      if (!f) { if (fd === 0) { view().setUint32(nread, 0, true); return OK; } return EBADF; }
      var data = files[f.path] || new Uint8Array(0);
      var v = view(), m = u8(), total = 0;
      for (var i = 0; i < cnt; i++) {
        var b = v.getUint32(iovs + i * 8, true);
        var l = v.getUint32(iovs + i * 8 + 4, true);
        var n = Math.min(l, data.length - f.pos);
        if (n <= 0) break;
        m.set(data.subarray(f.pos, f.pos + n), b);
        f.pos += n; total += n;
      }
      v.setUint32(nread, total, true);
      return OK;
    },

    // whence 0=SET 1=CUR 2=END. **2 를 제대로 처리해야 한다** —
    // MIDI_LoadFile 이 fseek(END)+ftell 로 파일 크기를 잰다.
    fd_seek: function (fd, offset, whence, newOffset) {
      var f = openFds[fd];
      if (!f) return EBADF;
      var len = (files[f.path] || new Uint8Array(0)).length;
      var off = Number(offset);
      var pos = whence === 1 ? f.pos + off : (whence === 2 ? len + off : off);
      if (pos < 0) pos = 0;
      f.pos = pos;
      view().setBigUint64(newOffset, BigInt(pos), true);
      return OK;
    },

    // 닫아도 **내용은 남긴다.** 쓰고 닫은 뒤 다시 열어 읽는 흐름이 있다.
    fd_close: function (fd) { delete openFds[fd]; return OK; },

    // filetype 4 = regular file. 24바이트 fdstat 구조체다.
    fd_fdstat_get: function (fd, ptr) {
      var v = view();
      v.setUint8(ptr, fd === PREOPEN_FD ? 3 : 4);   // 3 = directory
      v.setUint8(ptr + 1, 0);
      v.setUint16(ptr + 2, 0, true);
      v.setUint32(ptr + 4, 0, true);
      v.setBigUint64(ptr + 8, BigInt("0xFFFFFFFFFFFFFFFF"), true);
      v.setBigUint64(ptr + 16, BigInt("0xFFFFFFFFFFFFFFFF"), true);
      return OK;
    },
    fd_fdstat_set_flags: function () { return OK; },

    // ── preopen: "." 하나만 있다고 답한다 ────────────────────────────
    // DOOM 이 "Using . for configuration and saves" 를 찍는 근거다.
    fd_prestat_get: function (fd, ptr) {
      if (fd !== PREOPEN_FD) return EBADF;
      var v = view();
      v.setUint8(ptr, 0);                                   // tag 0 = dir
      v.setUint32(ptr + 4, PREOPEN_NAME.length, true);
      return OK;
    },
    fd_prestat_dir_name: function (fd, ptr, len) {
      if (fd !== PREOPEN_FD) return EBADF;
      var m = u8();
      for (var i = 0; i < PREOPEN_NAME.length && i < len; i++) {
        m[ptr + i] = PREOPEN_NAME.charCodeAt(i);
      }
      return OK;
    },

    // ── 열기 ─────────────────────────────────────────────────────────
    // ⚠ **항상 성공한다.** 실패시키면 d_iwad 가 WAD 를 못 찾았다고 판단해
    //   I_Error 로 죽는다(위 머리말 1번).
    //   oflags bit0(1) = O_CREAT, bit3(8) = O_TRUNC.
    path_open: function (dirfd, dirflags, pathPtr, pathLen, oflags,
                         rightsBase, rightsInh, fdflags, fdOut) {
      var path = readStr(pathPtr, pathLen);
      if ((oflags & 8) || !(path in files)) {
        // 자르기(O_TRUNC)이거나 없는 파일이면 빈 내용으로 시작한다.
        if ((oflags & 8) || (oflags & 1) || !(path in files)) files[path] = new Uint8Array(0);
      }
      var fd = nextFd++;
      openFds[fd] = { path: path, pos: 0 };
      view().setUint32(fdOut, fd, true);
      return OK;
    },

    // ── 나머지 파일 조작: 성공했다고 하고 아무것도 안 한다 ───────────
    // 세이브·설정 정리용이다. 남길 데가 없으므로 실패시킬 이유도 없다.
    path_create_directory: function () { return OK; },
    path_remove_directory: function () { return OK; },
    path_unlink_file: function (dirfd, pathPtr, pathLen) {
      try { delete files[readStr(pathPtr, pathLen)]; } catch (e) { /* 무시 */ }
      return OK;
    },
    path_rename: function () { return OK; },
    path_filestat_get: function () { return ENOSYS; },

    // ── 시계 ─────────────────────────────────────────────────────────
    // 나노초 단위 u64 다. 시간의 출처는 nowMs 하나로 모은다 —
    // js_now_ms 와 여기가 서로 다른 시계를 보면 게임 시간이 어긋난다.
    clock_time_get: function (id, precision, ptr) {
      view().setBigUint64(ptr, BigInt(Math.floor(nowMs())) * BigInt(1000000), true);
      return OK;
    },
    clock_res_get: function (id, ptr) {
      view().setBigUint64(ptr, BigInt(1000000), true);
      return OK;
    },

    // ── 종료 ─────────────────────────────────────────────────────────
    // I_Error 가 여기로 온다. throw 해야 호출자가 알 수 있다 —
    // 조용히 리턴하면 wasm 이 정의되지 않은 상태로 계속 돌아간다.
    proc_exit: function (code) {
      flushLines(true);
      var e = new Error("DOOM 이 종료를 요청했다 (코드 " + code + ")");
      e.doomExit = code;
      throw e;
    },

    // 호출되면 알 수 있게 남긴다. 미구현이지 조용한 성공이 아니다.
    args_get: function () { return OK; },
    args_sizes_get: function (argc, argvBuf) {
      var v = view();
      v.setUint32(argc, 0, true);
      v.setUint32(argvBuf, 0, true);
      return OK;
    },
    environ_get: function () { return OK; },
    environ_sizes_get: function (cnt, buf) {
      var v = view();
      v.setUint32(cnt, 0, true);
      v.setUint32(buf, 0, true);
      return OK;
    },
    random_get: function (ptr, len) {
      var m = u8();
      for (var i = 0; i < len; i++) m[ptr + i] = (Math.random() * 256) & 255;
      return OK;
    },
    poll_oneoff: function () { return ENOSYS; },
    sched_yield: function () { return OK; },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createWasiShim: createWasiShim };
}
