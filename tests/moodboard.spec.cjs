const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
}
async function png(page, width = 120, height = 80, color = "#b6c1a0") {
  const data = await page.evaluate(({ width, height, color }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height, color });
  return Buffer.from(data, "base64");
}
function file(name, buffer) { return { name, mimeType: "image/png", buffer }; }
async function upload(page, names, buffer) {
  await page.locator("#image-files").setInputFiles(names.map((name) => file(name, buffer)));
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
}
async function paste(page, names, buffer, html = "") {
  await page.evaluate(({ names, bytes, html }) => {
    const transfer = new DataTransfer();
    if (html) transfer.setData("text/html", html);
    for (const name of names) transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { names, bytes: [...buffer], html });
}
async function titles(page) { return page.locator(".card-caption h3").allTextContents(); }
async function saveDialog(page) {
  await page.locator("#editor-submit").click();
  await expect(page.locator("#editor")).not.toBeVisible();
}
async function editTab(page) {
  await page.locator(".tab[aria-current=true]").dblclick();
  await expect(page.locator("#editor")).toBeVisible();
}
function tabTitle(page) { return page.locator(".tab[aria-current=true] .tab-name"); }
async function newSection(page, name) {
  await page.locator("#bottom-add").click();
  await page.locator("#editor [name=name]").fill(name);
  await saveDialog(page);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const id = await read("meta", "active"), record = await read("boards", id);
    const assets = [];
    for (const [key, asset] of record.assets) assets.push([key, { ...asset, bytes: [...new Uint8Array(await asset.blob.arrayBuffer())], blob: null }]);
    db.close(); return { state: record.state, assets };
  });
}

