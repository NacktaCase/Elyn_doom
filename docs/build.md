# 빌드와 검증

필요한 것: Node 18+, [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34.

```bash
export WASI_SDK=/path/to/wasi-sdk-34.0          # 기본값: ~/wasi-sdk-34.0-x86_64-windows
```

## Freedoom 판 (기본)

```bash
node tools/fetch-wad.cjs --freedoom             # Freedoom Phase 1 (28 MB)
node tools/build-doom-wasm.cjs                  # → doom/build/doom-Oz.wasm
node tools/build-wad.cjs doom/vendor/freedoom1.wad E1 doom/build/freedoom-e1.wad --sound
node tools/build-doom-jsx.cjs --name Freedoom --wad doom/build/freedoom-e1.wad --parts 5
node tools/doom-selftest.cjs  --name Freedoom --wad doom/build/freedoom-e1.wad
node tools/export-doom.cjs    --name Freedoom   # → dist-freedoom/ (CRLF)
```

Freedoom 은 셰어웨어가 아니라 **에피소드 1 만 있는 것처럼** 감지된다
(E2M1 이 없으므로). 메뉴에 에피소드 1 만 나오고, 없는 에피소드를 고를 길이
없어 그 경로로는 죽지 않는다.

Phase 1 은 통째로 28 MB 라 gzip 해도 base64 로 15 MB 가 넘는다. 그래서
**에피소드 1 만 뽑는다** — 자세한 건 [payload.md](payload.md).

## 셰어웨어 DOOM 판

에셋을 id Software 의 셰어웨어 IWAD 로 바꿔 한 벌 더 만들 수 있다. 이름이
달라(`DoomGame` · `DoomWad1`‥`2`) Freedoom 판과 **함께 등록해 둘 수 있다.**

```bash
node tools/fetch-wad.cjs                        # 셰어웨어 WAD (md5 검증)
node tools/build-wad.cjs doom/vendor/doom1.wad E1M1 doom/build/doom.wad --whole
node tools/build-doom-jsx.cjs
node tools/doom-selftest.cjs
node tools/export-doom.cjs                      # → dist-doom/ (CRLF)
```

`--whole` 인 것에 주의. 셰어웨어는 **변형 없이 통째로만** 재배포할 수 있어서
프루닝하지 않는다 — `build-wad.cjs` 가 셰어웨어 해시를 알아보면 프루닝을
아예 거부한다. 대신 원본이 작아서 아홉 판을 통째로 싣고도 2.60 MiB 다.

셰어웨어에는 플라스마·BFG·슈퍼샷건 그래픽이 없다. `IDKFA` 로 받아서 그 무기를
고르면 `R_DrawPSprite` 의 RANGECHECK 에 걸려 죽는다. 치트를 안 쓰면 닿지 않는다.

## 검증

```bash
node tools/doom-selftest.cjs                              # 저장소본 (셰어웨어)
node tools/doom-selftest.cjs --dist                       # 업로드본 (주석 제거 후)
node tools/doom-selftest.cjs --name Freedoom --wad doom/build/freedoom-e1.wad
node tools/doom-boot.cjs 1200 --wad doom/build/freedoom-e1.wad   # 실제로 부팅시킨다
```

`doom-selftest` 는 **주입된 base64 를 꺼내 실제로 DOOM 을 부팅**시킨다. 데이터가
원본과 바이트 동일한지, 스프라이트 프레임이 빠지지 않았는지, Elyn 이 막는 API
이름이 섞이지 않았는지도 본다.

`doom-boot` 에 틱 수를 넉넉히 주면 타이틀 화면을 지나 어트랙트 루프까지 돈다 —
[프루너의 데모 버그](payload.md#프루너가-타이틀-화면을-몰랐다)가 잡히는 곳이 거기다.

`.jsx` 는 Node 가 파싱하지 못하므로 JSX 구간은 정적 검사만 한다
(`check-dupe-decl.cjs` · `check-undeclared.cjs`). 브라우저에서만 나는 문제는
`doom/devtest/` 로 잡는다:

```bash
node doom/devtest/server.cjs   # http://localhost:8099
```
