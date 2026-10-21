const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const files = new Set(["index.html", "sw.js", "icon.svg", "manifest.webmanifest"]);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const filename = url.pathname.endsWith("/") ? "index.html" : url.pathname.split("/").at(-1);
  if (!files.has(filename)) { response.writeHead(404); response.end("Not found"); return; }
  fs.readFile(path.join(__dirname, filename), (error, data) => {
    if (error) { console.error(error); response.writeHead(500); response.end("Could not read file"); return; }
    response.writeHead(200, { "Content-Type": types[path.extname(filename)], "Cache-Control": "no-store" }); response.end(data);
  });
});
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 8085), "127.0.0.1", () => console.log(`moodboard: http://localhost:${server.address().port}`));