async function sharedHarness(browser, fixture) {
  const { createGitHubStore } = require("../github-store.js");
  const { mockGitHub } = require("./helpers/mock-github.cjs");
  const remote = mockGitHub(), contexts = [];
  const seed = createGitHubStore({ owner: "example", repo: "moodboard" }, { initialToken: "test-only-token", fetchImpl: remote.fetchImpl });
  await seed.write(null, fixture);
  const initialSaves = remote.history.length;
  const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const config = { site: "http://127.0.0.1:8085/", owner: "example", repo: "moodboard", branch: "board", collection: "test/shared-board" };
  const html = source.replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(config)}$2`);
  async function connect(context) {
    await context.route("http://127.0.0.1:8085/", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await context.route(/^https:\/\/(?:api\.github\.com\/repos\/example\/moodboard|raw\.githubusercontent\.com\/example\/moodboard\/(?:board|[a-f0-9]{40}))(?:\/|$)/, async (route) => {
      const request = route.request(), headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-GitHub-Api-Version", "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      const response = await remote.fetchImpl(request.url(), { method: request.method(), headers: { Authorization: request.headers().authorization }, body: request.postData() });
      await route.fulfill({ status: response.status, headers: { ...headers, "Content-Type": response.headers.get("Content-Type") || "application/octet-stream" }, body: Buffer.from(await response.arrayBuffer()) });
    });
  }
  async function open(options = {}) {
    const { authenticated = false, ...browserOptions } = options;
    const context = await browser.newContext({ serviceWorkers: "block", ...browserOptions }); contexts.push(context);
    await connect(context);
    const page = await context.newPage(); await page.goto("http://127.0.0.1:8085/");
    await expect(page.locator("#save-status")).toHaveText("Saved to GitHub");
    if (authenticated) await authenticateShared(page);
    return { page, context };
  }
  return { open, connect, corruptOriginal: () => { const path = [...remote.files.keys()].find((path) => path.startsWith("images/")); remote.blobs.set(remote.files.get(path), Buffer.from("not the original")); },
    get writes() { return remote.history.slice(initialSaves).map((head) => remote.packageAt(head)); },
    get record() { return remote.packageAt(); }, close: () => Promise.all(contexts.map((context) => context.close())) };
}
async function authenticateShared(page) {
  await page.locator("#more").click();
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await page.locator("[name=githubToken]").fill("test-only-token"); await saveDialog(page);
  await expect(page.locator("#save-status")).toHaveText("Saved to GitHub");
}
async function sharedFixture(page) {
  await ready(page); const bytes = await png(page, 120, 80);
  await upload(page, ["shared-original.png"], bytes);
  const saved = await snapshot(page);
  return { bytes, board: { format: "moodboard", version: 1, state: saved.state, assets: saved.assets.map(([id, asset]) => [id, {
    name: asset.name, width: asset.width, height: asset.height, data: `data:image/png;base64,${Buffer.from(asset.bytes).toString("base64")}`
  }]) } };
}

test("rapid paste positions, original bytes, full-size viewer and portable offline HTML", async ({ page, browser }, testInfo) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const buffer = await png(page, 1920, 1080);
  await upload(page, ["A.png", "B.png"], buffer);
  await expect(page.locator(".image-card")).toHaveCount(2);
  await expect(page.locator(".card-caption").first()).toBeHidden();
  await expect(page.locator(".card-caption h3").first()).toBeHidden();
  await expect(page.locator(".card-meta").first()).toBeHidden();
  await expect(page.locator(".source-missing")).toHaveCount(0);
  await expect(page.locator(".card-caption h3").first()).toHaveText("A.png");
  await expect(page.locator(".card-meta").first()).toContainText("1920 × 1080");
  await page.getByRole("button", { name: "Paste before B.png", exact: true }).click();
  await paste(page, ["C.png", "D.png"], buffer);
  await paste(page, ["E.png"], buffer);
  await expect.poll(() => titles(page)).toEqual(["A.png", "C.png", "D.png", "E.png", "B.png"]);
  await page.locator("#more").click();
  await page.getByRole("button", { name: "Append at bottom", exact: true }).click();
  await paste(page, ["F.png"], buffer);
  await expect.poll(() => titles(page)).toEqual(["A.png", "C.png", "D.png", "E.png", "B.png", "F.png"]);
  const saved = await snapshot(page);
  for (const [, asset] of saved.assets) {
    expect(Buffer.from(asset.bytes).equals(buffer)).toBe(true);
    expect([asset.width, asset.height]).toEqual([1920, 1080]);
  }
  await page.getByRole("button", { name: "Open original image: A.png", exact: true }).click();
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#viewer-image")).toHaveJSProperty("naturalWidth", 1920);
  await page.locator("#viewer-next").click();
  await expect(page.locator("#viewer-title")).toHaveText("C.png");
  await page.locator("#viewer-zoom").click();
  await expect(page.locator("#viewer-stage")).toHaveClass("actual");
  await expect(page.locator("#viewer-image")).toHaveJSProperty("clientWidth", 1920);
  await page.locator("#viewer-close").click();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#save-portable").click();
  const download = await downloadEvent;
  const portablePath = testInfo.outputPath("portable.html");
  await download.saveAs(portablePath);
  const source = fs.readFileSync(portablePath, "utf8");
  const payload = JSON.parse(source.match(/<script id="portable-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  expect(payload.state.tabs[0].sections[0].items.map((item) => item.title)).toEqual(await titles(page));
  expect(Buffer.from(payload.assets[0][1].data.split(",")[1], "base64").equals(buffer)).toBe(true);
  expect(source).not.toContain("blob:http");
  expect(source).not.toContain('rel="manifest"');
  const offline = await browser.newContext({ offline: true });
  const offlinePage = await offline.newPage();
  await offlinePage.goto(pathToFileURL(portablePath).href);
  await expect(offlinePage.locator(".image-card")).toHaveCount(6);
  await expect(offlinePage.locator(".image-hit img").first()).toHaveJSProperty("naturalWidth", 1920);
  await offlinePage.reload();
  await expect(offlinePage.locator(".image-card")).toHaveCount(6);
  await offline.close();
  await page.reload();
  await expect(page.locator(".image-card")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("tabs and sections rename, duplicate, reorder, move, collapse and delete", async ({ page }) => {
  await ready(page);
  await upload(page, ["original.png"], await png(page));
  await editTab(page);
  await page.getByRole("button", { name: "Duplicate tab", exact: true }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".image-card")).toHaveCount(1);
  await editTab(page);
  await page.locator("#editor [name=name]").fill("Travel");
  await page.locator("#editor [name=position]").fill("1");
  await saveDialog(page);
  await expect(page.locator(".tab").first()).toContainText("Travel");
  await newSection(page, "To organize");
  await page.getByRole("button", { name: "Edit section The little things", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate section", exact: true }).click();
  await expect(page.locator(".section")).toHaveCount(3);
  await page.getByRole("button", { name: "Edit section The little things (copy)", exact: true }).click();
  await page.locator("#editor [name=name]").fill("Favorites");
  await page.locator("#editor [name=position]").fill("1");
  await saveDialog(page);
  await expect(page.locator(".section-toggle strong").first()).toHaveText("Favorites");
  await page.locator(".section-toggle").first().click();
  await expect(page.locator(".section").first()).toHaveClass(/collapsed/);
  await page.reload();
  await expect(page.locator(".section").first()).toHaveClass(/collapsed/);
  await page.getByRole("button", { name: "Edit section Favorites", exact: true }).click();
  await page.locator("#editor [name=tab]").selectOption({ label: "My inspiration" });
  await saveDialog(page);
  await expect(tabTitle(page)).toHaveText("My inspiration");
  await expect(page.locator(".section")).toHaveCount(2);
  await page.getByRole("button", { name: "Edit section Favorites", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#editor-delete").click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".section")).toHaveCount(1);
  await editTab(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#editor-delete").click();
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(tabTitle(page)).toHaveText("Travel");
  expect((await snapshot(page)).assets).toHaveLength(1);
});

test("bulk copy/move, keyboard copy, image editing and edit-off protection", async ({ page }) => {
  await ready(page); const buffer = await png(page);
  await upload(page, ["A.png", "B.png", "C.png"], buffer);
  await newSection(page, "Favorites");
  await page.getByRole("checkbox", { name: "Select A.png", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select B.png", exact: true }).check();
  await page.locator("#copy-selected").click();
  await page.locator("#editor [name=section]").selectOption({ label: "My inspiration / Favorites" });
  await saveDialog(page);
  await expect(page.locator(".image-card")).toHaveCount(5);
  expect((await snapshot(page)).assets).toHaveLength(3);
  await page.locator(".section").first().getByRole("checkbox", { name: "Select A.png", exact: true }).check();
  await page.locator(".section").first().getByRole("checkbox", { name: "Select C.png", exact: true }).check();
  await page.locator("#move-selected").click();
  await page.locator("#editor [name=section]").selectOption({ label: "My inspiration / Favorites" });
  await page.locator("#editor [name=position]").fill("1"); await saveDialog(page);
  await expect.poll(() => page.locator(".section").last().locator("h3").allTextContents()).toEqual(["A.png", "C.png", "A.png", "B.png"]);
  await page.locator(".section").first().getByRole("button", { name: "Edit image B.png", exact: true }).click();
  await page.locator("#editor [name=title]").fill("A calmer morning");
  await page.locator("#editor [name=notes]").fill("Keep this feeling.");
  await saveDialog(page);
  await expect(page.locator(".section").first().locator("h3")).toHaveText("A calmer morning");
  await page.locator("#edit-toggle").click();
  await expect(page.locator("#edit-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".select-image").first()).not.toBeVisible();
  await paste(page, ["blocked.png"], buffer);
  await expect(page.locator(".image-card")).toHaveCount(5);
  await page.getByRole("button", { name: "Open original image: A calmer morning", exact: true }).click();
  await expect(page.locator("#viewer")).toBeVisible(); await page.locator("#viewer-close").click();
  await page.reload(); await expect(page.locator("#edit-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("checkbox", { name: "Select A calmer morning", exact: true }).check();
  await page.evaluate(() => {
    const data = new DataTransfer();
    document.body.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".image-card")).toHaveCount(6);
  await page.locator("#select-all").click();
  await expect(page.locator("#selection-count")).toHaveText("6 selected");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-selected").click();
  await expect(page.locator(".image-card")).toHaveCount(0);
  expect((await snapshot(page)).assets).toHaveLength(0);
});

test("mouse hold-drag reorders groups and rectangle selects multiple images", async ({ page }) => {
  await ready(page); await upload(page, ["A.png", "B.png", "C.png", "D.png"], await png(page));
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.getByRole("checkbox", { name: "Select A.png", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select B.png", exact: true }).check();
  const grip = await page.getByRole("button", { name: "Drag A.png", exact: true }).boundingBox();
  await page.mouse.move(grip.x + 10, grip.y + 10); await page.mouse.down(); await page.waitForTimeout(250);
  await expect(page.locator("#drag-preview")).toBeVisible();
  await page.getByRole("button", { name: "Paste before D.png", exact: true }).evaluate((node) => node.scrollIntoView({ block: "center" }));
  const target = await page.getByRole("button", { name: "Paste before D.png", exact: true }).boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await expect(page.locator(".drop-target")).toBeVisible();
  await page.waitForTimeout(100); await page.mouse.up();
  await expect.poll(() => titles(page)).toEqual(["C.png", "A.png", "B.png", "D.png"]);
  await page.locator("#clear-selection").click();
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.locator(".images")).toHaveAttribute("data-layout", "grid");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.locator(".image-card").first().scrollIntoViewIfNeeded();
  const cards = await page.locator(".image-card").all();
  const r1 = await cards[0].boundingBox(), r2 = await cards[1].boundingBox();
  await page.mouse.move(r2.x + r2.width + 5, r1.y + 10);
  await page.mouse.down();
  await page.mouse.move(r1.x + 2, Math.max(r1.y + r1.height, r2.y + r2.height) - 5, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#selection-bar")).toBeVisible();
  const checked = await page.locator(".select-image:checked").count();
  expect(checked).toBeGreaterThanOrEqual(2);
});

test("mobile layouts and zoom are responsive; touch hold-drag and swipe viewer", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await page.goto("http://127.0.0.1:8085/");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await upload(page, ["portrait.png", "landscape.png", "third.png"], await png(page, 90, 150));
  for (const layout of ["grid", "list", "masonry"]) {
    await page.locator(`button[data-layout=${layout}]`).click();
    await expect(page.locator(".images")).toHaveAttribute("data-layout", layout);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator("#zoom").evaluate((input) => {
    input.value = "100"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await snapshot(page)).state.settings.zoom).toBe(100);
  await page.locator("button[data-layout=list]").click();
  await expect(page.locator(".images")).toHaveAttribute("data-layout", "list");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  const handle = page.getByRole("button", { name: "Drag portrait.png", exact: true });
  await handle.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const h = await handle.boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: h.x + 12, y: h.y + 12 }] });
  await page.waitForTimeout(300);
  await expect(page.locator("#drag-preview")).toBeVisible();
  const target = page.getByRole("button", { name: "Paste before third.png", exact: true });
  const t = await target.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x + 20, y: Math.min(780, t.y + 10) }] });
  await page.waitForTimeout(150);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => titles(page)).toEqual(["landscape.png", "portrait.png", "third.png"]);
  await page.getByRole("button", { name: "Open original image: landscape.png", exact: true }).tap();
  await expect(page.locator("#viewer")).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 320, y: 400 }] });
  await page.waitForTimeout(80);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100, y: 405 }] });
  await page.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("#viewer-title")).toHaveText("portrait.png");
  await page.waitForTimeout(350);
  await page.locator("#viewer-close").tap();
  await expect(page.locator("#viewer")).not.toBeVisible();
  const image = page.getByRole("button", { name: "Open original image: third.png", exact: true });
  await image.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const rect = await image.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + 50, y: rect.y + 35 }] });
  await page.waitForTimeout(520);
  await expect(page.locator("#drag-preview")).toBeVisible();
  const beforeControl = page.getByRole("button", { name: "Paste before landscape.png", exact: true });
  await beforeControl.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const before = await beforeControl.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: before.x + 30, y: before.y + 10 }] });
  await page.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => titles(page)).toEqual(["third.png", "landscape.png", "portrait.png"]);
  await context.close();
});

test("hosted installation reloads offline, backup round-trip and malformed import are safe", async ({ page, context }, testInfo) => {
  await ready(page); const buffer = await png(page, 300, 500);
  await upload(page, ["offline.png"], buffer);
  await expect(page.locator("#connection-status")).toHaveText("Offline ready", { timeout: 20000 });
  await context.setOffline(true); await page.reload();
  await expect(page.locator(".image-card")).toHaveCount(1);
  await expect(page.locator(".image-hit img")).toHaveJSProperty("naturalHeight", 500);
  await newSection(page, "On the plane");
  await page.locator("#more").click();
  const event = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
  const backup = await event, output = testInfo.outputPath("backup.json"); await backup.saveAs(output);
  const data = JSON.parse(fs.readFileSync(output, "utf8"));
  expect(crypto.createHash("sha256").update(Buffer.from(data.assets[0][1].data.split(",")[1], "base64")).digest("hex")).toEqual(crypto.createHash("sha256").update(buffer).digest("hex"));
  await page.locator("#backup-file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"format":"wrong"}') });
  await expect(page.locator("#notice")).toContainText("Import failed");
  await expect(page.locator(".image-card")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles(output);
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".image-card")).toHaveCount(1);
  await expect(page.locator(".section")).toHaveCount(2);
  const saved = await snapshot(page);
  expect(Buffer.from(saved.assets[0][1].bytes).equals(buffer)).toBe(true);
  await page.reload(); await expect(page.locator(".section")).toHaveCount(2);
});

test("a stale window cannot overwrite a newer save", async ({ page, context }) => {
  await ready(page);
  const second = await context.newPage(); await second.goto("/");
  await expect(second.locator("#save-status")).toHaveText("Saved on this device");
  await newSection(page, "Newest save");
  await second.locator("#bottom-add").click();
  await second.locator("#editor [name=name]").fill("Stale save");
  await second.locator("#editor-submit").click();
  await expect(second.locator("#editor-error")).toContainText("changed in another window");
  await page.reload();
  await expect(page.locator(".section")).toHaveCount(2);
  await expect(page.locator(".section-toggle strong").last()).toHaveText("Newest save");
});

test("dragging across tabs moves originals and keeps the source collection intact", async ({ page }) => {
  await ready(page); await upload(page, ["A.png", "B.png"], await png(page));
  await editTab(page);
  await page.getByRole("button", { name: "Duplicate tab", exact: true }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
  await page.locator(".tab").first().click();
  await expect(tabTitle(page)).toHaveText("My inspiration");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.getByRole("checkbox", { name: "Select A.png", exact: true }).check();
  const source = await page.getByRole("button", { name: "Drag A.png", exact: true }).boundingBox();
  await page.mouse.move(source.x + 10, source.y + 10); await page.mouse.down(); await page.waitForTimeout(200);
  await expect(page.locator("#drag-preview")).toBeVisible();
  await page.locator(".tab").last().evaluate((node) => node.scrollIntoView({ block: "center" }));
  const tab = await page.locator(".tab").last().boundingBox();
  await page.mouse.move(tab.x + 20, tab.y + 15, { steps: 8 });
  await expect(tabTitle(page)).toHaveText("My inspiration (copy)");
  await page.getByRole("button", { name: "Paste at end of The little things", exact: true }).evaluate((node) => node.scrollIntoView({ block: "center" }));
  const target = await page.getByRole("button", { name: "Paste at end of The little things", exact: true }).boundingBox();
  await page.mouse.move(target.x + 20, target.y + 15, { steps: 8 });
  await page.waitForTimeout(100); await page.mouse.up();
  await expect(page.locator(".image-card")).toHaveCount(3);
  await page.locator(".tab").first().click();
  await expect.poll(() => titles(page)).toEqual(["B.png"]);
  expect((await snapshot(page)).assets).toHaveLength(2);
});

test("responsive layout has no page overflow and paste does not hijack text inputs", async ({ page }, testInfo) => {
  await ready(page); const buffer = await png(page, 300, 420);
  await upload(page, ["First idea.png", "Second idea.png", "Third idea.png", "Fourth idea.png"], buffer);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const layout of ["masonry", "grid", "list"]) {
      await page.locator(`button[data-layout=${layout}]`).click();
      await expect(page.locator(".images")).toHaveAttribute("data-layout", layout);
      const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((node) => node.getBoundingClientRect().right > innerWidth + 1).map((node) => ({ tag: node.tagName, id: node.id, className: node.className, right: node.getBoundingClientRect().right })));
      expect(await page.evaluate(() => document.documentElement.scrollWidth), JSON.stringify(overflow)).toBeLessThanOrEqual(width);
    }
  }
  await page.locator("button[data-layout=masonry]").click();
  await expect(page.locator(".images")).toHaveAttribute("data-layout", "masonry");
  await expect.poll(() => page.locator(".image-card").evaluateAll((cards) => new Set(cards.map((card) => Math.round(card.getBoundingClientRect().x))).size)).toBe(4);
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit image First idea.png", exact: true }).click();
  await page.locator("#editor [name=title]").focus();
  await page.locator("#editor [name=title]").evaluate((input, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "not-an-image-add.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, [...buffer]);
  await expect(page.locator(".image-card")).toHaveCount(4);
  await page.locator("#editor [name=title]").fill('</script><script>window.injected=true</script>');
  await saveDialog(page);
  const event = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const download = await event; const output = testInfo.outputPath("escaped.html"); await download.saveAs(output);
  const source = fs.readFileSync(output, "utf8");
  expect(source).not.toContain('</script><script>window.injected=true</script>');
  expect(source).toContain("\\u003c/script>");
});

test("portable export works without local storage and failed saves leave the board unchanged", async ({ browser, page }) => {
  const memoryContext = await browser.newContext();
  await memoryContext.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { value: { open() { throw new Error("Storage disabled for test"); } } });
  });
  const memoryPage = await memoryContext.newPage(); await memoryPage.goto("http://127.0.0.1:8085/");
  await expect(memoryPage.locator("#save-status")).toHaveText("Export to keep changes");
  await expect(memoryPage.locator("#storage-warning")).toContainText("MUST Save portable copy");
  const bytes = await png(memoryPage);
  await memoryPage.locator("#image-files").setInputFiles([file("memory-only.png", bytes)]);
  await expect(memoryPage.locator(".image-card")).toHaveCount(1);
  const downloadEvent = memoryPage.waitForEvent("download");
  await memoryPage.locator("#save-portable").click();
  const download = await downloadEvent; expect(await download.failure()).toBeNull();
  await memoryContext.close();
  await ready(page);
  await upload(page, ["safe.png"], bytes);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    };
  });
  await paste(page, ["must-not-appear.png"], bytes);
  await expect(page.locator("#notice")).toContainText("Could not save");
  await expect.poll(() => titles(page)).toEqual(["safe.png"]);
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(["safe.png"]);
});

test("hover-only desktop checkboxes and masonry fill horizontally across the entire board", async ({ page }) => {
  await ready(page);
  const landscape = await png(page, 400, 200), portrait = await png(page, 200, 400);
  await page.locator("#image-files").setInputFiles([file("one.png", landscape), file("two.png", portrait), file("three.png", landscape), file("four.png", portrait)]);
  await expect(page.locator(".image-card")).toHaveCount(4);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.mouse.move(0, 0);
  const first = page.locator(".image-card").first(), check = first.locator(".select-image");
  await expect(check).toHaveCSS("opacity", "0");
  await first.hover(); await expect(check).toHaveCSS("opacity", "1");
  await check.check(); await page.mouse.move(0, 0);
  await expect(check).toHaveCSS("opacity", "1");
  await expect(page.locator(".image-card").nth(1).locator(".select-image")).toHaveCSS("opacity", "0");
  await expect.poll(async () => page.locator(".images").evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    const cards = [...container.querySelectorAll(".image-card")].map((card) => card.getBoundingClientRect());
    return Math.abs(cards.at(-1).right - bounds.right) < 2 && cards.every((card) => Math.abs(card.top - cards[0].top) < 2);
  })).toBe(true);
  await page.locator("#zoom").evaluate((slider) => {
    slider.value = "420"; slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(() => page.locator(".image-card").evaluateAll((cards) => new Set(cards.map((card) => Math.round(card.getBoundingClientRect().x))).size)).toBe(2);
  await page.locator("#zoom").evaluate((slider) => slider.dispatchEvent(new Event("change", { bubbles: true })));
  await expect.poll(async () => (await snapshot(page)).state.settings.zoom).toBe(420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("pasted source pages appear below images, open separately, and can be corrected", async ({ page, context }) => {
  await ready(page); const buffer = await png(page);
  const requests = [];
  await context.route("https://provenance.test/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Original inspiration page</title>" });
  });
  const source = "https://provenance.test/ideas/quiet-room?color=green&shape=arch";
  await paste(page, ["linked.png"], buffer, `Version:1.0\r\nSourceURL:${source}\r\n<html><body><img src="https://provenance.test/image.png" onerror="window.clipboardExecuted=true"></body></html>`);
  await expect(page.locator(".source-link")).toHaveText(source);
  await expect(page.locator(".source-link")).toHaveAttribute("href", source);
  await expect(page.locator(".source-link")).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.locator(".source-link").evaluate((link) => link.closest("button"))).toBeNull();
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => window.clipboardExecuted)).toBeUndefined();
  const popupEvent = page.waitForEvent("popup"); await page.locator(".source-link").click();
  const popup = await popupEvent; await popup.waitForLoadState();
  expect(popup.url()).toBe(source); await popup.close();
  await expect(page.locator("#viewer")).not.toBeVisible();
  await paste(page, ["screenshot.png"], buffer, '<a href="https://provenance.test/not-necessarily-the-source"><img src="https://provenance.test/direct-image.png"></a>');
  await expect(page.locator(".image-card")).toHaveCount(2);
  await expect(page.locator(".source-missing")).toHaveCount(0);
  await page.getByRole("button", { name: "Open original image: linked.png", exact: true }).click();
  await expect(page.locator("#viewer-source")).toBeVisible();
  await expect(page.locator("#viewer-source")).toHaveAttribute("href", source);
  await page.locator("#viewer-next").click();
  await expect(page.locator("#viewer-source")).toBeHidden();
  await expect(page.locator("#viewer-source")).not.toHaveAttribute("href");
  await page.locator("#viewer-close").click();
  await page.getByRole("button", { name: "Edit image screenshot.png", exact: true }).click();
  await page.locator("#editor [name=sourceUrl]").fill("javascript:alert(1)");
  await page.locator("#editor-submit").click();
  await expect(page.locator("#editor-error")).toContainText("HTTP or HTTPS");
  await page.locator("#editor [name=sourceUrl]").fill("https://provenance.test/manual-source");
  await saveDialog(page);
  await expect(page.locator(".source-link").last()).toHaveAttribute("href", "https://provenance.test/manual-source");
  await page.reload();
  await expect(page.locator(".source-link")).toHaveCount(2);
  const saved = await snapshot(page);
  expect(saved.state.tabs[0].sections[0].items.map((item) => item.sourceUrl)).toEqual([source, "https://provenance.test/manual-source"]);
  expect(requests).toEqual([source]);
});

test("Paste button reads explicit page metadata but rejects unsafe or inferred page links", async ({ page }) => {
  await ready(page); const buffer = await png(page);
  await page.evaluate((bytes) => {
    const image = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      read: async () => [
        new ClipboardItem({ "image/png": image }),
        new ClipboardItem({ "text/html": new Blob(['<link rel="canonical" href="https://example.test/original-page?one=1&amp;two=2"><img src="https://example.test/not-the-page.png">'], { type: "text/html" }) })
      ]
    } });
  }, [...buffer]);
  await page.locator("#more").click();
  await page.getByRole("button", { name: "Paste images", exact: true }).click();
  await expect(page.locator(".source-link")).toHaveAttribute("href", "https://example.test/original-page?one=1&two=2");
  await paste(page, ["open-graph.png"], buffer, '<meta property="og:url" content="https://example.test/og-page"><img src="https://example.test/picture.png">');
  await expect(page.locator(".source-link").last()).toHaveAttribute("href", "https://example.test/og-page");
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///C:/private/file.html", "https://user:password@example.test/page"]) {
    await paste(page, [`unsafe-${url.split(":")[0]}.png`], buffer, `SourceURL:${url}\r\n<link rel="canonical" href="${url}"><script>window.clipboardExecuted=true</script>`);
  }
  await expect(page.locator(".image-card")).toHaveCount(6);
  await expect(page.locator(".source-missing")).toHaveCount(0);
  expect(await page.evaluate(() => window.clipboardExecuted)).toBeUndefined();
  const saved = await snapshot(page);
  expect(saved.state.tabs[0].sections[0].items.slice(2).every((item) => item.sourceUrl === "")).toBe(true);
});

test("source URLs survive duplication, JSON transfer, offline portable HTML, and legacy backups", async ({ page, browser }, testInfo) => {
  await ready(page); const buffer = await png(page);
  const url = "https://example.test/original-page";
  await paste(page, ["source.png"], buffer, `SourceURL:${url}\r\n<img src="https://example.test/photo.png">`);
  await expect(page.locator(".source-link")).toHaveAttribute("href", url);
  await editTab(page);
  await page.getByRole("button", { name: "Duplicate tab", exact: true }).click();
  await expect(page.locator(".source-link")).toHaveAttribute("href", url);
  const htmlEvent = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const htmlDownload = await htmlEvent, htmlPath = testInfo.outputPath("source-portable.html"); await htmlDownload.saveAs(htmlPath);
  const offline = await browser.newContext({ offline: true }); const offlinePage = await offline.newPage();
  await offlinePage.goto(pathToFileURL(htmlPath).href);
  await expect(offlinePage.locator(".source-link")).toHaveAttribute("href", url);
  await offline.close();
  await page.locator("#more").click();
  const jsonEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
  const jsonDownload = await jsonEvent, jsonPath = testInfo.outputPath("source-backup.json"); await jsonDownload.saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  expect(backup.state.tabs.every((tab) => tab.sections[0].items[0].sourceUrl === url)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles(jsonPath);
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".source-link")).toHaveAttribute("href", url);
  for (const tab of backup.state.tabs) for (const section of tab.sections) for (const item of section.items) delete item.sourceUrl;
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator(".source-missing")).toHaveCount(0);
  await expect(page.locator(".image-card")).toHaveCount(1);
  const saved = await snapshot(page);
  expect(Buffer.from(saved.assets[0][1].bytes).equals(buffer)).toBe(true);
});

test("each card has Move, Delete, Crop, More controls and deletion requires confirmation", async ({ page }) => {
  await ready(page); await upload(page, ["keep.png", "remove.png"], await png(page));
  const tools = page.locator(".image-card").last().locator(".card-tools");
  expect(await tools.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["Drag remove.png", "Delete image remove.png", "Crop image remove.png", "Edit image remove.png"]);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete image remove.png", exact: true }).click();
  await expect(page.locator(".image-card")).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete image remove.png", exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(["keep.png"]);
  await page.locator("#edit-toggle").click();
  await expect(page.getByRole("button", { name: "Delete image keep.png", exact: true })).toBeHidden();
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(["keep.png"]);
  expect((await snapshot(page)).assets).toHaveLength(1);
});

test("smaller checkboxes stay visible in Grid/List and section selection spans only represented sections", async ({ page, browser }) => {
  await ready(page);
  const bytes = await png(page);
  await upload(page, ["A.png", "B.png"], bytes);
  await newSection(page, "Second"); await upload(page, ["C.png", "D.png"], bytes);
  await newSection(page, "Unrelated"); await upload(page, ["E.png"], bytes);
  for (const layout of ["grid", "list"]) {
    await page.locator(`button[data-layout=${layout}]`).click();
    await expect(page.locator(".images").first()).toHaveAttribute("data-layout", layout);
    await page.mouse.move(0, 0);
    for (const check of await page.locator(".select-image").all()) {
      await expect(check).toHaveCSS("opacity", "1");
      const rect = await check.boundingBox(); expect(rect.width).toBeCloseTo(24 * .7, 1); expect(rect.height).toBeCloseTo(24 * .7, 1);
    }
  }
  await page.getByRole("checkbox", { name: "Select A.png", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select C.png", exact: true }).check();
  await page.getByRole("button", { name: "Select section", exact: true }).click();
  expect(await page.locator(".select-image:checked").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(["Select A.png", "Select B.png", "Select C.png", "Select D.png"]);
  await expect(page.locator("#select-all")).toHaveText("All");
  expect(await page.locator("#selection-bar button:not(#select-all)").evaluateAll((nodes) => nodes.every((node) => !node.textContent.trim() && node.getAttribute("aria-label") && node.title))).toBe(true);
  await page.locator("#select-all").click(); await expect(page.locator(".select-image:checked")).toHaveCount(5);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await mobile.newPage(); await ready(phone); await upload(phone, ["touch.png"], bytes);
  const check = await phone.locator(".select-image").boundingBox(); expect(check.width).toBeCloseTo(25 * .7, 1);
  expect((await phone.locator(".image-selection").boundingBox()).width).toBeGreaterThanOrEqual(44);
  await mobile.close();
});

test("quick drags from images and checkboxes select without opening viewer; additive and canceled drags preserve selection", async ({ page }) => {
  await ready(page); await upload(page, ["A.png", "B.png", "C.png", "D.png"], await png(page, 180, 180));
  await page.locator("button[data-layout=grid]").click();
  await expect(page.locator(".images")).toHaveAttribute("data-layout", "grid");
  const a = await page.locator(".image-hit").nth(0).boundingBox(), b = await page.locator(".image-hit").nth(1).boundingBox();
  await page.mouse.move(a.x + 45, a.y + 50); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await expect(page.locator("#rubber-band")).toBeVisible(); await page.mouse.up();
  await expect(page.locator(".select-image:checked")).toHaveCount(2);
  await expect(page.locator("#viewer")).not.toBeVisible();
  await page.locator("#clear-selection").click();
  await page.getByRole("checkbox", { name: "Select D.png", exact: true }).check();
  const check = await page.locator(".select-image").first().boundingBox();
  await page.keyboard.down("Control"); await page.mouse.move(check.x + 5, check.y + 5); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 70, { steps: 5 });
  await expect(page.locator(".select-image:checked")).toHaveCount(3);
  await page.keyboard.press("Escape"); await page.mouse.up(); await page.keyboard.up("Control");
  await expect(page.locator(".select-image:checked")).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Select D.png", exact: true })).toBeChecked();
  await page.keyboard.down("Control"); await page.mouse.move(check.x + 5, check.y + 5); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 70, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Control");
  await expect(page.locator(".select-image:checked")).toHaveCount(3);
  await expect(page.locator("#viewer")).not.toBeVisible();
});

test("selection drag auto-scrolls the page without selecting collapsed images", async ({ page }) => {
  await ready(page); const bytes = await png(page);
  await upload(page, ["hidden.png"], bytes); await page.locator(".section-toggle").first().click();
  await newSection(page, "Visible"); await upload(page, Array.from({ length: 12 }, (_, index) => `visible-${index}.png`), bytes);
  await page.locator("button[data-layout=list]").click(); await expect(page.locator(".images").last()).toHaveAttribute("data-layout", "list");
  await page.evaluate(() => scrollTo(0, 0));
  const first = await page.locator(".section").last().locator(".image-hit").first().boundingBox();
  await page.mouse.move(first.x + 70, first.y + 50); await page.mouse.down();
  await page.mouse.move(first.x + 100, 710, { steps: 5 });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(250); await page.mouse.up();
  expect(await page.locator(".select-image:checked").count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("checkbox", { name: "Select hidden.png", exact: true, includeHidden: true })).not.toBeChecked();
});

async function setCrop(page, values) {
  for (const [key, value] of Object.entries(values)) await page.locator(`#editor [name=crop-${key}]`).fill(String(value));
}

