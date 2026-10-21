const fs = require("node:fs");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const shell = read("shell.html");
if (!shell.includes("/* APP_STYLES */") || !shell.includes("/* APP_SCRIPT */")) throw new Error("Missing build markers");
const configPath = path.join(__dirname, "cloud-config.json");
const config = fs.existsSync(configPath) ? JSON.stringify(JSON.parse(read("cloud-config.json"))).replace(/</g, "\\u003c") : "null";
const index = shell.replace("/* APP_STYLES */", () => read("styles.css")).replace("/* CLOUD_CONFIG */", () => config).replace("/* APP_SCRIPT */", () => `${read("board-format.js")}\n${read("github-store.js")}\n${read("app.js")}`);
fs.writeFileSync(path.join(__dirname, "index.html"), index);
const pagesPath = path.join(__dirname, "campaign-pages.json");
if (fs.existsSync(pagesPath)) {
  const format = require("./board-format.js");
  for (const { filename, payload } of JSON.parse(read("campaign-pages.json"))) {
    if (!/^campaign-(kyoto-[123]|hanashizuku-[12])\.html$/.test(filename)) throw new Error("Invalid campaign page filename.");
    format.validate(payload.state, new Map(payload.assets));
    const page = index
      .replace(/(<script id="portable-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + JSON.stringify(payload).replace(/</g, "\\u003c") + close)
      .replace(/(<script id="portable-options" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"memoryOnly":true,"remoteOriginals":true}$2')
      .replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, "$1null$2");
    fs.writeFileSync(path.join(__dirname, filename), page);
  }
}
console.log("Built standalone index.html (no external runtime assets).");
