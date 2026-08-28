// DOOM wasm 을 **실제 브라우저**에서 돌려보기 위한 최소 정적 서버.
//
//   node doom/devtest/server.cjs
//
// Node WASI 로는 멀쩡히 부팅하는데 Elyn 에서만 트랩이 난다. Elyn 에는 콘솔이
// 없어 원인을 볼 수 없으므로, 같은 코드를 브라우저에서 돌려 콘솔과 스택을
// 직접 본다. 이 폴더는 개발용이고 배포에는 안 들어간다.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wad": "application/octet-stream" };

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const map = {
    "/": path.join(__dirname, "index.html"),
    "/wasi-shim.js": path.join(ROOT, "doom", "src", "wasi-shim.js"),
    "/audio.js": path.join(ROOT, "doom", "src", "audio.js"),
    "/doom.wasm": path.join(ROOT, "doom", "build", "doom-Oz.wasm"),
    "/doom.wad": path.join(ROOT, "doom", "build", "doom.wad"),
  };
  const file = map[url];
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
  fs.createReadStream(file).pipe(res);
}).listen(8099, () => console.log("http://localhost:8099"));