test("crop is metadata-only, original editor and viewer retain full image, and reset/cancel work", async ({ page }) => {
  await ready(page); const bytes = await png(page, 600, 400);
  await upload(page, ["crop.png"], bytes);
  const original = await snapshot(page);
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
  await expect(page.locator(".crop-stage>img")).toHaveJSProperty("naturalWidth", 600);
  await setCrop(page, { x: 25, y: 10, width: 50, height: 75 }); await saveDialog(page);
  await expect(page.locator(".cropped-preview")).toHaveAttribute("viewBox", "150 40 300 300");
  const saved = await snapshot(page);
  expect(saved.state.tabs[0].sections[0].items[0].crop).toEqual({ x: .25, y: .1, width: .5, height: .75 });
  expect(saved.assets[0][0]).toBe(original.assets[0][0]);
  expect(Buffer.from(saved.assets[0][1].bytes).equals(bytes)).toBe(true);
  await page.getByRole("button", { name: "Open original image: crop.png", exact: true }).click();
  await expect(page.locator("#viewer-image")).toHaveJSProperty("naturalWidth", 600);
  await expect(page.locator("#viewer-image")).toHaveJSProperty("naturalHeight", 400);
  await page.locator("#viewer-close").click();
  for (const layout of ["grid", "list", "masonry"]) {
    await page.locator(`button[data-layout=${layout}]`).click();
    await expect(page.locator(".images")).toHaveAttribute("data-layout", layout);
    await expect(page.locator(".cropped-preview svg")).toHaveAttribute("overflow", "hidden");
    expect(await page.locator(".cropped-preview").evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(0);
  }
  await page.reload(); await expect(page.locator(".cropped-preview")).toHaveAttribute("viewBox", "150 40 300 300");
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
  await expect(page.locator(".crop-stage>img")).toHaveJSProperty("naturalWidth", 600);
  await expect(page.locator("[name=crop-x]")).toHaveValue("25");
  await page.getByRole("button", { name: "Reset crop", exact: true }).click();
  await page.locator("#cancel-editor").click();
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop.x).toBe(.25);
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
  await setCrop(page, { x: 80, width: 50 });
  await page.locator("#editor-submit").click(); await expect(page.locator("#editor-error")).toContainText("at most 100%");
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop.x).toBe(.25);
  await page.getByRole("button", { name: "Reset crop", exact: true }).click(); await saveDialog(page);
  await expect(page.locator(".cropped-preview")).toHaveCount(0);
  await expect(page.locator(".image-hit img")).toHaveJSProperty("naturalWidth", 600);
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop).toBeUndefined();
});

