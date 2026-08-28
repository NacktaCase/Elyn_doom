# DOOM for Elyn

**채팅창 안에서 도는 진짜 DOOM.**

[Elyn](https://elyn.app) 은 AI 캐릭터 채팅 서비스인데, 대화 중에 커스텀 React
컴포넌트를 띄울 수 있다. 그 컴포넌트 하나에 DOOM 을 통째로 집어넣었다 —
셰어웨어 아홉 판, 원곡, 전체 효과음까지.

```
<DoomGame />
```

- **E1M1 ~ E1M9** — 셰어웨어 전편, 타이틀 화면과 데모 어트랙트 루프까지 그대로
- **소리** — OPL2 FM 합성 음악과 효과음 (원본 사운드블래스터가 내던 그 소리다)
- **약 2.6 MiB** — 컴포넌트 세 개. 서버도, 외부 요청도, 저장소도 쓰지 않는다
- **게임 데이터는 이 저장소에 없다** — 빌드할 때 받아온다

## 어떻게 돌아가나

`doomgeneric`(chocolate-doom 이식판)을 **wasi-sdk 로 wasm32 에 직접** 빌드하고,
엔진과 WAD 를 gzip → base64 로 컴포넌트 소스에 실어 런타임에 푼다.
브라우저가 `DecompressionStream` 을 갖고 있어서 압축 해제기를 따로 안 실어도 된다.

```
DoomGame.jsx    엔진 wasm (230 KB) + WASI shim + Web Audio + React 배선
DoomWad1.jsx    WAD 조각 1
DoomWad2.jsx    WAD 조각 2
```

WAD 를 쪼개는 건 용량 때문이 아니다. 페이로드는 어차피 합계로 계산된다 —
**에디터가 큰 붙여넣기에서 조용히 데이터를 망가뜨리기 때문**에 검증된 크기로 끊는다.

### Emscripten 을 쓰지 않는 이유

보통 웹으로 DOOM 을 옮기면 Emscripten 을 쓴다. 여기서는 못 쓴다.

1. Elyn 컴포넌트는 `function 이름() { ... }` 하나에 전부 들어가야 해서 glue
   모듈을 `import` 할 수 없다.
2. **Elyn 은 컴포넌트 소스를 정적으로 스캔해 등록을 막는다.** 위험한 API 이름이
   보이면 거부하는데, **호출인지 `typeof` 존재 확인인지 가리지 않고 주석까지
   소스로 본다.** Emscripten glue 에는 네트워크·URL·파일 계열 이름이 수십 개
   박혀 있다.

wasi-sdk 로 빌드하면 glue 가 없으니 걸릴 이름이 애초에 안 생긴다. 남는 import 는
WASI 표준 15개와 우리 것 5개(`js_now_ms`, `js_snd_*`)뿐이다.

### 샌드박스가 걸어둔 제약들

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

화면을 한 번 클릭해야 조작이 시작된다.

## 빌드

필요한 것: Node 18+, [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34.

```bash
export WASI_SDK=/path/to/wasi-sdk-34.0          # 기본값: ~/wasi-sdk-34.0-x86_64-windows

node tools/fetch-wad.cjs                        # 셰어웨어 WAD (md5 검증)
node tools/build-doom-wasm.cjs                  # → doom/build/doom-Oz.wasm
node tools/build-wad.cjs doom/vendor/doom1.wad E1M1 doom/build/doom.wad --whole
node tools/build-doom-jsx.cjs                   # 컴포넌트에 주입
node tools/doom-selftest.cjs                    # 검증
node tools/export-doom.cjs                      # → dist-doom/ (CRLF)
```

`dist-doom/` 의 세 파일을 Elyn 에 각각 등록한다. 이름은 `DoomGame` ·
`DoomWad1` · `DoomWad2` 여야 한다 — 레지스트리가 평면 전역이라 하나라도 빠지면
화면이 로딩 단계에서 멈춘다.

## 구조

```
doom/
  DoomGame.jsx           컴포넌트. <<...>> 블록은 생성물이다
  src/
    doomgeneric_wasm.c     플랫폼 6함수 · 종료 감지
    w_file_memory.c        WAD 를 메모리에서 읽는다     ← w_file_stdc.c 대체
    i_sound_wasm.c         사운드, SDL 없이             ← i_sound.c 대체
    opl_wasm.c             OPL2/3 백엔드                ← opl.c + opl_sdl.c 대체
    opl_compat.h           chocolate 소스를 doomgeneric 헤더에 맞추는 어댑터
    wasi-shim.js           WASI preview1 + 인메모리 파일시스템
    audio.js               Web Audio (효과음 + OPL 음악 스트리밍)
  devtest/               브라우저에서 재현하기 위한 개발용 페이지
  vendor/                doomgeneric · chocolate-doom OPL (둘 다 GPL-2.0)
tools/                   빌드 · 주입 · 검증
```

**vendor 는 한 줄도 고치지 않는다.** 바꿔야 하는 파일은 *대체*한다 — 빌드에서
원본을 빼고 우리 것을 넣는 방식이다. 딱 한 곳만 예외인데, `d_main.c` 의 잘못된
함수 포인터 캐스팅(`(atexit_func_t) G_CheckDemoStatus` — 실제로는 `boolean` 을
반환한다)은 wasm 에서 간접 호출 시 트랩을 낸다. 그건 컴파일 시 이름 치환으로
우회한다.

## 검증

```bash
node tools/doom-selftest.cjs          # 저장소본
node tools/doom-selftest.cjs --dist   # 업로드본 (주석 제거 후)
node tools/doom-boot.cjs              # Node WASI 에서 실제로 부팅시킨다
```

`doom-selftest` 는 **주입된 base64 를 꺼내 실제로 DOOM 을 부팅**시킨다. 데이터가
원본과 바이트 동일한지, 스프라이트 프레임이 빠지지 않았는지, Elyn 이 막는 API
이름이 섞이지 않았는지도 본다.

`.jsx` 는 Node 가 파싱하지 못하므로 JSX 구간은 정적 검사만 한다
(`check-dupe-decl.cjs` · `check-undeclared.cjs`). 브라우저에서만 나는 문제는
`doom/devtest/` 로 잡는다:

```bash
node doom/devtest/server.cjs   # http://localhost:8099
```

## 라이선스

이 저장소의 코드는 **GPL-2.0** 이다. [doomgeneric](https://github.com/ozkl/doomgeneric)
과 [chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의 파생물이므로
같은 조건을 따른다.

**DOOM 게임 데이터는 여기 없다.** `tools/fetch-wad.cjs` 가 받아오고 md5 로 정본인지
확인한다. 셰어웨어 IWAD 는 id Software 의 것이고 **완전하고 변형되지 않은 형태로만**
재배포할 수 있어서, 이 저장소는 그 판단이 필요 없도록 아예 담지 않는다.
같은 이유로:

- `tools/build-wad.cjs` 는 셰어웨어 해시를 알아보면 프루닝을 **거부한다**
- 타이틀 화면의 고지("PROVIDED BY id FREE OF CHARGE · SUGGESTED RETAIL PRICE
  $9.00")가 보이도록 `-warp` 로 게임에 바로 들어가지 않는다

자유 배포 에셋으로 쓰고 싶으면 [Freedoom](https://freedoom.github.io/)(BSD) 을
쓸 수 있다. 그쪽은 프루닝이 허용되므로 맵 하나만 남기는 옵션들이 살아 있다.
