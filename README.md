# DOOM for Elyn

셰어웨어 DOOM 을 Elyn 샌드박스 안에서 돌리는 JSX 컴포넌트.
`doomgeneric` 을 **wasi-sdk 로 wasm32 에 직접 빌드**하고, WAD 와 엔진을
gzip + base64 로 컴포넌트에 실어 런타임에 푼다.

- E1M1 ~ E1M9 아홉 판, 원곡(OPL2 FM 합성)과 전체 효과음
- 업로드본 합계 **약 2.6 MiB** (컴포넌트 3개)
- Emscripten 을 쓰지 않는다 — glue 없이 `.wasm` 하나만 나온다

## 왜 Emscripten 이 아닌가

두 가지인데 두 번째가 이 프로젝트에 고유하다.

1. Elyn 컴포넌트는 `function 이름() { ... }` 하나에 전부 들어가야 해서
   glue 모듈을 `import` 할 수 없다.
2. **Elyn 은 컴포넌트 소스를 정적으로 스캔해 등록을 막는다.** 위험한 API
   이름이 보이면 거부하는데, **호출인지 `typeof` 존재 확인인지 가리지 않고
   주석도 소스로 본다.** Emscripten glue 에는 네트워크·URL·파일 계열 이름이
   수십 개 박혀 있어 그대로는 등록조차 안 될 공산이 크다.

wasi-sdk 로 빌드하면 glue 가 없으니 걸릴 이름이 애초에 안 생긴다.
남는 import 는 WASI 표준 15개와 우리 것 5개(`js_now_ms`, `js_snd_*`)뿐이다.

## 빌드

필요한 것: Node 18+, [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34.

```bash
# wasi-sdk 위치 (기본값: ~/wasi-sdk-34.0-x86_64-windows)
export WASI_SDK=/path/to/wasi-sdk-34.0

node tools/fetch-wad.cjs                                  # 셰어웨어 WAD (md5 검증)
node tools/build-doom-wasm.cjs                            # → doom/build/doom-Oz.wasm
node tools/build-wad.cjs doom/vendor/doom1.wad E1M1 \
     doom/build/doom.wad --whole                          # WAD 를 그대로 옮긴다
node tools/build-doom-jsx.cjs                             # 컴포넌트에 주입
node tools/doom-selftest.cjs                              # 검증
node tools/export-doom.cjs                                # → dist-doom/ (CRLF)
```

`dist-doom/` 의 세 파일을 Elyn 에 각각 등록하고 `<DoomGame />` 태그를 쓴다.
이름은 `DoomGame` · `DoomWad1` · `DoomWad2` 여야 한다 — 레지스트리가 평면
전역이라 하나라도 빠지면 화면이 로딩 단계에서 멈춘다.

## 조작

| 키 | |
|---|---|
| `←` `→` | 회전 |
| `↑` `↓` / `W` `S` | 전진·후진 |
| `A` `D` | 좌우 이동 |
| `Space` | 발사 |
| `E` | 문·스위치 |
| `Shift` | 달리기 |
| `1`~`7` | 무기 |
| `Esc` / `Enter` | 메뉴 |
| `` ` `` | 소리 켜기/끄기 |

**Ctrl 과 Alt 는 일부러 쓰지 않는다.** DOOM 기본은 Ctrl=발사인데 전진이
`W` 라 "쏘면서 전진"이 **Ctrl+W = 브라우저 탭 닫기**가 된다. Ctrl+W·T·N·R 은
브라우저가 예약한 단축키라 `preventDefault` 로 막을 수 없다.

화면을 클릭해야 조작된다. Elyn 에는 `window` 가 없어 전역 키 리스너를 걸 수
없고, React 합성 이벤트만 오기 때문이다 — 포커스를 잃으면 키가 끊긴다.

## 구조

```
doom/
  DoomGame.jsx        컴포넌트. <<...>> 블록은 생성물이다
  src/
    doomgeneric_wasm.c   플랫폼 6함수 + 종료 감지
    w_file_memory.c      WAD 를 메모리에서 읽는다 (w_file_stdc.c 대체)
    i_sound_wasm.c       사운드 (i_sound.c 대체, SDL 없이)
    opl_wasm.c           OPL 백엔드 (opl.c + opl_sdl.c 대체)
    opl_compat.h         chocolate 소스를 doomgeneric 헤더에 맞추는 어댑터
    wasi-shim.js         WASI preview1 최소 구현 + 인메모리 파일시스템
    audio.js             Web Audio 재생 (효과음 + OPL 음악 스트리밍)
  devtest/            브라우저에서 재현하기 위한 개발용 페이지
  vendor/             doomgeneric · chocolate-doom 의 OPL (둘 다 GPL-2.0)
tools/                빌드·주입·검증
```

**vendor 는 한 줄도 고치지 않는다.** 바꿔야 하는 파일은 *대체*한다 —
빌드에서 원본을 빼고 우리 것을 넣는 방식이다. 한 곳만 예외인데,
`d_main.c` 의 잘못된 함수 포인터 캐스팅은 컴파일 시 이름 치환으로 우회한다
(`doom/src/doomgeneric_wasm.c` 의 `DoomWasm_CheckDemoStatus` 주석 참조).

## 검증

```bash
node tools/doom-selftest.cjs          # 저장소본
node tools/doom-selftest.cjs --dist   # 업로드본 (주석 제거 후)
node tools/doom-boot.cjs              # Node WASI 에서 실제로 부팅시킨다
```

`doom-selftest` 는 **주입된 base64 를 꺼내 실제로 DOOM 을 부팅**시킨다.
데이터가 원본과 바이트 동일한지, 스프라이트 프레임이 빠지지 않았는지,
Elyn 이 막는 API 이름이 섞이지 않았는지도 본다.

`.jsx` 는 Node 가 파싱하지 못하므로 JSX 구간은 정적 검사만 한다
(`tools/check-dupe-decl.cjs`, `tools/check-undeclared.cjs`).

브라우저에서만 나는 문제는 `doom/devtest/` 로 잡는다:

```bash
node doom/devtest/server.cjs   # http://localhost:8099
```

## 라이선스

- 이 저장소의 코드: **GPL-2.0** (`LICENSE`)
  [doomgeneric](https://github.com/ozkl/doomgeneric) 과
  [chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의
  파생물이므로 같은 조건을 따른다.
- **DOOM 셰어웨어 데이터는 이 저장소에 없다.** `tools/fetch-wad.cjs` 가
  받아오고 md5 로 정본인지 확인한다. 셰어웨어 IWAD 는 id Software 의 것이고
  **완전하고 변형되지 않은 형태로만** 재배포할 수 있다.
  그래서 `tools/build-wad.cjs` 는 셰어웨어 해시를 알아보면 프루닝을 거부한다.
  타이틀 화면의 고지("PROVIDED BY id FREE OF CHARGE · SUGGESTED RETAIL
  PRICE $9.00")가 보이도록 `-warp` 로 게임에 바로 들어가지도 않는다.
- 자유 배포 에셋으로 쓰고 싶으면 [Freedoom](https://freedoom.github.io/)(BSD)
  을 쓸 수 있다. 그쪽은 프루닝이 허용되므로 `--sound` 등 프루너 옵션이 있다.