test("crop frame draws, moves and resizes with mouse and touch while keeping original bytes", async ({ page, browser }) => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile, isMobile: mobile });
    const target = await context.newPage(); await ready(target); const bytes = await png(target, 600, 400);
    await upload(target, ["frame.png"], bytes);
    await target.getByRole("button", { name: "Crop image frame.png", exact: true }).click();
    await setCrop(target, { x: 20, y: 20, width: 60, height: 60 });
    const stage = await target.locator(".crop-stage").boundingBox();
    const drag = async (start, end) => {
      if (mobile) {
        const cdp = await context.newCDPSession(target);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y }] });
        await target.waitForTimeout(80);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: end.y }] });
        await target.waitForTimeout(100);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
      } else {
        await target.mouse.move(start.x, start.y); await target.mouse.down(); await target.mouse.move(end.x, end.y, { steps: 5 }); await target.mouse.up();
      }
    };
    const at = (x, y) => ({ x: stage.x + stage.width * x, y: stage.y + stage.height * y });
    await drag(at(.05, .05), at(.65, .65));
    expect(Number(await target.locator("[name=crop-x]").inputValue())).toBeCloseTo(5, 0);
    expect(Number(await target.locator("[name=crop-width]").inputValue())).toBeCloseTo(60, 0);
    await drag(at(.35, .35), at(.45, .45));
    expect(Number(await target.locator("[name=crop-x]").inputValue())).toBeCloseTo(15, 0);
    const corner = await target.locator("[data-corner=se]").boundingBox();
    await drag({ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, at(.85, .85));
    expect(Number(await target.locator("[name=crop-width]").inputValue())).toBeCloseTo(70, 0);
    await saveDialog(target); expect(Buffer.from((await snapshot(target)).assets[0][1].bytes).equals(bytes)).toBe(true);
    await context.close();
  }
});

