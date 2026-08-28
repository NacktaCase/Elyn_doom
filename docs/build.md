# 빌드와 검증

Node 18 이상이 필요하다. wasm 을 다시 빌드하려면
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34 가 추가로 필요하다.

```bash
export WASI_SDK=/path/to/wasi-sdk-34.0
```

기본값은 `~/wasi-sdk-34.0-x86_64-windows` 다.

## Freedoom 판

```bash
node tools/fetch-wad.cjs --freedoom
node tools/build-doom-wasm.cjs
node tools/build-wad.cjs doom/vendor/freedoom1.wad E1 doom/build/freedoom-e1.wad --sound
node tools/build-doom-jsx.cjs --name Freedoom --wad doom/build/freedoom-e1.wad --parts 5
node tools/doom-selftest.cjs  --name Freedoom --wad doom/build/freedoom-e1.wad
node tools/export-doom.cjs    --name Freedoom
```

| 단계 | 결과 |
|---|---|
| `fetch-wad --freedoom` | `doom/vendor/freedoom1.wad` (28 MB) |
| `build-doom-wasm` | `doom/build/doom-Oz.wasm` (423 KB) |
| `build-wad ... --sound` | `doom/build/freedoom-e1.wad` (E1 만 남긴 WAD) |
| `build-doom-jsx` | `doom/FreedoomGame.jsx` + `FreedoomWad1~5.jsx` |
| `doom-selftest` | 검증만 한다. 통과하지 못하면 다음으로 가지 않는다 |
| `export-doom` | `dist-freedoom/` (주석 제거, CRLF) |

Freedoom Phase 1 은 28 MB 라 전부 실을 수 없어 에피소드 1 만 뽑는다. 그 결과
엔진은 에피소드가 하나뿐인 IWAD 로 인식한다. 메뉴에 에피소드 1 만 나오고 없는
에피소드를 고를 수 없다.

## 셰어웨어 DOOM 판

컴포넌트 이름이 `DoomGame`, `DoomWad1~2` 라 Freedoom 판과 함께 등록할 수 있다.

```bash
node tools/fetch-wad.cjs
node tools/build-wad.cjs doom/vendor/doom1.wad E1M1 doom/build/doom.wad --whole
node tools/build-doom-jsx.cjs
node tools/doom-selftest.cjs
node tools/export-doom.cjs
```

`--whole` 을 쓴다. 셰어웨어 IWAD 는 변형 없이 통째로만 재배포할 수 있어
프루닝하지 않는다. `build-wad.cjs` 는 셰어웨어 해시를 확인하면 프루닝을
거부한다. 원본이 작아서 9판을 전부 실어도 2.60 MiB 다.

알려진 문제: 셰어웨어에는 플라스마, BFG, 슈퍼샷건 그래픽이 없다. `IDKFA` 치트로
받은 뒤 그 무기를 고르면 `R_DrawPSprite` 의 RANGECHECK 에 걸려 죽는다. 치트를
쓰지 않으면 닿지 않는다.

## 검증

### npm test

```bash
npm test                                # = node tools/doom-smoke.cjs
node tools/doom-smoke.cjs --ticks 1200  # 어트랙트 루프까지
```

`dist-freedoom/` 에서 엔진과 WAD 를 꺼내 부팅시킨다. 빌드 산출물이 필요 없어
클론한 그대로 돌고, CI 가 이걸 돌린다. 대신 주입된 데이터가 원본과 같은지는
확인하지 않는다.

검사 항목은 네 가지다.

| 절 | 내용 |
|---|---|
| A | 중복 선언, 선언되지 않은 이름 |
| B | Game 이 부르는 조각 수와 실제 파일 수 |
| C | gzip 해제, wasm 매직과 IWAD 헤더 |
| D | `doom-boot.cjs` 로 실제 부팅 |

### doom-selftest

```bash
node tools/doom-selftest.cjs
node tools/doom-selftest.cjs --dist
node tools/doom-selftest.cjs --name Freedoom --wad doom/build/freedoom-e1.wad
```

주입된 base64 를 꺼내 부팅시키고, 데이터가 원본과 바이트 단위로 같은지,
스프라이트 프레임이 빠지지 않았는지, 차단 대상 API 이름이 섞이지 않았는지
확인한다. 원본과 대조하므로 `doom/build/` 의 빌드 산출물이 있어야 한다.

`--dist` 는 주석을 제거한 등록용 사본을 검사한다. 주석 제거도 변환이므로
검증 대상에 포함한다.

### doom-boot

```bash
node tools/doom-boot.cjs 1200 --wad doom/build/freedoom-e1.wad
```

wasm 을 Node 에서 부팅시켜 프레임이 나오는지 본다. 틱을 넉넉히 주면 타이틀
화면을 지나 데모 어트랙트 루프까지 돈다. 프루닝 관련 문제는 여기서 잡힌다
([payload.md](payload.md#프루닝) 참고).

### 정적 검사

`.jsx` 는 Node 가 파싱하지 못하므로 JSX 구간은 정적 검사만 한다.

```bash
node tools/check-dupe-decl.cjs doom/DoomGame.jsx    # 중복 선언
node tools/check-undeclared.cjs doom/DoomGame.jsx   # 선언되지 않은 이름
```

브라우저에서만 재현되는 문제는 개발용 페이지로 확인한다.

```bash
node doom/devtest/server.cjs   # http://localhost:8099
```

## 도구 목록

| 도구 | 용도 |
|---|---|
| `fetch-wad.cjs` | IWAD 다운로드, md5 확인 |
| `build-doom-wasm.cjs` | wasm 빌드. `--O2` 로 최적화 수준 변경 |
| `build-wad.cjs` | WAD 프루닝. `--whole`, `--sound`, `--intermission` |
| `build-doom-jsx.cjs` | 컴포넌트에 데이터 주입. `--name`, `--wad`, `--parts` |
| `export-doom.cjs` | 등록용 사본 생성. `--keep-comments` |
| `doom-smoke.cjs` | 배포본만으로 부팅 확인 |
| `doom-selftest.cjs` | 원본과 대조하는 전체 검증 |
| `doom-boot.cjs` | Node 에서 부팅. `--wasm`, `--wad` |
| `doom-bench.cjs` | 틱, 블릿, 음악 비용 측정 |
| `wad-info.cjs` | WAD 럼프 분류와 용량 집계. `--lumps`, `--map` |
| `doom-info.cjs` | vendor 소스에서 스프라이트 의존 관계 추출 |
| `doom-warp-test.cjs` | 레벨 전환 조사 |
| `doom-death-test.cjs` | 죽음, 종료 경로 조사 |
