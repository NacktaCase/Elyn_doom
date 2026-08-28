# 설계

## 실행 경로

컴포넌트가 마운트되면 순서대로 일어나는 일.

1. `FreedoomWad1`~`5` 에서 base64 문자열을 이어붙인다.
2. `DecompressionStream("gzip")` 으로 wasm 과 WAD 를 푼다.
3. `WebAssembly.instantiate` 로 엔진을 올린다. import 는 두 묶음이다.
   - `wasi_snapshot_preview1` — WASI 표준 17개. `wasi-shim.js` 가 구현한다.
   - `env` — `js_now_ms` 와 `js_snd_*` 4개.
4. `doom_wad_alloc` 으로 wasm 메모리에 자리를 잡고 WAD 를 복사한다.
5. `doom_init` 을 부른다. 이 안에서 WAD 를 읽고 텍스처를 만든다.
6. `requestAnimationFrame` 마다 `doom_tick` 을 부르고 프레임버퍼를 canvas 에
   그린다.

import 목록은 `node tools/build-doom-wasm.cjs` 가 빌드할 때마다 출력한다.

## 파일 배치

`doom/src/` 의 파일은 vendor 파일을 대체한다. vendor 트리는 수정하지 않고,
빌드에서 원본을 빼고 이쪽을 넣는다.

| 파일 | 대체 대상 | 하는 일 |
|---|---|---|
| `doomgeneric_wasm.c` | `doomgeneric_*.c` | 플랫폼 함수 6개, 종료 감지 |
| `w_file_memory.c` | `w_file_stdc.c` | WAD 를 메모리에서 읽는다 |
| `i_sound_wasm.c` | `i_sound.c` | SDL 없이 사운드 |
| `opl_wasm.c` | `opl.c`, `opl_sdl.c` | OPL2/3 백엔드 |
| `opl_compat.h` | — | chocolate 소스를 doomgeneric 헤더에 맞추는 어댑터 |
| `wasi-shim.js` | — | WASI preview1, 인메모리 파일시스템 |
| `audio.js` | — | Web Audio. 효과음과 OPL 음악 스트리밍 |

예외가 하나 있다. `d_main.c` 의 `(atexit_func_t) G_CheckDemoStatus` 는 잘못된
함수 포인터 캐스팅이고(실제 반환형은 `boolean`), wasm 에서 간접 호출하면 트랩이
난다. 파일을 고치는 대신 컴파일할 때 이름을 치환해 우회한다.

## Emscripten 을 쓰지 않는 이유

두 가지다.

1. Elyn 컴포넌트는 `function 이름() { ... }` 하나에 전부 들어가야 한다.
   glue 모듈을 `import` 할 수 없다.
2. Elyn 은 컴포넌트 소스를 정적으로 스캔해 등록을 막는다. 차단 대상 API 이름이
   보이면 거부하는데, 호출인지 `typeof` 확인인지 구분하지 않고 주석도 소스로
   본다. Emscripten glue 에는 네트워크, URL, 파일 계열 이름이 수십 개 들어 있다.

wasi-sdk 로 빌드하면 glue 자체가 없어 걸릴 이름이 생기지 않는다.

## 샌드박스 제약

문서화돼 있지 않고 실행해 보고 확인한 것들이다.

| 제약 | 결과 |
|---|---|
| `window`, `document` 가 없다 | DOM 은 JSX 와 ref 로만 접근한다. 전역 키 리스너를 걸 수 없어 캔버스가 포커스를 쥐어야 조작된다 |
| 마운트를 넘어 사는 전역이 없다 | 상태를 전역에 두면 동작하지 않는다 |
| 자동재생 금지 | 소리는 사용자 조작 안에서만 시작할 수 있다 |
| 소스 정적 스캔 | 차단 대상 API 이름은 코드에도 주석에도 쓸 수 없다 |
| 에디터가 LF 큰 파일을 손상시킨다 | 등록용 파일은 CRLF 로 내보낸다 |

브라우저 쪽 제약도 하나 있다. `Ctrl` 을 조작에 쓸 수 없다. DOOM 기본 설정은
Ctrl 이 발사인데 전진이 `W` 라 둘을 같이 누르면 Ctrl+W, 즉 탭 닫기가 된다.
Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+R 은 브라우저 예약 단축키라 `preventDefault` 로
막을 수 없다.

## 템플릿과 생성물

`DoomGame.jsx` 가 원본이고 `FreedoomGame.jsx` 는 `build-doom-jsx.cjs` 가
생성한다. 차이는 함수 이름, WAD 조각 개수와 배선, 주석 두 줄뿐이고 엔진 wasm 은
바이트 단위로 같다. 이름과 조각 개수가 전부 빌드 인자에서 나오므로 생성물을
손으로 고칠 일이 없다.