test("all layouts visually clip outside pixels, including letterboxed crop previews", async ({ page }) => {
  await ready(page);
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext("2d");
    context.fillStyle = "rgb(240,20,20)"; context.fillRect(0, 0, 150, 400);
    context.fillStyle = "rgb(20,80,220)"; context.fillRect(150, 0, 300, 400);
    context.fillStyle = "rgb(20,200,40)"; context.fillRect(450, 0, 150, 400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await upload(page, ["colors.png", "neighbor-a.png", "neighbor-b.png"], Buffer.from(encoded, "base64"));
  await page.getByRole("button", { name: "Crop image colors.png", exact: true }).click();
  await setCrop(page, { x: 25, y: 0, width: 50, height: 100 }); await saveDialog(page);
  for (const layout of ["grid", "list", "masonry"]) {
    await page.locator(`button[data-layout=${layout}]`).click();
    await expect(page.locator(".images")).toHaveAttribute("data-layout", layout);
    const screenshot = await page.locator(".cropped-preview").screenshot();
    const samples = await page.evaluate(async (base64) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      return [.01, .5, .99].map((position) => [...context.getImageData(Math.floor(canvas.width * position), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3));
    }, screenshot.toString("base64"));
    expect(samples[1], layout).toEqual([20, 80, 220]);
    for (const sample of samples) { expect(sample, layout).not.toEqual([240, 20, 20]); expect(sample, layout).not.toEqual([20, 200, 40]); }
  }
});

test("crops persist through copies, backups and offline HTML; invalid crop imports cannot replace a board", async ({ page, browser }, testInfo) => {
  await ready(page); const bytes = await png(page, 600, 400); await upload(page, ["portable-crop.png"], bytes);
  await page.getByRole("button", { name: "Crop image portable-crop.png", exact: true }).click();
  await setCrop(page, { x: 10, y: 20, width: 40, height: 60 }); await saveDialog(page);
  await editTab(page); await page.getByRole("button", { name: "Duplicate tab", exact: true }).click();
  await expect(page.locator(".tab")).toHaveCount(2); await expect(page.locator(".cropped-preview")).toHaveAttribute("viewBox", "60 80 240 240");
  const htmlEvent = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const htmlPath = testInfo.outputPath("cropped.html"); await (await htmlEvent).saveAs(htmlPath);
  const offline = await browser.newContext({ offline: true }); const reader = await offline.newPage();
  await reader.goto(pathToFileURL(htmlPath).href);
  await expect(reader.locator(".cropped-preview")).toHaveAttribute("viewBox", "60 80 240 240");
  await reader.getByRole("button", { name: "Crop image portable-crop.png", exact: true }).click();
  await expect(reader.locator(".crop-stage>img")).toHaveJSProperty("naturalWidth", 600); await offline.close();
  await page.locator("#more").click();
  const jsonEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
  const jsonPath = testInfo.outputPath("cropped.json"); await (await jsonEvent).saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  expect(backup.state.tabs.every((tab) => tab.sections[0].items[0].crop.width === .4)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept()); await page.locator("#backup-file").setInputFiles(jsonPath);
  await expect(page.locator("#editor")).not.toBeVisible(); await expect(page.locator(".cropped-preview")).toBeVisible();
  for (const crop of [{ x: -.1, y: 0, width: .5, height: 1 }, { x: .8, y: 0, width: .5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: "half", height: 1 }]) {
    backup.state.tabs[0].sections[0].items[0].crop = crop;
    await page.locator("#backup-file").setInputFiles({ name: "bad-crop.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.locator("#notice")).toContainText("Import failed");
    expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop.width).toBe(.4);
  }
});

test("hidden intro keeps uploads available and pencil edit toggle shares the layout row", async ({ page }) => {
  await ready(page);
  await expect(page.locator("section.intro")).toBeHidden();
  await expect(page.locator("#edit-toggle svg")).toHaveCount(1);
  await expect(page.locator("#edit-toggle")).toHaveText("");
  await expect(page.getByRole("button", { name: "Turn editing off", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add images", exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.locator(".view-switch").boundingBox(), pencil = await page.locator("#edit-toggle").boundingBox();
    expect(Math.abs((layout.y + layout.height / 2) - (pencil.y + pencil.height / 2))).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.locator("#edit-toggle").click();
  await expect(page.getByRole("button", { name: "Turn editing on", exact: true })).toBeVisible();
  await expect(page.locator("#paste-toolbar")).toBeHidden();
  await page.locator("#edit-toggle").click();
  const chooserEvent = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "Add images", exact: true }).click();
  const chooser = await chooserEvent;
  await chooser.setFiles(file("still-uploadable.png", await png(page)));
  await expect(page.locator(".image-card")).toHaveCount(1);
});

test("tabs edit on double-click, F2, or touch hold without the board-heading block", async ({ page, browser }) => {
  await ready(page);
  await expect(page.locator(".board-heading")).toHaveCount(0);
  await page.locator("#new-tab").click();
  await page.locator("#editor [name=name]").fill("Second tab"); await saveDialog(page);
  await page.locator(".tab").first().dblclick();
  await expect(page.locator("#editor [name=name]")).toHaveValue("My inspiration");
  await page.locator("#editor [name=name]").fill("Renamed first"); await saveDialog(page);
  await expect(tabTitle(page)).toHaveText("Renamed first");
  await page.locator(".tab").last().focus(); await page.keyboard.press("F2");
  await expect(page.locator("#editor [name=name]")).toHaveValue("Second tab");
  await page.locator("#editor [name=name]").fill("Keyboard tab"); await saveDialog(page);
  await page.locator("#edit-toggle").click();
  await page.locator(".tab").first().dblclick();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(tabTitle(page)).toHaveText("Renamed first");
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage(); await mobilePage.goto("http://127.0.0.1:8085/");
  await expect(mobilePage.locator("#save-status")).toHaveText("Saved on this device");
  const tab = await mobilePage.locator(".tab").boundingBox(), cdp = await mobile.newCDPSession(mobilePage);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tab.x + 20, y: tab.y + 20 }] });
  await mobilePage.waitForTimeout(600);
  await expect(mobilePage.locator("#editor")).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobilePage.locator("#editor [name=name]").fill("Touch tab"); await saveDialog(mobilePage);
  await expect(tabTitle(mobilePage)).toHaveText("Touch tab");
  await mobile.close();
});

