# DOOM for Elyn

**채팅창 안에서 도는 진짜 DOOM.**

[Elyn](https://elyn.app) 은 AI 캐릭터 채팅 서비스인데, 대화 중에 커스텀 React
컴포넌트를 띄울 수 있다. 그 컴포넌트 하나에 DOOM 을 통째로 집어넣었다 —
아홉 판, 음악, 전체 효과음, 타이틀 화면과 데모 어트랙트 루프까지.

```
<FreedoomGame />
```

- **E1M1 ~ E1M9** — [Freedoom](https://freedoom.github.io/) Phase 1 의 에피소드 1 전편
- **소리** — OPL2 FM 합성 음악과 효과음 (원본 사운드블래스터가 내던 그 소리다)
- **서버가 없다** — 외부 요청도, 저장소도, 워커도 안 쓴다. 컴포넌트 소스가 전부다
- **게임 데이터가 저장소에 들어 있다** — Freedoom 은 BSD 라 실어둘 수 있다
- **셰어웨어 DOOM 판**도 뽑을 수 있다. 이름이 달라 둘을 함께 등록해 둔다

## 등록

컴포넌트 여섯 개를 Elyn 에 각각 등록한다. 이름은 `FreedoomGame` ·
`FreedoomWad1`‥`FreedoomWad5` **여야 한다** — 레지스트리가 평면 전역이라
하나라도 빠지거나 이름이 다르면 화면이 로딩 단계에서 멈춘다.

붙여넣을 소스는 [`dist-freedoom/`](dist-freedoom/) 에 있다. 그대로 복사해 넣으면 된다.

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

## 어떻게 돌아가나

`doomgeneric`(chocolate-doom 이식판)을 **wasi-sdk 로 wasm32 에 직접** 빌드하고,
엔진과 WAD 를 gzip → base64 로 컴포넌트 소스에 실어 런타임에 푼다.

```
FreedoomGame.jsx      엔진 wasm (230 KB) + WASI shim + Web Audio + React 배선
FreedoomWad1‥5.jsx    WAD 조각 다섯
```

Emscripten 을 쓰지 않는 이유, 샌드박스가 실제로 걸어둔 제약, WAD 를 다섯으로
쪼개는 이유는 [docs/design.md](docs/design.md) 에 있다.

## 빌드

필요한 것: Node 18+, [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34.

```bash
export WASI_SDK=/path/to/wasi-sdk-34.0
node tools/fetch-wad.cjs --freedoom
node tools/build-doom-wasm.cjs
node tools/build-wad.cjs doom/vendor/freedoom1.wad E1 doom/build/freedoom-e1.wad --sound
node tools/build-doom-jsx.cjs --name Freedoom --wad doom/build/freedoom-e1.wad --parts 5
node tools/doom-selftest.cjs  --name Freedoom --wad doom/build/freedoom-e1.wad
node tools/export-doom.cjs    --name Freedoom
```

셰어웨어 판 빌드와 검증 도구는 [docs/build.md](docs/build.md), 페이로드가
안 올라갈 때 줄이는 순서는 [docs/payload.md](docs/payload.md).

## 구조

```
doom/
  DoomGame.jsx    컴포넌트 원본. FreedoomGame.jsx 는 이걸 템플릿으로 생성된다
  src/            wasm 플랫폼 계층 · WASI shim · Web Audio (vendor 대체본)
  devtest/        브라우저에서 재현하기 위한 개발용 페이지
  vendor/         doomgeneric · chocolate-doom OPL (둘 다 GPL-2.0, 손대지 않는다)
tools/            빌드 · 주입 · 검증
dist-freedoom/    붙여넣기용 Freedoom 판 (생성물이지만 커밋한다)
docs/             설계 결정과 실기에서 드러난 함정들
```

## 라이선스

**GPL-2.0.** [doomgeneric](https://github.com/ozkl/doomgeneric) 과
[chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의 파생물이다.

`dist-freedoom/FreedoomGame.jsx` 에 컴파일된 엔진이 base64 로 들어 있어 **GPL
바이너리 배포**에 해당한다. 대응 소스(`doom/vendor/` · `doom/src/` · `tools/`)가
같은 저장소에 함께 있어야 하니 **지우면 안 된다.**

게임 데이터는 Freedoom(BSD-3-Clause)과 셰어웨어 IWAD(id Software)의 처지가
달라 다르게 다룬다 — [docs/licensing.md](docs/licensing.md).
