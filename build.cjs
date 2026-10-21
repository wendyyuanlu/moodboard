const fs = require("node:fs");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const shell = read("shell.html");
if (!shell.includes("/* APP_STYLES */") || !shell.includes("/* APP_SCRIPT */")) throw new Error("Missing build markers");
fs.writeFileSync(path.join(__dirname, "index.html"), shell.replace("/* APP_STYLES */", () => read("styles.css")).replace("/* APP_SCRIPT */", () => read("app.js")));
console.log("Built standalone index.html (no external runtime assets).");