test("layout icons and flipped edit control match dimensions, with paste toolbar hidden", async ({ page }) => {
    await ready(page);
    await expect(page.locator("#paste-toolbar")).toBeHidden();
    await expect(page.locator(".zoom-label")).toHaveText("");
    for (const name of ["Masonry", "Grid", "List"]) {
      const control = page.getByRole("button", { name, exact: true });
      await expect(control).toHaveText(""); await expect(control).toHaveAttribute("title", name);
      await expect(control.locator("svg")).toHaveCount(1);
      await control.click(); await expect(control).toHaveAttribute("aria-pressed", "true");
    }
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const group = await page.locator(".view-switch").boundingBox(), edit = await page.locator("#edit-toggle").boundingBox();
      expect(edit.width).toBeCloseTo(group.width, 1); expect(edit.height).toBeCloseTo(group.height, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await expect(page.locator("#edit-toggle svg")).toHaveCSS("transform", "matrix(-1, 0, 0, 1, 0, 0)");
  });

test("Caption switches persist and source icon links remain independent of caption visibility", async ({ page, context }, testInfo) => {
    await ready(page); const bytes = await png(page);
    const source = "https://example.test/article";
    await paste(page, ["original-name.png"], bytes, `SourceURL:${source}\r\n`);
    await upload(page, ["no-source.png"], bytes);
    await expect(page.locator(".source-missing")).toHaveCount(0);
    await expect(page.locator(".card-caption").last()).toBeHidden();
    const shortcut = page.locator(".card-tools .source-button");
    await expect(shortcut).toHaveCount(1); await expect(shortcut).toHaveAttribute("href", source);
    await expect(shortcut).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "Edit image original-name.png", exact: true }).click();
    await expect(page.locator("#editor-extra .source-button")).toHaveAttribute("href", source);
    await page.locator("#cancel-editor").click();
    await page.locator("#more").click();
    await expect(page.locator("#editor-fields").locator(":scope > *").first()).toHaveText("Caption");
    await expect(page.locator("#editor [name=theme]")).toHaveCount(0);
    await expect(page.locator("#editor-extra").locator(":scope > *").last().locator("[name=accent]")).toHaveCount(1);
    await page.getByRole("switch", { name: "Show filenames", exact: true }).check();
    await saveDialog(page);
    await expect(page.locator(".card-caption h3").first()).toBeVisible();
    await expect(page.locator(".card-caption h3").first()).toHaveText("original-name.png");
    await expect(page.locator(".card-caption h3").last()).toBeVisible();
    await page.locator("#more").click(); await page.getByRole("switch", { name: "Show URLs", exact: true }).uncheck(); await saveDialog(page);
    await expect(page.locator(".source-link")).toBeHidden(); await expect(page.locator(".card-caption h3").first()).toBeVisible();
    await page.locator("#more").click(); await page.getByRole("switch", { name: "Show captions", exact: true }).uncheck(); await saveDialog(page);
    for (const caption of await page.locator(".card-caption").all()) await expect(caption).toBeHidden();
    await page.locator(".image-card").first().hover(); await expect(shortcut).toBeVisible();
    await context.route("https://example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Source page</title>" }));
    const popupEvent = context.waitForEvent("page"); await shortcut.click();
    const popup = await popupEvent; await popup.waitForLoadState(); expect(popup.url()).toBe(source); await popup.close();
    await page.reload(); await page.locator("#more").click();
    await expect(page.getByRole("switch", { name: "Show captions", exact: true })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Show filenames", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Show URLs", exact: true })).not.toBeChecked();
    const event = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
    const output = testInfo.outputPath("caption-settings.json"); await (await event).saveAs(output);
    const backup = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(backup.state.settings).toMatchObject({ showCaptions: false, showFilenames: true, showUrls: false, theme: "light" });
    await page.locator("#cancel-editor").click();
    await page.locator("#more").click(); await page.getByRole("switch", { name: "Show captions", exact: true }).check();
    await page.getByRole("switch", { name: "Show URLs", exact: true }).check(); await saveDialog(page);
    await expect(page.locator(".source-link")).toBeVisible();
  });

