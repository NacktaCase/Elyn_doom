# DOOM for Elyn

Elyn 채팅 컴포넌트 하나에서 도는 DOOM.

[Elyn](https://elyn.app) 은 대화 중에 커스텀 React 컴포넌트를 띄울 수 있다.
그 컴포넌트 안에 DOOM 엔진과 게임 데이터를 전부 넣었다. 서버, 외부 요청,
워커를 쓰지 않는다.

- [Freedoom](https://freedoom.github.io/) Phase 1 에피소드 1 (E1M1 ~ E1M9)
- OPL2 FM 합성 음악과 효과음
- 타이틀 화면, 메뉴, 데모 어트랙트 루프
- 컴포넌트 6개, 합계 5.96 MiB

셰어웨어 DOOM 판도 만들 수 있다. 컴포넌트 이름이 달라 두 판을 함께 등록할 수
있다. 자세한 건 [docs/build.md](docs/build.md).

## 설치

`dist-freedoom/` 의 파일 6개를 Elyn 에 각각 등록한다.

| 파일 | 컴포넌트 이름 |
|---|---|
| `FreedoomGame.jsx` | `FreedoomGame` |
| `FreedoomWad1.jsx` ~ `FreedoomWad5.jsx` | `FreedoomWad1` ~ `FreedoomWad5` |

이름이 정확해야 한다. 컴포넌트 레지스트리가 평면 전역이라 하나라도 빠지거나
이름이 다르면 로딩 단계에서 멈춘다.

등록한 뒤 대화에서 이렇게 쓴다.

```
<FreedoomGame />
```

## 조작

| 키 | 동작 |
|---|---|
| `←` `→` | 회전 |
| `↑` `↓` / `W` `S` | 전진, 후진 |
| `A` `D` | 좌우 이동 |
| `Space` | 발사 |
| `E` | 문, 스위치 |
| `Shift` | 달리기 |
| `1` ~ `7` | 무기 선택 |
| `Esc` / `Enter` | 메뉴 |
| `` ` `` | 소리 켜기, 끄기 |

화면을 한 번 클릭해야 키 입력이 들어간다. 샌드박스에 `window` 가 없어 전역 키
리스너를 걸 수 없고, 캔버스가 포커스를 쥔 동안에만 이벤트가 온다.

소리는 처음에 꺼져 있다. 브라우저 자동재생 정책 때문에 사용자 조작 안에서만
오디오를 시작할 수 있어서, 버튼이나 `` ` `` 키로 켠다.

## 동작 방식

1. `doomgeneric`(chocolate-doom 포크)을 wasi-sdk 로 wasm32 에 빌드한다.
2. wasm 과 WAD 를 gzip 으로 압축해 base64 로 컴포넌트 소스에 넣는다.
3. 실행하면 `DecompressionStream` 으로 풀어 `WebAssembly.instantiate` 한다.
4. WASI shim 이 파일 입출력을 메모리에서 처리한다.
5. 프레임버퍼를 canvas 에 그리고, Web Audio 로 효과음과 음악을 낸다.

| 파일 | 내용 |
|---|---|
| `FreedoomGame.jsx` | 엔진 wasm (base64 230 KB) + WASI shim + Web Audio + React 배선 |
| `FreedoomWad1.jsx` ~ `5.jsx` | WAD 를 다섯 조각으로 나눈 것 |

WAD 를 나누는 이유는 용량이 아니다. Elyn 에디터가 큰 붙여넣기에서 데이터를
망가뜨리는 일이 있어 검증된 크기로 끊는다.

Emscripten 을 쓰지 않는 이유와 샌드박스 제약은 [docs/design.md](docs/design.md)
에 정리했다.

## 확인

`dist-freedoom/` 에서 엔진과 WAD 를 꺼내 실제로 부팅시킨다. 빌드 도구 없이
클론한 그대로 돈다.

```bash
npm test
```

## 빌드

Node 18 이상과 [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34 가 필요하다.

```bash
export WASI_SDK=/path/to/wasi-sdk-34.0
node tools/fetch-wad.cjs --freedoom
node tools/build-doom-wasm.cjs
node tools/build-wad.cjs doom/vendor/freedoom1.wad E1 doom/build/freedoom-e1.wad --sound
node tools/build-doom-jsx.cjs --name Freedoom --wad doom/build/freedoom-e1.wad --parts 5
node tools/doom-selftest.cjs  --name Freedoom --wad doom/build/freedoom-e1.wad
node tools/export-doom.cjs    --name Freedoom
```

각 단계와 셰어웨어 판 빌드는 [docs/build.md](docs/build.md), 용량이 넘칠 때
줄이는 방법은 [docs/payload.md](docs/payload.md).

## 구조

```
doom/
  DoomGame.jsx    컴포넌트 원본. FreedoomGame.jsx 는 이걸 템플릿으로 생성한다
  src/            wasm 플랫폼 계층, WASI shim, Web Audio
  devtest/        브라우저에서 돌려보는 개발용 페이지
  vendor/         doomgeneric, chocolate-doom OPL (수정하지 않는다)
tools/            빌드, 주입, 검증 스크립트
dist-freedoom/    등록용 Freedoom 판
docs/             설계와 제약 문서
```

## 라이선스

GPL-2.0. [doomgeneric](https://github.com/ozkl/doomgeneric) 과
[chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의 파생물이다.

`dist-freedoom/FreedoomGame.jsx` 에 컴파일된 엔진이 들어 있어 GPL 바이너리
배포에 해당한다. 대응 소스인 `doom/vendor/`, `doom/src/`, `tools/` 가 같은
저장소에 있어야 하므로 지우면 안 된다.

게임 데이터는 Freedoom(BSD-3-Clause)과 셰어웨어 IWAD(id Software)의 조건이
달라 다르게 다룬다. [docs/licensing.md](docs/licensing.md) 참고.
