# 라이선스

## 코드 — GPL-2.0

이 저장소의 코드는 **GPL-2.0** 이다. [doomgeneric](https://github.com/ozkl/doomgeneric)
과 [chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의 파생물이므로
같은 조건을 따른다.

`dist-freedoom/FreedoomGame.jsx` 에는 컴파일된 엔진이 base64 로 들어 있다.
**GPL 바이너리 배포**라는 뜻이고, 그래서 대응 소스(`doom/vendor/` · `doom/src/` ·
`tools/`)가 같은 저장소에 함께 있어야 한다. 지우면 안 된다.

## 게임 데이터 — Freedoom 과 셰어웨어

게임 데이터는 둘의 처지가 달라 다르게 다룬다.

### Freedoom (BSD-3-Clause)

깎아도 되고 고쳐도 된다. [프루닝과 데모 교체](payload.md#프루너)가 허용되는 건
그래서고, 같은 이유로 **`dist-freedoom/` 는 이 저장소에 실제로 커밋돼 있다** —
gzip+base64 로 실은 프루닝판 게임 데이터라 "바이너리 형태 재배포"에 해당하고,
BSD 조건(저작권 고지 동봉·이름으로 보증 금지)이 걸리는데
[`dist-freedoom/COPYING-FREEDOOM.txt`](../dist-freedoom/COPYING-FREEDOOM.txt)
가 그 고지를 동봉한다.

원본 `freedoom1.wad`(28 MB, 미가공)는 담지 않고 `tools/fetch-wad.cjs --freedoom`
로 받는다.

### 셰어웨어 IWAD (id Software)

id Software 의 것이고 **완전하고 변형되지 않은 형태로만** 재배포할 수 있다.
그래서 이 저장소는 그 판단이 필요 없도록 아예 담지 않고, `tools/fetch-wad.cjs`
가 받아와 md5 로 확인한다.

`tools/build-wad.cjs` 는 셰어웨어 해시를 알아보면 프루닝을 **거부한다.**
타이틀 화면의 고지("PROVIDED BY id FREE OF CHARGE · SUGGESTED RETAIL PRICE
$9.00")가 보이도록 `-warp` 로 게임에 바로 들어가지도 않는다.

## 생성물을 커밋하는 기준

`doom/` 안의 `FreedoomGame.jsx` · `FreedoomWad*.jsx` · `DoomWad*.jsx` 는
생성물이라 커밋하지 않는다. `dist-freedoom/` 만 예외로 담는데, 위의 BSD 조건
때문에 담을 수 있고, 담아두면 28 MB WAD 를 새로 받지 않고도 결과물을 볼 수 있다.

저장소는 다른 파일처럼 LF 로 담긴다(`.gitattributes`). Elyn 에 붙여넣을 CRLF
판은 `node tools/export-doom.cjs --name Freedoom` 로 따로 뽑는다.