test("authenticated GitHub saves reach public devices, preserve bytes, and delete the last original file", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const desktop = await shared.open({ authenticated: true });
    await expect(desktop.page.locator(".image-card")).toHaveCount(1);
    await desktop.page.locator("#image-files").setInputFiles(file("uploaded.png", fixture.bytes));
    await expect(desktop.page.locator(".image-card")).toHaveCount(2);
    await expect(desktop.page.locator("#save-status")).toHaveText("Saved to GitHub");
    expect(shared.writes).toHaveLength(1);
    for (const [, asset] of shared.record.board.assets) expect(Buffer.from(asset.data.split(",")[1], "base64").equals(fixture.bytes)).toBe(true);
    const phone = await shared.open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, authenticated: true });
    await expect(phone.page.locator(".image-card")).toHaveCount(2);
    phone.page.once("dialog", (dialog) => dialog.accept());
    await phone.page.getByRole("button", { name: "Delete image uploaded.png", exact: true }).click();
    await expect(phone.page.locator(".image-card")).toHaveCount(1);
    await expect(phone.page.locator("#save-status")).toHaveText("Saved to GitHub");
    expect(shared.record.board.assets).toHaveLength(1);
    const fresh = await shared.open(); await expect(fresh.page.locator(".image-card")).toHaveCount(1);
    expect(await titles(fresh.page)).toEqual(["shared-original.png"]);
  } finally { await shared.close(); }
});

test("offline GitHub outbox survives reload, reconnects, and portable copies stay independent", async ({ page, browser }, testInfo) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const device = await shared.open({ authenticated: true });
    await device.context.setOffline(true);
    await paste(device.page, ["on-the-plane.png"], fixture.bytes);
    await expect(device.page.locator(".image-card")).toHaveCount(2);
    await expect(device.page.locator("#save-status")).toHaveText("Saved here · GitHub unavailable");
    await device.page.reload(); await expect(device.page.locator(".image-card")).toHaveCount(2);
    expect(shared.writes).toHaveLength(0);
    const htmlEvent = device.page.waitForEvent("download"); await device.page.locator("#save-portable").click();
    const output = testInfo.outputPath("shared-offline.html"); await (await htmlEvent).saveAs(output);
    const contents = fs.readFileSync(output, "utf8");
    expect(contents).not.toContain("test-only-token");
    expect(JSON.parse(contents.match(/<script id="cloud-config" type="application\/json">([\s\S]*?)<\/script>/)[1])).toBeNull();
    const offline = await browser.newContext({ offline: true }), reader = await offline.newPage();
    await reader.goto(pathToFileURL(output).href); await expect(reader.locator(".image-card")).toHaveCount(2);
    await expect(reader.locator("#save-status")).toHaveText("Saved on this device"); await offline.close();
    await device.context.setOffline(false);
    await expect(device.page.locator("#save-status")).toHaveText("Saved here · connect GitHub");
    await authenticateShared(device.page);
    expect(shared.record.board.assets).toHaveLength(2);
  } finally { await shared.close(); }
});

