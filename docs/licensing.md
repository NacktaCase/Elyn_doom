# 라이선스

## 코드

GPL-2.0. [doomgeneric](https://github.com/ozkl/doomgeneric) 과
[chocolate-doom](https://github.com/chocolate-doom/chocolate-doom) 의 파생물이라
같은 조건을 따른다.

`dist-freedoom/FreedoomGame.jsx` 에는 컴파일된 엔진이 base64 로 들어 있다.
GPL 바이너리 배포에 해당하므로 대응 소스가 같은 저장소에 있어야 한다.
`doom/vendor/`, `doom/src/`, `tools/` 가 그 소스이고 지우면 안 된다.

## 게임 데이터

Freedoom 과 셰어웨어 IWAD 는 조건이 달라 다르게 다룬다.

| | Freedoom | 셰어웨어 IWAD |
|---|---|---|
| 라이선스 | BSD-3-Clause | id Software 사유 |
| 수정 | 가능 | 불가 |
| 재배포 | 고지 동봉 시 가능 | 완전하고 변형되지 않은 형태만 |
| 저장소 포함 | `dist-freedoom/` 에 포함 | 포함하지 않음 |
| 원본 WAD | `fetch-wad.cjs --freedoom` | `fetch-wad.cjs` |

### Freedoom

수정이 가능하므로 프루닝과 데모 교체를 한다([payload.md](payload.md#프루닝)).
같은 이유로 `dist-freedoom/` 을 저장소에 포함한다. gzip+base64 로 실은 프루닝판
게임 데이터라 바이너리 재배포에 해당하고, BSD 조건인 저작권 고지 동봉과 이름
사용 제한이 적용된다. 고지는
[`dist-freedoom/COPYING-FREEDOOM.txt`](../dist-freedoom/COPYING-FREEDOOM.txt)
에 동봉했다.

원본 `freedoom1.wad`(28 MB)는 포함하지 않는다.

### 셰어웨어 IWAD

변형 없이 통째로만 재배포할 수 있다. 저장소에 담지 않고 `fetch-wad.cjs` 가
받아와 md5 로 확인한다. `build-wad.cjs` 는 셰어웨어 해시를 확인하면 프루닝을
거부한다.

타이틀 화면의 고지("PROVIDED BY id FREE OF CHARGE · SUGGESTED RETAIL PRICE
$9.00")가 보이도록 `-warp` 로 게임에 바로 진입하지 않는다.

## 생성물 커밋 기준

`doom/` 안의 `FreedoomGame.jsx`, `FreedoomWad*.jsx`, `DoomWad*.jsx` 는 생성물이라
커밋하지 않는다. `dist-freedoom/` 만 예외로 커밋한다. 위의 BSD 조건 때문에
가능하고, 커밋해 두면 28 MB WAD 를 받지 않고도 결과물을 확인할 수 있다.

저장소는 다른 파일과 마찬가지로 LF 로 담는다(`.gitattributes`). Elyn 에 등록할
CRLF 판은 `node tools/export-doom.cjs --name Freedoom` 으로 따로 만든다.
