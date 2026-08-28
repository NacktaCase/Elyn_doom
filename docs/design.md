# 설계

Elyn 컴포넌트 하나에 DOOM 을 넣기 위해 내린 결정들과, 샌드박스가 실제로
걸어둔 제약들.

## 어떻게 돌아가나

`doomgeneric`(chocolate-doom 이식판)을 **wasi-sdk 로 wasm32 에 직접** 빌드하고,
엔진과 WAD 를 gzip → base64 로 컴포넌트 소스에 실어 런타임에 푼다.
브라우저가 `DecompressionStream` 을 갖고 있어서 압축 해제기를 따로 안 실어도 된다.

```
FreedoomGame.jsx      엔진 wasm (230 KB) + WASI shim + Web Audio + React 배선
FreedoomWad1‥5.jsx    WAD 조각 다섯
```

WAD 를 쪼개는 건 용량 때문이 아니다. 페이로드는 어차피 합계로 계산된다 —
**에디터가 큰 붙여넣기에서 조용히 데이터를 망가뜨리기 때문**에 검증된 크기로 끊는다.

## Emscripten 을 쓰지 않는 이유

보통 웹으로 DOOM 을 옮기면 Emscripten 을 쓴다. 여기서는 못 쓴다.

1. Elyn 컴포넌트는 `function 이름() { ... }` 하나에 전부 들어가야 해서 glue
   모듈을 `import` 할 수 없다.
2. **Elyn 은 컴포넌트 소스를 정적으로 스캔해 등록을 막는다.** 위험한 API 이름이
   보이면 거부하는데, **호출인지 `typeof` 존재 확인인지 가리지 않고 주석까지
   소스로 본다.** Emscripten glue 에는 네트워크·URL·파일 계열 이름이 수십 개
   박혀 있다.

wasi-sdk 로 빌드하면 glue 가 없으니 걸릴 이름이 애초에 안 생긴다. 남는 import 는
WASI 표준 17개와 우리 것 5개(`js_now_ms`, `js_snd_*`)뿐이다.
`build-doom-wasm.cjs` 가 빌드할 때마다 그 목록을 찍는다.

## 샌드박스가 걸어둔 제약들

만들면서 부딪힌 것들. 대부분은 문서에 없고 실기에서만 드러났다.

| 제약 | 대응 |
|---|---|
| `window` 도 `document` 도 없다 | DOM 은 JSX + ref 로만 얻는다. 전역 키 리스너를 못 걸어 **캔버스가 포커스를 쥐어야** 조작된다 |
| 마운트를 넘어 사는 전역이 없다 | 상태를 전역에 두는 설계는 조용히 무력화된다 |
| 자동재생 금지 | 소리는 버튼이나 `` ` `` 키로 **사용자 제스처 안에서** 켠다 |
| 정적 스캐너 | 위험한 API 이름은 코드에도 주석에도 쓰지 않는다 |
| 에디터가 LF 큰 파일을 망가뜨린다 | 업로드본은 CRLF 로 뽑는다 |

브라우저 쪽 함정도 있다. **`Ctrl` 을 조작에 쓰면 안 된다** — DOOM 기본은
Ctrl=발사인데 전진이 `W` 라 "쏘면서 전진"이 **Ctrl+W = 탭 닫기**가 된다.
Ctrl+W·T·N·R 은 브라우저가 예약한 단축키라 `preventDefault` 로 막을 수 없다.

## vendor 를 고치지 않는다

**vendor 는 한 줄도 고치지 않는다.** 바꿔야 하는 파일은 *대체*한다 — 빌드에서
원본을 빼고 우리 것을 넣는 방식이다. 딱 한 곳만 예외인데, `d_main.c` 의 잘못된
함수 포인터 캐스팅(`(atexit_func_t) G_CheckDemoStatus` — 실제로는 `boolean` 을
반환한다)은 wasm 에서 간접 호출 시 트랩을 낸다. 그건 컴파일 시 이름 치환으로
우회한다.

| 대체본 (`doom/src/`) | 대체 대상 |
|---|---|
| `doomgeneric_wasm.c` | 플랫폼 6함수 · 종료 감지 |
| `w_file_memory.c` | `w_file_stdc.c` — WAD 를 메모리에서 읽는다 |
| `i_sound_wasm.c` | `i_sound.c` — 사운드, SDL 없이 |
| `opl_wasm.c` | `opl.c` + `opl_sdl.c` — OPL2/3 백엔드 |

`opl_compat.h` 는 chocolate 소스를 doomgeneric 헤더에 맞추는 어댑터고,
`wasi-shim.js` 는 WASI preview1 + 인메모리 파일시스템, `audio.js` 는
Web Audio(효과음 + OPL 음악 스트리밍)다.

## 템플릿과 생성물

`DoomGame.jsx` 가 템플릿이고 `FreedoomGame.jsx` 는 거기서 **생성**된다.
둘의 차이는 다섯 군데뿐이다 — 함수 이름, 운반체 개수와 배선, 주석 두 줄.
**엔진 wasm 은 바이트 단위로 같다.** 컴포넌트 이름·운반체 개수·배선이 전부
빌드 인자에서 나오므로 손으로 고칠 곳이 없다.