test("simultaneous public edits report conflicts without overwriting, and merging preserves both versions", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const a = await shared.open({ authenticated: true }), b = await shared.open({ authenticated: true });
    await b.context.setOffline(true);
    await paste(b.page, ["offline-B.png"], fixture.bytes); await expect(b.page.locator(".image-card")).toHaveCount(2);
    await paste(a.page, ["online-A.png"], fixture.bytes); await expect(a.page.locator(".image-card")).toHaveCount(2);
    await expect(a.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await b.context.setOffline(false);
    await expect(b.page.locator("#save-status")).toHaveText("Save conflict · kept on device");
    expect(shared.record.board.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => item.title)))).toEqual(["shared-original.png", "online-A.png"]);
    expect(await titles(b.page)).toEqual(["shared-original.png", "offline-B.png"]);
    await b.page.locator("#more").click();
    await b.page.getByRole("button", { name: "Merge local and shared boards", exact: true }).click();
    await expect(b.page.locator("#editor")).not.toBeVisible();
    await expect(b.page.locator("#save-status")).toHaveText("Saved to GitHub");
    const names = shared.record.board.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => item.title)));
    expect(names).toContain("online-A.png"); expect(names).toContain("offline-B.png");
  } finally { await shared.close(); }
});

test("first connection merges an existing local collection rather than discarding its images", async ({ page, browser, context }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const deviceContext = await browser.newContext({ serviceWorkers: "block" }), device = await deviceContext.newPage();
    await ready(device); await upload(device, ["local-only.png"], fixture.bytes);
    await shared.connect(deviceContext); await device.reload();
    await expect(device.locator("#save-status")).toHaveText("Saved here · connect GitHub");
    await authenticateShared(device);
    await expect(device.locator("#save-status")).toHaveText("Saved to GitHub");
    const names = shared.record.board.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => item.title)));
    expect(names).toContain("shared-original.png"); expect(names).toContain("local-only.png");
    await deviceContext.close();
  } finally { await shared.close(); }
});

test("USB portable copy embeds every original across tabs and collapsed sections, including JPEG, GIF and cropped images", async ({ page, browser }, testInfo) => {
  await ready(page);
  const original = await png(page, 2048, 1536);
  await upload(page, ["full-resolution.png"], original);
  await page.getByRole("button", { name: "Crop image full-resolution.png", exact: true }).click();
  await setCrop(page, { x: 10, y: 10, width: 50, height: 50 }); await saveDialog(page);
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 987; canvas.height = 654;
    const context = canvas.getContext("2d"); context.fillStyle = "#b17b5f"; context.fillRect(0, 0, 987, 654);
    return canvas.toDataURL("image/jpeg", .92).split(",")[1];
  }), "base64");
  await page.locator("#image-files").setInputFiles({ name: "original-photo.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".image-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Edit image original-photo.jpg", exact: true }).click();
  await page.locator("[name=sourceUrl]").fill("https://example.com/original-photo");
  await page.locator("[name=notes]").fill("Keep the original JPEG and this note.");
  await saveDialog(page);
  await page.locator("#new-tab").click(); await page.locator("[name=name]").fill("Flight"); await saveDialog(page);
  await newSection(page, "Keep offline");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await page.locator("#image-files").setInputFiles({ name: "original.gif", mimeType: "image/gif", buffer: gif });
  await expect(page.locator(".image-card")).toHaveCount(1);
  await newSection(page, "Collapsed memories"); await upload(page, ["hidden-original.png"], original);
  await page.locator(".section-toggle").last().click(); await expect(page.locator(".section").last()).toHaveClass(/collapsed/);
  const saved = await snapshot(page), hashes = new Map(saved.assets.map(([id, asset]) => [id, crypto.createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex")]));
  expect(hashes.size).toBe(4);
  const event = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const usbPath = testInfo.outputPath("usb", "moodboard.html"); fs.mkdirSync(path.dirname(usbPath), { recursive: true }); await (await event).saveAs(usbPath);
  const contents = fs.readFileSync(usbPath, "utf8");
  const embedded = JSON.parse(contents.match(/<script id="portable-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  expect(embedded.assets).toHaveLength(4);
  expect(embedded.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items))).toHaveLength(4);
  for (const [id, asset] of embedded.assets) expect(crypto.createHash("sha256").update(Buffer.from(asset.data.split(",")[1], "base64")).digest("hex")).toBe(hashes.get(id));
  expect(embedded.state.tabs[0].sections[0].items[0].crop).toEqual({ x: .1, y: .1, width: .5, height: .5 });
  expect(embedded.state.tabs[0].sections[0].items[1]).toMatchObject({ sourceUrl: "https://example.com/original-photo", notes: "Keep the original JPEG and this note." });
  for (const storage of [true, false]) {
    const offline = await browser.newContext({ offline: true });
    if (!storage) await offline.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: { open() { throw new Error("USB file storage blocked"); } } }); });
    const reader = await offline.newPage(), network = [];
    reader.on("request", (request) => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await reader.goto(pathToFileURL(usbPath).href);
    await expect(reader.locator(".image-card")).toHaveCount(2);
    await expect(reader.locator(".section").last()).toHaveClass(/collapsed/);
    await reader.locator(".tab").first().click();
    await expect(reader.locator(".image-card")).toHaveCount(2);
    await reader.getByRole("button", { name: "Crop image full-resolution.png", exact: true }).click();
    await expect(reader.locator(".crop-stage>img")).toHaveJSProperty("naturalWidth", 2048);
    await expect(reader.locator(".crop-stage>img")).toHaveJSProperty("naturalHeight", 1536);
    await reader.locator("#cancel-editor").click();
    await reader.getByRole("button", { name: "Open original image: original-photo.jpg", exact: true }).click();
    await expect(reader.locator("#viewer-image")).toHaveJSProperty("naturalWidth", 987);
    expect(network).toEqual([]);
    if (storage) for (const [id, asset] of (await snapshot(reader)).assets) expect(crypto.createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex")).toBe(hashes.get(id));
    await offline.close();
  }
});

test("an incomplete first shared load cannot download a misleading partial portable copy", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    shared.corruptOriginal(); await shared.connect(context);
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#save-status")).toHaveText("Could not load GitHub board");
    await expect(reader.locator("#notice")).toContainText("integrity check");
    await expect(reader.locator("#save-portable")).toBeDisabled();
    await expect(reader.locator(".image-card")).toHaveCount(0);
  } finally { await context.close(); await shared.close(); }
});

test("original ingestion and shared caching do not wait for paint-time image decoding", async ({ page, browser }) => {
  await page.addInitScript(() => {
    window.paintDecoderCalls = 0;
    Image.prototype.decode = () => { window.paintDecoderCalls++; return new Promise(() => {}); };
  });
  const fixture = await sharedFixture(page);
  expect(await page.evaluate(() => window.paintDecoderCalls)).toBe(0);
  const shared = await sharedHarness(browser, fixture.board), context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      window.paintDecoderCalls = 0;
      Image.prototype.decode = () => { window.paintDecoderCalls++; return new Promise(() => {}); };
    });
    await shared.connect(context); const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#save-status")).toHaveText("Saved to GitHub");
    await expect(reader.locator(".image-card")).toHaveCount(1);
    expect(await reader.evaluate(() => window.paintDecoderCalls)).toBe(0);
    expect(Buffer.from((await snapshot(reader)).assets[0][1].bytes).equals(fixture.bytes)).toBe(true);
  } finally { await context.close(); await shared.close(); }
});
