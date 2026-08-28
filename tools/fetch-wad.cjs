// 셰어웨어 DOOM IWAD 를 받아온다.
//
//   node tools/fetch-wad.cjs
//
// ── 왜 저장소에 안 넣는가 ────────────────────────────────────────────
// 셰어웨어 라이선스는 "완전하고 변형되지 않은" 무료 재배포를 허용한다.
// 우리가 다시 배포해도 되긴 하지만, **받아오면 그 판단 자체가 필요 없다.**
// 저장소도 4 MB 가벼워진다.
//
// ── md5 가 진짜 보증이다 ─────────────────────────────────────────────
// 어느 미러에서 받든 **바이트가 정본과 같은지**가 유일하게 중요한 것이다.
// 그래서 받은 뒤 반드시 대조하고, 다르면 지운다. 엉뚱한 WAD 로 빌드하면
// 라이선스도 어긋나고(변형본 배포) 게임도 어떻게 될지 모른다.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "doom", "vendor", "doom1.wad");

// DOOM 셰어웨어 v1.9 의 정본 해시.
const WANT_MD5 = "f0cefca49926d00903cf57551d901abe";
const WANT_SIZE = 4196020;

// 순서대로 시도한다. 앞엣것이 정본 커뮤니티 아카이브다.
const SOURCES = [
  { url: "https://www.doomworld.com/3ddownloads/ports/shareware_doom_iwad.zip", zip: true },
  { url: "https://github.com/Akbar30Bill/DOOM_wads/raw/master/doom1.wad", zip: false },
];

function get(url, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error("리다이렉트가 너무 많다"));
    https.get(url, { headers: { "User-Agent": "doom-elyn-fetch" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), (depth || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// zip 에서 첫 번째 .wad 를 꺼낸다. 라이브러리를 끌어오지 않으려고 직접 읽는다 —
// 항목이 하나뿐인 단순한 zip 이라 중앙 디렉터리만 훑으면 된다.
function extractWadFromZip(buf) {
  // End of Central Directory 를 뒤에서 찾는다 (시그니처 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 의 끝을 못 찾았다");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);   // 중앙 디렉터리 시작

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("중앙 디렉터리가 깨졌다");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("ascii", p + 46, p + 46 + nameLen);

    if (/\.wad$/i.test(name)) {
      // 로컬 헤더에서 실제 데이터 위치를 계산한다(이름·extra 길이가 다를 수 있다).
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("로컬 헤더가 깨졌다");
      const lnLen = buf.readUInt16LE(localOff + 26);
      const leLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw;                       // 저장
      if (method === 8) return zlib.inflateRawSync(raw);   // deflate
      throw new Error("모르는 압축 방식: " + method);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error("zip 안에 .wad 가 없다");
}

(async () => {
  if (fs.existsSync(OUT)) {
    const have = fs.readFileSync(OUT);
    const md5 = crypto.createHash("md5").update(have).digest("hex");
    if (md5 === WANT_MD5) {
      console.log("이미 있다: " + path.relative(ROOT, OUT) + "  (md5 확인됨)");
      return;
    }
    console.log("있는 파일의 md5 가 다르다. 다시 받는다.");
  }

  let wad = null;
  for (const src of SOURCES) {
    try {
      process.stdout.write("받는 중: " + src.url + " … ");
      const buf = await get(src.url);
      const got = src.zip ? extractWadFromZip(buf) : buf;
      const md5 = crypto.createHash("md5").update(got).digest("hex");
      if (md5 !== WANT_MD5) {
        console.log("md5 불일치 (" + md5 + ")");
        continue;
      }
      console.log("ok");
      wad = got;
      break;
    } catch (e) {
      console.log("실패 — " + (e && e.message ? e.message : e));
    }
  }

  if (!wad) {
    console.error("");
    console.error("셰어웨어 doom1.wad 를 받지 못했다.");
    console.error("직접 구해 doom/vendor/doom1.wad 에 두어도 된다.");
    console.error("  크기 " + WANT_SIZE + " 바이트 · md5 " + WANT_MD5);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, wad);
  console.log("");
  console.log("→ " + path.relative(ROOT, OUT) + "  " + wad.length + " 바이트");
  console.log("  md5 " + WANT_MD5 + "  (DOOM 셰어웨어 v1.9 정본)");
  console.log("");
  console.log("셰어웨어는 **변형 없이 통째로** 재배포할 수 있다.");
  console.log("tools/build-wad.cjs 가 이 해시를 알아보고 프루닝을 막는다.");
})();
