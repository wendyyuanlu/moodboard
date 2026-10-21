const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
}
async function showUploadButtons(page) {
  await page.locator("#more").click();
  await page.getByRole("switch", { name: "Show Add image buttons", exact: true }).check();
  await saveDialog(page);
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
function portablePayload(source) {
  const data = JSON.parse(source.match(/<script id="portable-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  if (data.embeddedAssetCount !== undefined) {
    const embedded = source.slice(0, source.indexOf('<script id="cloud-config"'));
    data.assets = [...embedded.matchAll(/<script type="application\/json" data-portable-asset>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    expect(data.assets).toHaveLength(data.embeddedAssetCount);
  }
  return data;
}
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
async function setSpacing(page, value) {
  await page.locator("#spacing").fill(String(value)); await page.locator("#spacing").press("Enter");
  await expect(page.locator("#card-spacing")).toHaveAttribute("title", `Card spacing: ${value}px`);
}
function tabTitle(page) { return page.locator(".tab[aria-current=true] .tab-name"); }
async function newSection(page, name) {
  await page.locator("#bottom-add").click();
  await page.locator("#editor [name=name]").fill(name);
  await saveDialog(page);
}
async function newTab(page, name) {
  await page.locator("#new-tab").click();
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
    for (const [key, asset] of record.assets) {
      const blob = asset.storageKey ? (await read("boards", asset.storageKey)).blob : asset.blob;
      const { storageKey, ...metadata } = asset;
      assets.push([key, { ...metadata, bytes: blob ? [...new Uint8Array(await blob.arrayBuffer())] : null, blob: null }]);
    }
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
  let raceNextSave = false;
  const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const config = { site: "http://127.0.0.1:8085/", owner: "example", repo: "moodboard", branch: "board", collection: "test/shared-board" };
  const html = source.replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(config)}$2`);
  async function connect(context) {
    await context.route("http://127.0.0.1:8085/", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await context.route(/^https:\/\/(?:api\.github\.com\/repos\/example\/moodboard|raw\.githubusercontent\.com\/example\/moodboard\/(?:board|[a-f0-9]{40}))(?:\/|$)/, async (route) => {
      const request = route.request(), headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-GitHub-Api-Version", "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      if (raceNextSave && request.method() === "PATCH") {
        raceNextSave = false;
        const latest = remote.packageAt(), item = latest.board.state.tabs[0].sections[0].items[0];
        latest.board.state.revision++;
        latest.board.state.tabs[0].sections[0].items.push({ ...item, id: "race-item", title: "racing-import.png" });
        await seed.write(latest.revision, latest.board);
      }
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
    await expect.poll(async () => (await snapshot(page)).assets.every(([, asset]) => asset.bytes !== null)).toBe(true);
    if (authenticated) await authenticateShared(page);
    return { page, context };
  }
  return { open, connect, raceNextSave: () => { raceNextSave = true; }, corruptOriginal: () => { const path = [...remote.files.keys()].find((path) => path.startsWith("images/")); remote.blobs.set(remote.files.get(path), Buffer.from("not the original")); },
    get writes() { return remote.history.slice(initialSaves).map((head) => remote.packageAt(head)); },
    get record() { return remote.packageAt(); }, close: () => Promise.all(contexts.map((context) => context.close())) };
}
async function authenticateShared(page) {
  await page.locator("#more").click();
  await page.getByRole("button", { name: "Enable auto-sync", exact: true }).click();
  await expect(page.locator("[name=githubToken]")).toHaveAttribute("placeholder", "PUT IT HERE NAO");
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

test("empty sections use a large working paste target and Add section spans the board", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".empty-section .section-end")).toHaveCount(1);
  await expect(page.locator(".empty-section")).toHaveText("+ Add or paste at the end");
  await expect(page.locator(".board-footnote")).toHaveCount(0);
  await expect(page.locator("footer")).not.toContainText("Made for your wandering mind.");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const main = await page.locator("main").evaluate(node => ({ width: node.clientWidth, left: parseFloat(getComputedStyle(node).paddingLeft), right: parseFloat(getComputedStyle(node).paddingRight) }));
    const add = await page.locator("#bottom-add").boundingBox();
    expect(add.width).toBeCloseTo(main.width - main.left - main.right, 0);
    await expect(page.locator(".empty-section .section-end span")).toHaveCSS("font-size", "24px");
  }
  await newSection(page, "Paste destination");
  await page.getByRole("button", { name: "Paste at end of Paste destination", exact: true }).click();
  await expect(page.locator(".empty-section .section-end.chosen")).toHaveCount(1);
  expect(await page.locator(".empty-section .section-end.chosen").evaluate(node => getComputedStyle(node, "::after").content)).toBe("none");
  await paste(page, ["added-here.png"], await png(page));
  await expect(page.locator(".section").last().locator(".image-card")).toHaveCount(1);
  await expect(page.locator(".section").last().locator(".empty-section")).toHaveCount(0);
  await expect(page.locator(".section").last().locator(".section-end")).toHaveCount(1);
  await expect(page.locator(".section").first().locator(".image-card")).toHaveCount(0);
});

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
  await page.locator("#cancel-editor").click();
  await page.getByRole("button", { name: "Paste at end of The little things", exact: true }).click();
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
  const payload = portablePayload(source);
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
  await page.locator("#editor-delete").click();
  await page.locator("#delete-warning-submit").click();
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
  await page.locator("#copy-to-selected").click();
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
  await page.locator("#delete-selected").click();
  await page.locator("#delete-warning-submit").click();
  await expect(page.locator(".image-card")).toHaveCount(0);
  expect((await snapshot(page)).assets).toHaveLength(0);
});

  test("section checkboxes bulk copy and move in board order while sharing originals, and deletion prunes only unused files", async ({ page }) => {
    await ready(page); const bytes = await png(page);
    await upload(page, ["unique.png", "shared.png"], bytes);
    await newSection(page, "Second");
    await page.getByRole("button", { name: "Paste at end of Second", exact: true }).click();
    await upload(page, ["second.png"], bytes);
    await page.locator(".section-toggle").last().click();
    await newSection(page, "Empty");
    await newTab(page, "Destination");
    await page.locator(".tab").filter({ hasText: "My inspiration" }).click();
    const before = await snapshot(page), original = before.state.tabs.find(tab => tab.name === "My inspiration").sections.slice(0, 2);
    await page.getByRole("checkbox", { name: "Select section Second", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select section The little things", exact: true }).check();
    await expect(page.locator("#selection-count")).toHaveText("2 sections selected");
    await expect(page.locator("#selection-bar")).toHaveAttribute("aria-label", "Selected section actions");
    await expect(page.locator("#select-section")).toBeHidden();
    await page.locator("#copy-to-selected").click();
    await page.locator("#editor [name=tab]").selectOption({ label: "Destination" }); await saveDialog(page);
    const copied = await snapshot(page), destination = copied.state.tabs.find(tab => tab.name === "Destination");
    expect(destination.sections.map(section => section.name)).toEqual(["The little things", "Second"]);
    for (let i = 0; i < 2; i++) {
      expect(destination.sections[i].id).not.toBe(original[i].id);
      expect(destination.sections[i].collapsed).toBe(original[i].collapsed);
      expect(destination.sections[i].items.map(item => item.assetId)).toEqual(original[i].items.map(item => item.assetId));
      expect(destination.sections[i].items.every(item => !original[i].items.some(source => source.id === item.id))).toBe(true);
    }
    expect(copied.assets).toHaveLength(3);
    await page.getByRole("checkbox", { name: "Select section Second", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select section The little things", exact: true }).check();
    await page.getByRole("button", { name: "Move selected sections", exact: true }).click();
    await page.locator("#editor [name=tab]").selectOption({ label: "Destination" });
    await page.locator("#editor [name=position]").fill("2"); await saveDialog(page);
    const moved = await snapshot(page), target = moved.state.tabs.find(tab => tab.name === "Destination");
    expect(target.sections.slice(1, 3).map(section => section.id)).toEqual(original.map(section => section.id));
    expect(moved.state.tabs.find(tab => tab.name === "My inspiration").sections.map(section => section.name)).toEqual(["Empty"]);
    await page.locator(".tab").filter({ hasText: "Destination" }).click();
    for (const section of original) await page.locator(`.section[data-section-id="${section.id}"] .select-section`).check();
    await page.locator("#delete-selected").click();
    await expect(page.locator("#delete-warning-message")).toContainText("2 sections and their 3 images");
    await page.locator("#delete-warning-submit").click();
    await expect(page.locator(".section")).toHaveCount(2);
    expect((await snapshot(page)).assets).toHaveLength(3);
    await page.locator(".select-section").first().check(); await page.locator("#select-all").click();
    await page.locator("#delete-selected").click(); await page.locator("#delete-warning-submit").click();
    await expect(page.locator(".section")).toHaveCount(0);
    await expect(page.locator("#selection-bar")).toBeHidden();
    expect((await snapshot(page)).assets).toHaveLength(0);
  });

  test("section deletion shares the warning allowance with images and selections switch cleanly", async ({ page }) => {
    await ready(page);
    for (const name of ["B", "C", "D", "Keep"]) await newSection(page, name);
    await page.getByRole("button", { name: "Paste at end of Keep", exact: true }).click();
    await upload(page, ["keep.png"], await png(page));
    await page.getByRole("checkbox", { name: "Select keep.png", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select section The little things", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "Select keep.png", exact: true })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Select section B", exact: true }).check();
    await page.keyboard.press("Delete");
    await page.locator("#delete-warning-cancel").click();
    await expect(page.locator(".section")).toHaveCount(5);
    await page.locator("#delete-selected").click(); await page.locator("#delete-skip").fill("1");
    await page.locator("#delete-warning-submit").click(); await expect(page.locator(".section")).toHaveCount(3);
    await page.getByRole("checkbox", { name: "Select section C", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select section D", exact: true }).check();
    await page.locator("#delete-selected").click(); await expect(page.locator(".section")).toHaveCount(1);
    await expect(page.locator("#delete-warning")).toBeHidden();
    await page.getByRole("checkbox", { name: "Select section Keep", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select keep.png", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "Select section Keep", exact: true })).not.toBeChecked();
    await expect(page.locator("#selection-count")).toHaveText("1 selected");
    await page.locator("#delete-selected").click(); await expect(page.locator("#delete-warning")).toBeVisible();
    await page.locator("#delete-warning-cancel").click(); await page.keyboard.press("Escape");
    await expect(page.locator("#selection-bar")).toBeHidden();
  });

  test("headers are compact and stable; only section titles and chevrons collapse sections", async ({ page }) => {
    await ready(page); await upload(page, ["geometry.png"], await png(page));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect((await page.locator(".tabs-row").boundingBox()).height).toBe(50);
      expect((await page.locator(".board-toolbar").boundingBox()).height).toBe(50);
      const header = await page.locator(".section-header").boundingBox(), image = await page.locator(".image-card").boundingBox();
      await page.mouse.move(image.x + 10, image.y + 10);
      expect((await page.locator(".section-header").boundingBox()).height).toBe(header.height);
      expect((await page.locator(".image-card").boundingBox()).y).toBe(image.y);
      await page.locator(".section-count").click(); await expect(page.locator(".section")).not.toHaveClass(/collapsed/);
      const count = await page.locator(".section-count").boundingBox();
      await page.mouse.click(count.x + count.width + 3, count.y + count.height / 2);
      await expect(page.locator(".section")).not.toHaveClass(/collapsed/);
      await page.locator(".section-toggle strong").click(); await expect(page.locator(".section")).toHaveClass(/collapsed/);
      await page.locator(".select-section").check(); await expect(page.locator(".section")).toHaveClass(/collapsed/);
      await page.locator("#clear-selection").click();
      await page.locator(".section-toggle .chevron").click(); await expect(page.locator(".section")).not.toHaveClass(/collapsed/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });

  test("card spacing controls change real gaps in every layout and persist offline", async ({ page, browser }, testInfo) => {
    await ready(page); await page.setViewportSize({ width: 900, height: 900 });
    await upload(page, ["gap-a.png", "gap-b.png", "gap-c.png", "gap-d.png"], await png(page));
    await setSpacing(page, 22);
    await expect.poll(async () => (await snapshot(page)).state.settings.spacing).toBe(22);
    for (const mode of ["masonry", "grid", "list"]) {
      await page.locator(`button[data-layout=${mode}]`).click();
      await expect.poll(() => page.locator(".image-card").evaluateAll(cards => {
        const boxes = cards.map(card => card.getBoundingClientRect());
        const sameRow = boxes.slice(1).find(box => Math.abs(box.y - boxes[0].y) < 1);
        return sameRow ? Math.round(sameRow.x - boxes[0].right) : Math.round(boxes[1].y - boxes[0].bottom);
      })).toBe(22);
    }
    await page.reload(); await expect(page.locator("#card-spacing")).toHaveAttribute("title", "Card spacing: 22px");
    for (const value of ["", "-1", "41", "2.5"]) {
      await page.locator("#spacing").fill(value); await page.locator("#spacing").press("Enter");
      expect((await snapshot(page)).state.settings.spacing).toBe(22);
      expect(await page.locator("#spacing").evaluate(input => input.validity.valid)).toBe(false);
    }
    await setSpacing(page, 0);
    const event = page.waitForEvent("download"); await page.locator("#save-portable").click();
    const output = testInfo.outputPath("spacing-offline.html"); await (await event).saveAs(output);
    const offline = await browser.newContext({ offline: true }), reader = await offline.newPage();
    await reader.goto(pathToFileURL(output).href);
    await expect(reader.locator("#card-spacing")).toHaveAttribute("title", "Card spacing: 0px");
    await setSpacing(reader, 7);
    await offline.close();
  });

  test("selection rectangles start on outer board padding and paste gaps without changing paste clicks", async ({ page }) => {
    await ready(page); await page.setViewportSize({ width: 900, height: 900 });
    await upload(page, ["edge-a.png", "edge-b.png", "edge-c.png"], await png(page, 120, 160));
    await expect(page.locator(".image-card")).toHaveCount(3);
    await page.locator('button[data-layout=grid]').click();
    await expect(page.locator('button[data-layout=grid]')).toHaveAttribute("aria-pressed", "true");
    const first = await page.locator(".image-card").first().boundingBox();
    await page.mouse.move(2, first.y + 5); await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(page.locator("#selection-count")).toHaveText("1 selected");
    await page.locator("#clear-selection").click();
    await page.getByRole("button", { name: "Paste before edge-b.png", exact: true }).click();
    await expect(page.getByRole("button", { name: "Paste before edge-b.png", exact: true })).toHaveClass(/chosen/);
    const gap = await page.getByRole("button", { name: "Paste before edge-b.png", exact: true }).boundingBox();
    const second = await page.locator(".image-card").nth(1).boundingBox();
    await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2); await page.mouse.down();
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(page.locator("#selection-count")).toHaveText("1 selected");
    await expect(page.locator(".image-card").nth(1).locator(".select-image")).toBeChecked();
  });
test("section header keeps selection, drag and the matching 20px upload icon together", async ({ page }) => {
  await ready(page); await showUploadButtons(page); await newSection(page, "Upload target");
  const section = page.locator(".section").last();
  expect(await section.locator(".section-actions").evaluate(node => [...node.children].map(child => child.className))).toEqual(["section-selection", "icon-button section-drag", "icon-button section-upload", "icon-button"]);
  const uploadIcon = section.locator(".section-upload svg");
  expect(await uploadIcon.boundingBox()).toMatchObject({ width: 20, height: 20 });
  expect(await uploadIcon.innerHTML()).toBe(await page.locator("#add-images svg").innerHTML());
  const picker = page.waitForEvent("filechooser");
  await section.locator(".section-upload").click();
  await (await picker).setFiles({ name: "target.png", mimeType: "image/png", buffer: await png(page) });
  await expect(section.locator(".image-card")).toHaveCount(1);
  expect((await snapshot(page)).state.tabs[0].sections[1].items[0].title).toBe("target.png");
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
  await page.locator(".image-card").first().evaluate(node => node.scrollIntoView({ block: "center" }));
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
  const landscape = page.getByRole("button", { name: "Open original image: landscape.png", exact: true });
  const landscapeBox = await landscape.boundingBox();
  await landscape.tap({ position: { x: landscapeBox.width - 5, y: 5 } });
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
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width - 5, y: rect.y + 5 }] });
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
  await page.getByRole("button", { name: "Drag A.png", exact: true }).evaluate(node => node.scrollIntoView({ block: "center" }));
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
  await expect(memoryPage.locator("#storage-warning")).toContainText("MUST use Download");
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

test("closed database connections recover without losing edits or rewriting cached originals", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["safe-original.png"], bytes);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    let closeOnce = true;
    window.originalRewrites = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === "readwrite" && closeOnce) { closeOnce = false; this.close(); }
      return transaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "boards" && (value.blob instanceof Blob || value.assets?.some(([, asset]) => asset.blob instanceof Blob))) {
        window.originalRewrites++;
        throw new DOMException("Image writes are forbidden during metadata edits.", "QuotaExceededError");
      }
      return put.call(this, value, key);
    };
  });
  await page.context().setOffline(true);
  await setSpacing(page, 22);
  await expect(page.locator("#card-spacing")).toHaveAttribute("title", "Card spacing: 22px");
  await newTab(page, "Keep this tab");
  await page.locator(".tab").filter({ hasText: "My inspiration" }).click();
  await expect(tabTitle(page)).toHaveText("My inspiration");
  await editTab(page); page.once("dialog", dialog => dialog.accept()); await page.locator("#editor-delete").click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".tab")).toHaveCount(1);
  expect(await page.evaluate(() => window.originalRewrites)).toBe(0);
  expect(await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const keys = await new Promise(resolve => { const r = db.transaction("boards").objectStore("boards").getAllKeys(); r.onsuccess = () => resolve(r.result); });
    db.close(); return keys.filter(Array.isArray);
  })).toEqual([]);
  await page.reload(); await expect(page.locator(".tab-name")).toHaveText("Keep this tab");
  await expect(page.locator("#card-spacing")).toHaveAttribute("title", "Card spacing: 22px");
});

test("legacy inline originals migrate without redownloading or changing their bytes", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["legacy.png"], bytes);
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const read = key => new Promise(resolve => { const r = db.transaction("boards").objectStore("boards").get(key); r.onsuccess = () => resolve(r.result); });
    const id = await new Promise(resolve => { const r = db.transaction("meta").objectStore("meta").get("active"); r.onsuccess = () => resolve(r.result); });
    const board = await read(id), asset = board.assets[0][1], key = asset.storageKey;
    asset.blob = (await read(key)).blob; delete asset.storageKey;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("boards", "readwrite"), store = tx.objectStore("boards");
      store.put(board, id); store.delete(key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); db.close();
  });
  await page.reload(); await expect(page.locator(".image-card")).toHaveCount(1);
  await setSpacing(page, 22);
  await expect(page.locator("#card-spacing")).toHaveAttribute("title", "Card spacing: 22px");
  expect(Buffer.from((await snapshot(page)).assets[0][1].bytes).equals(bytes)).toBe(true);
  expect(await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const id = await new Promise(resolve => { const r = db.transaction("meta").objectStore("meta").get("active"); r.onsuccess = () => resolve(r.result); });
    const record = await new Promise(resolve => { const r = db.transaction("boards").objectStore("boards").get(id); r.onsuccess = () => resolve(r.result); });
    db.close(); return Boolean(record.assets[0][1].storageKey) && !record.assets[0][1].blob;
  })).toBe(true);
});

test("low storage and actual original-write quota errors pause caching without blocking phone edits", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    for (const failWrite of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
      try {
        await context.addInitScript(failWrite => {
          Object.defineProperty(navigator.storage, "estimate", { value: async () => ({ quota: 128 * 1024 * 1024, usage: (failWrite ? 1 : 120) * 1024 * 1024 }) });
          if (failWrite) {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, key) {
              if (value.blob instanceof Blob) throw new DOMException("Test device storage is full.", "QuotaExceededError");
              return put.call(this, value, key);
            };
          }
        }, failWrite);
        await shared.connect(context); const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
        await expect(reader.locator(".image-card")).toHaveCount(1);
        await expect(reader.locator("#connection-status")).toContainText("Original caching paused");
        await expect(reader.locator("#storage-warning")).toContainText("not fully available offline");
        const before = (await snapshot(reader)).state.settings.spacing ?? 10;
        await setSpacing(reader, before + 4);
        await expect(reader.locator("#card-spacing")).toHaveAttribute("title", `Card spacing: ${before + 4}px`);
        await newTab(reader, "Phone edit");
        expect((await snapshot(reader)).state.tabs.some(tab => tab.name === "Phone edit")).toBe(true);
        expect((await snapshot(reader)).assets[0][1].bytes).toBeNull();
        await reader.reload(); await expect(reader.locator(".tab").filter({ hasText: "Phone edit" })).toHaveCount(1);
      } finally { await context.close(); }
    }
  } finally { await shared.close(); }
});

test("failed staged imports clean temporary originals without replacing the active board", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["keep.png"], bytes);
  const before = await snapshot(page);
  const keys = () => page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const keys = await new Promise(resolve => { const r = db.transaction("boards").objectStore("boards").getAllKeys(); r.onsuccess = () => resolve(r.result); });
    db.close(); return JSON.stringify(keys);
  });
  const originalKeys = await keys(), original = before.assets[0][1];
  const data = { name: original.name, width: original.width, height: original.height, data: `data:image/png;base64,${bytes.toString("base64")}` };
  const header = { format: "moodboard-lines", version: 1, state: before.state, assetCount: 17 };
  const records = Array.from({ length: 16 }, (_, index) => [`staged-${index}`, data]);
  const lines = [header, ...records, records[0]].map(record => JSON.stringify(record)).join("\n");
  await page.locator("#backup-file").setInputFiles({ name: "invalid.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
  await expect(page.locator("#notice")).toContainText("Import failed");
  expect(await snapshot(page)).toEqual(before);
  expect(await keys()).toBe(originalKeys);
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
  await page.locator("#more").click();
  await page.getByRole("switch", { name: "Show captions", exact: true }).check(); await saveDialog(page);
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
  await page.locator("#paste-button").evaluate(button => button.click());
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
  expect(saved.state.tabs[0].sections[0].items[0].sourceImageUrl).toBe("https://example.test/not-the-page.png");
  expect(saved.state.tabs[0].sections[0].items[1].sourceImageUrl).toBe("https://example.test/picture.png");
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
  await offlinePage.getByRole("button", { name: "Open original image: source.png", exact: true }).click();
  await expect(offlinePage.locator("#viewer-original")).toHaveAttribute("href", "https://example.test/photo.png");
  await expect(offlinePage.locator("#viewer-download")).toHaveAttribute("href", /^blob:/);
  await expect(offlinePage.locator("#viewer-stage")).toHaveCSS("padding-left", "0px");
  await expect(offlinePage.locator("#viewer-stage")).toHaveCSS("padding-right", "0px");
  await offline.close();
  await page.locator("#more").click();
  const jsonEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
  const jsonDownload = await jsonEvent, jsonPath = testInfo.outputPath("source-backup.json"); await jsonDownload.saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  expect(backup.state.tabs.every((tab) => tab.sections[0].items[0].sourceUrl === url)).toBe(true);
  expect(backup.state.tabs.every((tab) => tab.sections[0].items[0].sourceImageUrl === "https://example.test/photo.png")).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles(jsonPath);
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".source-link")).toHaveAttribute("href", url);
  for (const tab of backup.state.tabs) for (const section of tab.sections) for (const item of section.items) { delete item.sourceUrl; delete item.sourceImageUrl; }
  delete backup.state.settings.showCaptions;
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator(".source-missing")).toHaveCount(0);
  await expect(page.locator(".image-card")).toHaveCount(1);
  const saved = await snapshot(page);
  expect(Buffer.from(saved.assets[0][1].bytes).equals(buffer)).toBe(true);
  await page.locator("#more").click();
  await expect(page.getByRole("switch", { name: "Show captions", exact: true })).not.toBeChecked();
});

test("each card has Move, Delete, Crop, More controls and deletion requires confirmation", async ({ page }) => {
  await ready(page); await upload(page, ["keep.png", "remove.png"], await png(page));
  const tools = page.locator(".image-card").last().locator(".card-tools");
  expect(await tools.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["Drag remove.png", "Delete image remove.png", "Crop image remove.png", "Edit image remove.png"]);
  await page.getByRole("button", { name: "Delete image remove.png", exact: true }).click();
  await page.locator("#delete-warning-cancel").click();
  await expect(page.locator(".image-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Delete image remove.png", exact: true }).click();
  await page.locator("#delete-warning-submit").click();
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
  await page.getByRole("button", { name: "Reset crop", exact: true }).click();
  await page.locator(".crop-frame").evaluate((frame, values) => {
    const resize = (key, count, shiftKey) => {
      for (let index = 0; index < count; index++) frame.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
    };
    resize("ArrowLeft", 100 - (values.width ?? 100), true);
    resize("ArrowUp", 100 - (values.height ?? 100), true);
    resize("ArrowRight", values.x ?? 0, false);
    resize("ArrowDown", values.y ?? 0, false);
  }, values);
}

test("crop is metadata-only, original editor and viewer retain full image, and reset/cancel work", async ({ page }) => {
  await ready(page); const bytes = await png(page, 600, 400);
  await upload(page, ["crop.png"], bytes);
  const original = await snapshot(page);
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
  await expect(page.locator(".crop-stage>img")).toHaveJSProperty("naturalWidth", 600);
  await expect(page.locator("#editor-title")).toHaveText("Crop image");
  await expect(page.locator("#editor-fields input, #editor-fields .hint")).toHaveCount(0);
  await expect(page.locator(".dialog-footer > #crop-reset")).toHaveCount(1);
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
  expect(await page.locator(".crop-frame").evaluate(node => parseFloat(node.style.left))).toBe(25);
  await page.getByRole("button", { name: "Reset crop", exact: true }).click();
  await page.locator("#cancel-editor").click();
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop.x).toBe(.25);
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
  await setCrop(page, { x: 80, width: 50 });
  expect(await page.locator(".crop-frame").evaluate(node => parseFloat(node.style.left))).toBe(50);
  await page.locator("#cancel-editor").click();
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0].crop.x).toBe(.25);
  await page.getByRole("button", { name: "Crop image crop.png", exact: true }).click();
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
    expect(await target.locator(".crop-frame").evaluate(node => parseFloat(node.style.left))).toBeCloseTo(5, 0);
    expect(await target.locator(".crop-frame").evaluate(node => parseFloat(node.style.width))).toBeCloseTo(60, 0);
    await drag(at(.35, .35), at(.45, .45));
    expect(await target.locator(".crop-frame").evaluate(node => parseFloat(node.style.left))).toBeCloseTo(15, 0);
    const corner = await target.locator("[data-corner=se]").boundingBox();
    await drag({ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, at(.85, .85));
    expect(await target.locator(".crop-frame").evaluate(node => parseFloat(node.style.width))).toBeCloseTo(70, 0);
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
  await ready(page); await showUploadButtons(page);
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

test("20px layout icons and square horizontally flipped edit control, with paste toolbar hidden", async ({ page }) => {
    await ready(page); await showUploadButtons(page);
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
      expect(edit.width).toBe(38); expect(edit.height).toBe(38);
      for (const icon of await page.locator(".view-switch svg, #edit-toggle svg, #add-images svg").all()) {
        const box = await icon.boundingBox(); expect(box.width).toBe(20); expect(box.height).toBe(20);
      }
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
    await expect(page.locator(".card-caption").first()).toBeHidden();
    await expect(page.locator(".card-caption").last()).toBeHidden();
    const shortcut = page.locator(".card-tools .source-button");
    await expect(shortcut).toHaveCount(1); await expect(shortcut).toHaveAttribute("href", source);
    await expect(shortcut).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "Edit image original-name.png", exact: true }).click();
    await expect(page.locator(".source-field-label .source-button")).toHaveAttribute("href", source);
    await page.locator("#cancel-editor").click();
    await page.locator("#more").click();
    await expect(page.locator("#editor-fields > .settings-manage").first().getByRole("heading", { name: "Manage", exact: true })).toBeVisible();
    await expect(page.locator("#editor [name=theme]")).toHaveCount(0);
    await expect(page.locator("#editor-extra").locator(":scope > *").nth(-2).locator("[name=accent]")).toHaveCount(1);
    await expect(page.getByRole("switch", { name: "Show captions", exact: true })).not.toBeChecked();
    await page.getByRole("switch", { name: "Show captions", exact: true }).check();
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
    await page.reload();
    await expect(page.locator(".source-link")).toBeVisible();
  });

test("compact Caption actions stay together and 30px commands overlay originals and crops in every layout", async ({ page }) => {
  await ready(page); const bytes = await png(page, 120, 160);
  await paste(page, ["overlay.png", "neighbor.png"], bytes, "SourceURL:https://example.test/article\r\n");
  await expect(page.locator(".image-card")).toHaveCount(2);
  await page.locator("#more").click();
  await expect(page.getByRole("heading", { name: "Caption", exact: true })).toBeVisible();
  await expect(page.locator("#editor-fields > .dialog-footer")).toHaveCount(1);
  expect(await page.locator(".dialog-footer").evaluate(footer => footer.previousElementSibling.querySelector("input").name)).toBe("showAddImages");
  for (const toggle of await page.locator(".caption-toggle").all()) {
    const label = await toggle.locator("span").boundingBox(), input = await toggle.locator("input").boundingBox();
    expect(input.width).toBe(28); expect(input.height).toBe(16);
    expect(input.x - label.x - label.width).toBeCloseTo(8, 0);
    expect(input.y + input.height / 2).toBeCloseTo(label.y + label.height / 2, 0);
  }
  await page.getByRole("switch", { name: "Show captions", exact: true }).check();
  await page.locator("#cancel-editor").click();
  await expect(page.locator(".card-caption").first()).toBeHidden();
  await page.locator("#more").click();
  await expect(page.getByRole("switch", { name: "Show captions", exact: true })).not.toBeChecked();
  await saveDialog(page);
  await page.getByRole("button", { name: "Edit image overlay.png", exact: true }).click();
  await expect(page.locator("#editor-form > .dialog-footer")).toHaveCount(1);
  await expect(page.locator("#editor")).not.toHaveClass(/settings-editor/);
  await page.locator("#cancel-editor").click();
  await page.getByRole("button", { name: "Crop image overlay.png", exact: true }).click();
  await setCrop(page, { x: 10, y: 10, width: 70, height: 80 }); await saveDialog(page);
  await page.locator("#zoom").evaluate(slider => { slider.value = 150; slider.dispatchEvent(new Event("input", { bubbles: true })); slider.dispatchEvent(new Event("change", { bubbles: true })); });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const layout of ["masonry", "grid", "list"]) {
      await page.locator(`button[data-layout=${layout}]`).click();
      for (const card of await page.locator(".image-card").all()) {
        await card.hover();
        await expect(card.locator(".card-caption")).toBeHidden();
        const frame = await card.locator(".image-frame").boundingBox(), tools = await card.locator(".card-tools").boundingBox();
        expect(tools.x).toBeGreaterThanOrEqual(frame.x);
        expect(tools.y).toBeGreaterThanOrEqual(frame.y);
        expect(tools.x + tools.width).toBeCloseTo(frame.x + frame.width - 4, 0);
        expect(tools.y + tools.height).toBeCloseTo(frame.y + frame.height - 4, 0);
        const bounds = await card.boundingBox();
        expect(bounds.height).toBeCloseTo(frame.height + 2, 0);
        for (const control of await card.locator(".card-tool").all()) {
          const box = await control.boundingBox(); expect(box.width).toBe(30); expect(box.height).toBe(30);
        }
        for (const icon of await card.locator(".card-tools svg").all()) {
          const box = await icon.boundingBox(); expect(box.width).toBe(20); expect(box.height).toBe(20);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
});

test("photo details follow the compact field order and the 20px site shortcut follows URL edits", async ({ page, context }) => {
  await ready(page); await paste(page, ["details.png"], await png(page), "SourceURL:https://example.test/original\r\n");
  await page.getByRole("button", { name: "Edit image details.png", exact: true }).click();
  expect(await page.locator("#editor-fields > .field > span").allTextContents()).toEqual(["Source page URL", "Section", "Position", "Notes", "Filename"]);
  await expect(page.locator("#editor-fields > .hint")).toHaveCount(1);
  await expect(page.locator("#editor-fields > .hint")).toContainText("Original:");
  await expect(page.locator("#editor")).not.toContainText("Never resized or recompressed.");
  await expect(page.locator("#editor")).not.toContainText("Saved automatically when the clipboard");
  const link = page.getByRole("link", { name: "Go to site for details.png", exact: true });
  await expect(link).toHaveAttribute("href", "https://example.test/original");
  const box = await link.boundingBox(); expect(box.width).toBe(20); expect(box.height).toBe(20);
  await page.locator("[name=sourceUrl]").fill("https://example.test/updated");
  await expect(link).toHaveAttribute("href", "https://example.test/updated");
  await context.route("https://example.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>Source</title>" }));
  const popupEvent = context.waitForEvent("page"); await link.click();
  const popup = await popupEvent; await popup.waitForLoadState(); expect(popup.url()).toBe("https://example.test/updated"); await popup.close();
  await page.locator("[name=sourceUrl]").fill("javascript:alert(1)");
  await expect(link).toHaveCount(0);
  await page.locator("[name=sourceUrl]").fill("");
  await expect(page.locator(".source-go")).toHaveCount(0);
  await page.locator("[name=notes]").fill("Placement notes."); await saveDialog(page);
  expect((await snapshot(page)).state.tabs[0].sections[0].items[0]).toMatchObject({ notes: "Placement notes.", sourceUrl: "" });
});

test("header controls are compact and Manage precedes captions without the removed menu actions", async ({ page }) => {
  await ready(page); await showUploadButtons(page);
  await expect(page.locator(".app-header .brand, .app-header .tagline")).toHaveCount(0);
  expect(await page.locator(".header-start > button").evaluateAll(buttons => buttons.map(button => button.id))).toEqual(["more", "html-library", "add-images"]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#save-status")).toBeVisible();
    expect((await page.locator(".app-header").boundingBox()).height).toBe(50);
    const upload = await page.locator("#add-images").boundingBox(), status = await page.locator("#save-status").boundingBox(), save = await page.locator("#save-portable").boundingBox();
    expect(status.x).toBeGreaterThanOrEqual(upload.x + upload.width);
    expect(save.x).toBeGreaterThanOrEqual(status.x + status.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.locator("#more").click();
  await expect(page.locator("#editor-title")).toBeHidden();
  await expect(page.locator("#editor")).not.toContainText("Make yourself at home");
  for (const name of ["Paste images", "Append at bottom"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  expect(await page.locator("#editor-fields > :first-child > :first-child").textContent()).toBe("Manage");
  const actions = await page.locator(".manage-actions").boundingBox(), captions = await page.locator(".caption-heading").boundingBox();
  expect(captions.y).toBeGreaterThan(actions.y + actions.height);
  expect(await page.locator(".settings-manage").evaluate(manage => [...manage.children].filter(node => node.classList.contains("hint")).every(node => node.previousElementSibling))).toBe(true);
});

test("local menu keeps GitHub controls visible but disabled, with offline backups still available", async ({ page, context }) => {
  await ready(page); await page.locator("#more").click();
  const info = page.getByRole("button", { name: "About management buttons", exact: true });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await expect(info).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#manage-help")).toHaveCount(0);
  for (const description of await page.locator(".button-description").all()) await expect(description).toBeHidden();
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  await expect(info).toHaveAttribute("aria-pressed", "true");
  await expect(info.locator("svg circle")).not.toHaveCSS("fill", "none");
  for (const description of await page.locator(".button-description").all()) await expect(description).toBeVisible();
  expect(await page.locator(".manage-action > .button").evaluateAll(nodes => nodes.every(node => node.nextElementSibling.id === node.getAttribute("aria-describedby")))).toBe(true);
  await expect(page.locator(".github-login + .button-description")).toContainText("Signing in there does not enable auto-sync");
  await expect(page.getByRole("button", { name: "Replace local with Github version", exact: true }).locator("..").locator(".button-description")).toContainText("Pending local edits are discarded");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  const icon = await info.locator("svg").boundingBox(); expect(icon.width).toBe(20); expect(icon.height).toBe(20);
  await info.focus(); await page.keyboard.press("Enter");
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await expect(info).toHaveAttribute("aria-pressed", "false");
  await expect(info.locator("svg circle")).toHaveCSS("fill", "none");
  for (const description of await page.locator(".button-description").all()) await expect(description).toBeHidden();
  await expect(page.locator(".github-action")).toHaveCount(5);
  for (const action of await page.locator(".github-action").all()) {
    await expect(action).toBeVisible(); await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute("title", /published website/);
  }
  await expect(page.getByRole("link", { name: "Login", exact: true })).toHaveAttribute("aria-disabled", "false");
  await context.setOffline(true);
  await info.click(); for (const description of await page.locator(".button-description").all()) await expect(description).toBeVisible();
  await expect(page.getByRole("link", { name: "Login", exact: true })).toHaveAttribute("aria-disabled", "true");
  for (const name of ["Export JSON backup", "Import JSON backup", "Offline & portability guide"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await context.setOffline(false);
  await expect(page.getByRole("link", { name: "Login", exact: true })).toHaveAttribute("aria-disabled", "false");
  for (const action of await page.locator(".github-action").all()) await expect(action).toBeDisabled();
  await expect(page.locator("#coupon-code")).toHaveValue("l33thelper");
  await expect(page.locator("#copy-coupon")).toBeEnabled();
  expect(await page.locator(".coupon-code").evaluate(node => node.parentElement.id === "editor-extra" && node === node.parentElement.lastElementChild)).toBe(true);
});

test("public coupon is copyable offline while actual GitHub credentials stay out of storage and exports", async ({ page, browser }, testInfo) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const client = await shared.open({ authenticated: true });
    await client.page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async value => { globalThis.copiedTestToken = value; } }
    }));
    await client.page.locator("#more").click();
    const token = client.page.locator("#coupon-code"), copy = client.page.locator("#copy-coupon");
    await expect(token).toHaveAttribute("type", "text");
    await expect(token).toBeEditable();
    await expect(token).toHaveValue("l33thelper");
    expect(await token.getAttribute("name")).toBeNull();
    expect(await client.page.evaluate(() => new FormData(document.querySelector("#editor-form")).has("coupon"))).toBe(false);
    await copy.click();
    expect(await client.page.evaluate(() => globalThis.copiedTestToken)).toBe("l33thelper");
    await client.context.setOffline(true);
    await expect(copy).toBeEnabled();
    await client.context.setOffline(false);
    const jsonEvent = client.page.waitForEvent("download");
    await client.page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
    const jsonPath = testInfo.outputPath("no-token.json"); await (await jsonEvent).saveAs(jsonPath);
    expect(fs.readFileSync(jsonPath, "utf8")).not.toContain("test-only-token");
    const htmlEvent = client.page.waitForEvent("download");
    await client.page.locator("#save-portable").evaluate(node => node.click());
    const htmlPath = testInfo.outputPath("no-token.html"); await (await htmlEvent).saveAs(htmlPath);
    expect(fs.readFileSync(htmlPath, "utf8")).not.toContain("test-only-token");
    expect(JSON.stringify(await snapshot(client.page))).not.toContain("test-only-token");
    expect(await client.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("test-only-token");
    await client.page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); }; });
    await copy.click(); await expect(client.page.locator("#notice")).toContainText("Could not copy the coupon");
    await client.page.getByRole("button", { name: "Disconnect GitHub", exact: true, includeHidden: true }).evaluate(node => node.click());
    await client.page.locator("#more").click();
    await expect(token).toHaveValue("l33thelper"); await expect(copy).toBeEnabled();
    await client.page.locator("#cancel-editor").click();
    await authenticateShared(client.page); await client.page.reload();
    await expect(client.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await client.page.locator("#more").click();
    await expect(token).toHaveValue("l33thelper"); await expect(copy).toBeEnabled();
    const icon = await copy.locator("svg").boundingBox(); expect(icon.width).toBe(20); expect(icon.height).toBe(20);
  } finally { await shared.close(); }
});

test("editable coupon saves to GitHub, other devices, backups and portable HTML, including queued offline edits", async ({ page, browser }, testInfo) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const client = await shared.open({ authenticated: true });
    await client.page.locator("#more").click();
    await client.page.locator("#coupon-code").fill("SUMMER20");
    await client.page.locator("#save-coupon").click();
    await expect(client.page.locator("#editor")).not.toBeVisible();
    await expect.poll(() => shared.record.board.state.settings.couponCode).toBe("SUMMER20");
    const other = await shared.open({ viewport: { width: 320, height: 800 } });
    await other.page.locator("#more").click();
    await expect(other.page.locator("#coupon-code")).toHaveValue("SUMMER20");
    const copy = await other.page.locator("#copy-coupon").boundingBox(), save = await other.page.locator("#save-coupon").boundingBox();
    expect(save.x).toBeGreaterThan(copy.x); expect(save.y).toBe(copy.y);
    expect(await other.page.locator("#save-coupon svg").boundingBox()).toMatchObject({ width: 20, height: 20 });
    await other.page.locator("#coupon-code").fill("Not synced yet");
    await other.page.locator("#save-coupon").click();
    await expect(other.page.locator("#save-status .auto-sync-link")).toBeVisible();
    for (const width of [320, 390, 768, 1440]) {
      await other.page.setViewportSize({ width, height: 800 });
      expect((await other.page.locator(".app-header").boundingBox()).height).toBe(50);
      await expect(other.page.locator("#save-status .auto-sync-link")).toHaveCSS("white-space", "nowrap");
      const bounds = await other.page.locator("#save-status .auto-sync-link").boundingBox();
      const portableBounds = await other.page.locator("#save-portable").boundingBox();
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(portableBounds.x);
      expect(bounds.height).toBeLessThanOrEqual(14);
      expect(await other.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await client.context.setOffline(true);
    await client.page.locator("#more").click();
    await client.page.locator("#coupon-code").fill("OFFLINE25");
    await client.page.locator("#save-coupon").click();
    await expect.poll(async () => (await snapshot(client.page)).state.settings.couponCode).toBe("OFFLINE25");
    expect(shared.record.board.state.settings.couponCode).toBe("SUMMER20");
    await client.page.locator("#more").click();
    const downloaded = client.page.waitForEvent("download");
    await client.page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
    const backup = testInfo.outputPath("saved-coupon.json"); await (await downloaded).saveAs(backup);
    expect(JSON.parse(fs.readFileSync(backup, "utf8")).state.settings.couponCode).toBe("OFFLINE25");
    const portableEvent = client.page.waitForEvent("download");
    await client.page.locator("#save-portable").evaluate(node => node.click());
    const portable = testInfo.outputPath("saved-coupon.html"); await (await portableEvent).saveAs(portable);
    expect(fs.readFileSync(portable, "utf8")).toContain('"couponCode":"OFFLINE25"');
    await client.page.locator("#cancel-editor").click();
    await client.context.setOffline(false);
    await expect.poll(() => shared.record.board.state.settings.couponCode).toBe("OFFLINE25");
    await client.page.reload(); await client.page.locator("#more").click();
    await expect(client.page.locator("#coupon-code")).toHaveValue("OFFLINE25");
    await client.page.locator("#coupon-code").fill("github_pat_" + "x".repeat(30));
    await client.page.locator("#save-coupon").click();
    await expect(client.page.locator("#notice")).toContainText("cannot contain GitHub access tokens");
    expect(shared.record.board.state.settings.couponCode).toBe("OFFLINE25");
  } finally { await shared.close(); }
});

test("GitHub login is first when disconnected and hidden after connecting", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const client = await shared.open();
    await client.page.locator("#more").click();
    await expect(client.page.locator(".manage-actions > :first-child").getByRole("link", { name: "Login", exact: true })).toHaveAttribute("href", "https://github.com/login");
    expect(await client.page.locator(".manage-actions > :first-child .button:not([hidden])").allTextContents()).toEqual(["Login", "Enable auto-sync"]);
    const disabledWidth = (await client.page.locator(".enable-auto-sync").boundingBox()).width;
    await expect(client.page.locator(".enable-auto-sync .sync-check")).toHaveCount(0);
    for (const action of await client.page.locator(".github-action").all()) await expect(action).toBeEnabled();
    await client.context.setOffline(true);
    for (const action of await client.page.locator(".github-action").all()) {
      await expect(action).toBeVisible(); await expect(action).toBeDisabled();
    }
    await expect(client.page.getByRole("link", { name: "Login", exact: true })).toHaveAttribute("aria-disabled", "true");
    await client.context.setOffline(false);
    for (const action of await client.page.locator(".github-action").all()) await expect(action).toBeEnabled();
    await expect(client.page.locator(".manage-actions > :nth-child(2) button")).toHaveText("Force re-sync");
    await expect(client.page.locator(".manage-actions > :nth-last-child(2) button")).toHaveText("Merge local with Github version");
    await expect(client.page.locator(".manage-actions > :last-child button")).toHaveText("Offline & portability guide");
    await expect(client.page.locator(".manage-actions > :nth-last-child(3) button")).toHaveText("Protect browser storage");
    expect(await client.page.locator(".manage-actions > :nth-last-child(4) button").allTextContents()).toEqual(["Export JSON backup", "Import JSON backup"]);
    expect(await client.page.locator(".destructive-actions button").allTextContents()).toEqual(["Replace Github with local version", "Replace local with Github version"]);
    await client.page.locator("#cancel-editor").click();
    await authenticateShared(client.page);
    await client.page.locator("#more").click();
    await expect(client.page.getByRole("link", { name: "Login", exact: true })).toHaveCount(0);
    await expect(client.page.locator(".enable-auto-sync .sync-check")).toHaveText("✓");
    expect((await client.page.locator(".enable-auto-sync").boundingBox()).width).toBe(disabledWidth);
    const disconnect = client.page.getByRole("button", { name: "Disconnect GitHub", exact: true, includeHidden: true });
    await expect(disconnect).toBeHidden();
    await disconnect.evaluate(node => node.click());
    await client.page.locator("#more").click();
    await expect(client.page.getByRole("link", { name: "Login", exact: true })).toBeVisible();
    await expect(client.page.locator(".enable-auto-sync .sync-check")).toHaveCount(0);
  } finally { await shared.close(); }
});

test("last successful GitHub sync shows a local date and time, persists, and does not advance for offline edits", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const client = await shared.open({ authenticated: true });
    await client.page.locator("#more").click();
    const stamp = await client.page.locator("#last-sync time").getAttribute("datetime");
    expect(Number.isFinite(Date.parse(stamp))).toBe(true);
    expect(await client.page.locator("#last-sync time").evaluate(node => node.textContent === new Date(node.dateTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }))).toBe(true);
    await client.page.locator("#cancel-editor").click();
    await client.context.setOffline(true);
    await paste(client.page, ["pending-offline.png"], fixture.bytes);
    await expect(client.page.locator(".image-card")).toHaveCount(2);
    await client.page.reload(); await expect(client.page.locator(".image-card")).toHaveCount(2);
    await client.page.locator("#more").click();
    await expect(client.page.locator("#last-sync time")).toHaveAttribute("datetime", stamp);
    await client.page.locator("#cancel-editor").click();
    await client.context.setOffline(false);
    await expect(client.page.locator("#save-status")).toHaveText("Saved here · Enable auto-sync");
    await authenticateShared(client.page);
    await client.page.locator("#more").click();
    const saved = await client.page.locator("#last-sync time").getAttribute("datetime");
    expect(Date.parse(saved)).toBeGreaterThan(Date.parse(stamp));
    await expect(client.page.locator("#manage-conflict")).toBeHidden();
  } finally { await shared.close(); }
});

test("delete-warning allowance counts ten actions, not ten images, and cancellation never grants a skip", async ({ page }) => {
  await ready(page); await upload(page, Array.from({ length: 24 }, (_, index) => `delete-${index}.png`), await png(page, 120, 160));
  await expect(page.locator("#delete-warning .hint")).toHaveCount(0);
  const removeFirst = async () => {
    await page.locator(".image-card").first().evaluate(card => card.scrollIntoView({ block: "center" }));
    await page.locator(".image-card").first().getByRole("button", { name: /^Delete image/ }).click();
  };
  await removeFirst(); await page.locator("#delete-skip").fill("10"); await page.locator("#delete-warning-cancel").click();
  await expect(page.locator(".image-card")).toHaveCount(24);
  await removeFirst(); await expect(page.locator("#delete-warning")).toBeVisible();
  for (const value of ["-1", "1.5", ""]) {
    await page.locator("#delete-skip").fill(value); await page.locator("#delete-warning-submit").click();
    await expect(page.locator("#delete-warning")).toBeVisible(); await expect(page.locator(".image-card")).toHaveCount(24);
  }
  await page.locator("#delete-skip").fill("10"); await page.locator("#delete-warning-submit").click();
  await expect(page.locator(".image-card")).toHaveCount(23);
  await page.locator(".select-image").evaluateAll(inputs => inputs.slice(0, 10).forEach(input => input.click()));
  await expect(page.locator("#selection-count")).toHaveText("10 selected");
  await page.locator("#delete-selected").click(); await expect(page.locator(".image-card")).toHaveCount(13);
  await expect(page.locator("#delete-warning")).not.toBeVisible();
  for (let index = 0; index < 9; index++) {
    await removeFirst(); await expect(page.locator(".image-card")).toHaveCount(12 - index);
    await expect(page.locator("#delete-warning")).not.toBeVisible();
  }
  await removeFirst(); await expect(page.locator("#delete-warning")).toBeVisible();
  await expect(page.locator(".image-card")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await removeFirst(); await expect(page.locator("#delete-warning")).toBeVisible();
  await page.locator("#delete-warning-submit").click(); await expect(page.locator(".image-card")).toHaveCount(3);
  await page.locator(".image-card").first().getByRole("button", { name: /^Edit image/ }).click();
  await page.locator("#editor-delete").click(); await expect(page.locator("#delete-warning")).toBeVisible();
  await page.locator("#delete-warning-cancel").click(); await expect(page.locator("#editor")).toBeVisible();
  await page.locator("#editor-delete").click(); await page.locator("#delete-skip").fill("1");
  await page.locator("#delete-warning-submit").click(); await expect(page.locator(".image-card")).toHaveCount(2);
  await expect(page.locator("#editor")).not.toBeVisible();
  await page.reload(); await expect(page.locator(".image-card")).toHaveCount(2);
  await removeFirst(); await expect(page.locator("#delete-warning")).toBeVisible();
});

test("lightbox uses the full screen width and links to explicit source images without inventing missing URLs", async ({ page, context }) => {
  await ready(page); const bytes = await png(page, 2400, 400);
  await paste(page, ["wide.png"], bytes, 'SourceURL:https://example.test/blog/article\r\n<img src="/images/full.png">');
  await expect(page.locator(".image-card")).toHaveCount(1);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Open original image: wide.png", exact: true }).click();
    await expect(page.locator("#viewer-original")).toHaveAttribute("href", "https://example.test/images/full.png");
    await expect(page.locator("#viewer-source")).toHaveAttribute("href", "https://example.test/blog/article");
    await expect(page.locator("#viewer-download")).toHaveAttribute("href", /^blob:/);
    const box = await page.locator("#viewer-image").boundingBox();
    expect(box.x).toBeCloseTo(0, 0); expect(box.width).toBeCloseTo(width, 0);
    await page.locator("#viewer-close").click();
  }
  await context.route("https://example.test/images/full.png", route => route.fulfill({ contentType: "image/png", body: bytes }));
  await page.getByRole("button", { name: "Open original image: wide.png", exact: true }).click();
  const popupEvent = context.waitForEvent("page"); await page.locator("#viewer-original").click();
  const popup = await popupEvent; await popup.waitForLoadState(); expect(popup.url()).toBe("https://example.test/images/full.png"); await popup.close();
  await page.locator("#viewer-close").click();
  for (const [name, html] of [
    ["ambiguous.png", '<img src="https://example.test/a.png"><img src="https://example.test/b.png">'],
    ["unsafe.png", '<img src="javascript:alert(1)">'],
    ["empty.png", 'SourceURL:https://example.test/blog\r\n<img src="">']
  ]) await paste(page, [name], bytes, html);
  await expect(page.locator(".image-card")).toHaveCount(4);
  expect((await snapshot(page)).state.tabs[0].sections[0].items.slice(1).every(item => item.sourceImageUrl === "")).toBe(true);
  await page.getByRole("button", { name: "Open original image: empty.png", exact: true }).click();
  await expect(page.locator("#viewer-original")).toHaveAttribute("href", /^blob:/);
});

test("tabs and layout controls form a shy sticky header that returns on upward scroll and keyboard focus", async ({ page }) => {
  await ready(page); await upload(page, Array.from({ length: 18 }, (_, index) => `scroll-${index}.png`), await png(page, 200, 400));
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.locator(".images")).toHaveAttribute("data-layout", "grid");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  const header = page.locator("#board-header");
  await expect(header).toHaveCSS("position", "sticky");
  await expect(header.locator("#tabs, .layout-tools")).toHaveCount(2);
  for (const width of [390, 1440]) {
    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => scrollTo(0, 500));
    await expect(header).toHaveClass(/shy-hidden/);
    await expect(page.locator(".app-header")).toHaveClass(/shy-hidden/);
    await page.evaluate(() => scrollTo(0, 400));
    await expect(header).not.toHaveClass(/shy-hidden/);
    await expect(page.locator(".app-header")).not.toHaveClass(/shy-hidden/);
    await expect(header).toHaveCSS("transform", "none");
    expect((await header.boundingBox()).y).toBeCloseTo(50, 0);
    await page.evaluate(() => scrollTo(0, 700)); await expect(header).toHaveClass(/shy-hidden/);
    await page.getByRole("button", { name: "Grid", exact: true }).focus();
    await expect(header).not.toHaveClass(/shy-hidden/);
    await page.evaluate(() => scrollTo(0, 0)); await expect(header).not.toHaveClass(/shy-hidden/);
  }
});

test("selection copies share one original but keep independent crops and compact toolbar buttons", async ({ page }, testInfo) => {
  await ready(page); const bytes = await png(page, 600, 400); await upload(page, ["shared-original.png"], bytes);
  await page.getByRole("checkbox", { name: "Select shared-original.png", exact: true }).check();
  await expect(page.locator(".selection-summary > #selection-count + #clear-selection")).toHaveCount(1);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of await page.locator("#selection-bar button").all()) {
      const box = await control.boundingBox(); expect(box.width).toBe(30); expect(box.height).toBe(30);
    }
    for (const icon of await page.locator("#selection-bar svg").all()) {
      const box = await icon.boundingBox(); expect(box.width).toBe(20); expect(box.height).toBe(20);
    }
  }
  await page.locator("#copy-to-selected").click(); await saveDialog(page);
  await expect(page.locator(".image-card")).toHaveCount(2);
  const copied = await snapshot(page), items = copied.state.tabs[0].sections[0].items;
  expect(copied.assets).toHaveLength(1); expect(items[0].assetId).toBe(items[1].assetId); expect(items[0].id).not.toBe(items[1].id);
  await page.locator(".image-card").first().getByRole("button", { name: "Crop image shared-original.png", exact: true }).click();
  await setCrop(page, { x: 10, y: 20, width: 50, height: 60 }); await saveDialog(page);
  expect((await snapshot(page)).state.tabs[0].sections[0].items[1].crop).toBeUndefined();
  await page.locator(".image-card").last().getByRole("button", { name: "Crop image shared-original.png", exact: true }).click();
  await setCrop(page, { x: 30, y: 10, width: 60, height: 70 }); await saveDialog(page);
  const saved = await snapshot(page), cropped = saved.state.tabs[0].sections[0].items;
  expect(cropped[0].crop).toEqual({ x: .1, y: .2, width: .5, height: .6 });
  expect(cropped[1].crop).toEqual({ x: .3, y: .1, width: .6, height: .7 });
  expect(saved.assets).toHaveLength(1); expect(Buffer.from(saved.assets[0][1].bytes).equals(bytes)).toBe(true);
  const event = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const output = testInfo.outputPath("shared-original.html"); await (await event).saveAs(output);
  const payload = portablePayload(fs.readFileSync(output, "utf8"));
  expect(payload.assets).toHaveLength(1); expect(payload.state.tabs[0].sections[0].items).toEqual(cropped);
  expect(Buffer.from(payload.assets[0][1].data.split(",")[1], "base64").equals(bytes)).toBe(true);
  await page.getByRole("checkbox", { name: "Select shared-original.png", exact: true }).first().check();
  await page.locator("#clear-selection").click(); await expect(page.locator("#selection-bar")).toBeHidden();
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
    await phone.page.getByRole("button", { name: "Delete image uploaded.png", exact: true }).click();
    await phone.page.locator("#delete-warning-submit").click();
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
    await expect(reader.locator("#save-status")).toHaveText("Saved on this device");
    await reader.locator("#more").click();
    await expect(reader.locator(".github-action")).toHaveCount(5);
    for (const action of await reader.locator(".github-action").all()) await expect(action).toBeDisabled();
    await expect(reader.getByRole("button", { name: "Export JSON backup", exact: true })).toBeEnabled();
    await offline.close();
    await device.context.setOffline(false);
    await expect(device.page.locator("#save-status")).toHaveText("Saved here · Enable auto-sync");
    const enable = device.page.locator("#save-status").getByRole("link", { name: "Enable auto-sync", exact: true });
    await expect(enable).toHaveAttribute("aria-disabled", "false");
    await enable.focus(); await device.page.keyboard.press("Enter");
    await expect(device.page.locator("#editor-title")).toHaveText("Enable auto-sync");
    await device.page.locator("[name=githubToken]").fill("test-only-token"); await saveDialog(device.page);
    await expect(device.page.locator("#save-status")).toHaveText("Saved to GitHub");
    expect(shared.record.board.assets).toHaveLength(2);
  } finally { await shared.close(); }
});

test("simultaneous independent public additions merge without duplicating originals or placements", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const a = await shared.open({ authenticated: true }), b = await shared.open({ authenticated: true });
    await b.context.setOffline(true);
    await paste(b.page, ["offline-B.png"], fixture.bytes); await expect(b.page.locator(".image-card")).toHaveCount(2);
    await paste(a.page, ["online-A.png"], fixture.bytes); await expect(a.page.locator(".image-card")).toHaveCount(2);
    await expect(a.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await b.context.setOffline(false);
    await expect(b.page.locator("#save-status")).toHaveText("Saved to GitHub");
    expect(await titles(b.page)).toEqual(["shared-original.png", "online-A.png", "offline-B.png"]);
    await b.page.locator("#more").click();
    await expect(b.page.locator("#manage-conflict")).toBeHidden();
    await expect(b.page.locator(".settings-manage > :nth-child(2)")).toHaveAttribute("id", "manage-conflict");
    const names = shared.record.board.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => item.title)));
    expect(names).toEqual(["shared-original.png", "online-A.png", "offline-B.png"]);
    expect(shared.record.board.state.tabs).toHaveLength(1);
  } finally { await shared.close(); }
});

test("first connection merges an existing local collection rather than discarding its images", async ({ page, browser, context }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const deviceContext = await browser.newContext({ serviceWorkers: "block" }), device = await deviceContext.newPage();
    await ready(device); await upload(device, ["local-only.png"], fixture.bytes);
    await shared.connect(deviceContext); await device.reload();
    await expect(device.locator("#save-status")).toHaveText("Saved here · Enable auto-sync");
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
  const embedded = portablePayload(contents);
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

test("failed original caching is explicit and cannot download a misleading partial portable copy", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    shared.corruptOriginal(); await shared.connect(context);
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#save-status")).toHaveText("Saved to GitHub");
    await expect(reader.locator("#notice")).toContainText("integrity check");
    await expect(reader.locator(".image-card")).toHaveCount(1);
    let downloads = 0; reader.on("download", () => downloads++);
    await reader.locator("#save-portable").click();
    await expect(reader.locator("#notice")).toContainText("integrity check");
    expect(downloads).toBe(0);
    expect((await snapshot(reader)).assets[0][1].bytes).toBeNull();
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
    await expect.poll(async () => (await snapshot(reader)).assets[0][1].bytes !== null).toBe(true);
    expect(Buffer.from((await snapshot(reader)).assets[0][1].bytes).equals(fixture.bytes)).toBe(true);
  } finally { await context.close(); await shared.close(); }
});

test("long section titles truncate and all upload buttons default hidden with a persistent settings toggle", async ({ page }) => {
  await ready(page);
  const name = "A very long section title ".repeat(5);
  await newSection(page, name);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const title = page.locator(".section-toggle strong").last();
    await expect(title).toHaveText(name.trim()); await expect(title).toHaveAttribute("title", name.trim());
    const metrics = await title.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).textOverflow, whiteSpace: getComputedStyle(node).whiteSpace }));
    if (width < 600) expect(metrics.scroll).toBeGreaterThan(metrics.client);
    expect(metrics.overflow).toBe("ellipsis"); expect(metrics.whiteSpace).toBe("nowrap");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await expect(page.locator("#add-images")).toBeHidden();
  for (const control of await page.locator(".section-upload").all()) await expect(control).toBeHidden();
  await paste(page, ["paste-without-buttons.png"], await png(page)); await expect(page.locator(".image-card")).toHaveCount(1);
  await showUploadButtons(page);
  await expect(page.locator("#add-images")).toBeVisible();
  await expect(page.locator(".section-upload").last()).toBeVisible();
  await page.reload(); await expect(page.locator("#add-images")).toBeVisible();
  expect((await snapshot(page)).state.settings.showAddImages).toBe(true);
  await page.locator("#more").click(); await page.getByRole("switch", { name: "Show Add image buttons", exact: true }).uncheck();
  await page.locator("#cancel-editor").click(); await expect(page.locator("#add-images")).toBeVisible();
  await page.locator("#more").click(); await page.getByRole("switch", { name: "Show Add image buttons", exact: true }).uncheck(); await saveDialog(page);
  await expect(page.locator("#add-images")).toBeHidden();
});

test("tab order dialog supports mouse, keyboard, cancellation and saved order without changing active tab", async ({ page }) => {
  await ready(page); await upload(page, ["retained.png"], await png(page));
  await newTab(page, "Second"); await newTab(page, "Third");
  const before = await snapshot(page);
  expect(await page.locator("#reorder-tabs").evaluate(node => node.previousElementSibling.id)).toBe("new-tab");
  await page.locator("#reorder-tabs").click();
  const handles = page.locator(".tab-order-handle"), rows = page.locator(".tab-order-row");
  const from = await handles.last().boundingBox(), to = await rows.first().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 3, { steps: 12 });
  await expect(page.locator(".tab-order-name").first()).toHaveText("Third");
  await page.mouse.up(); await page.locator("#cancel-editor").click();
  expect((await snapshot(page)).state.tabs.map(tab => tab.name)).toEqual(before.state.tabs.map(tab => tab.name));
  await page.locator("#reorder-tabs").click();
  await handles.last().focus(); await page.keyboard.press("Home"); await saveDialog(page);
  expect((await snapshot(page)).state.tabs.map(tab => tab.name)).toEqual(["Third", "My inspiration", "Second"]);
  expect((await snapshot(page)).state.activeTab).toBe(before.state.activeTab);
  expect((await snapshot(page)).assets).toEqual(before.assets);
  await page.reload(); await expect(page.locator(".tab-name").first()).toHaveText("Third");
  await page.locator("#edit-toggle").click(); await expect(page.locator("#reorder-tabs")).toBeHidden();
});

test("pending layout and empty-tab deletion rebase legacy metadata and keep receiving shared imports", async ({ page, browser }) => {
  const fixture = await sharedFixture(page);
  fixture.board.state.tabs.push({ id: "empty-tab", name: "Empty", sections: [] });
  const shared = await sharedHarness(browser, fixture.board);
  try {
    const author = await shared.open({ authenticated: true }), reader = await shared.open();
    await reader.context.setOffline(true);
    await reader.page.getByRole("button", { name: "Grid", exact: true }).click();
    await reader.page.locator('.tab[data-tab-id="empty-tab"]').dblclick();
    reader.page.once("dialog", dialog => dialog.accept()); await reader.page.locator("#editor-delete").click();
    await expect(reader.page.locator("#editor")).not.toBeVisible();
    await reader.page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open("moodboard-portable", 1); request.onsuccess = () => resolve(request.result); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), active = store.get("active");
        active.onsuccess = () => {
          const key = `cloud:${active.result}`, info = store.get(key);
          info.onsuccess = () => { const value = info.result; delete value.baseState; store.put(value, key); };
        }; tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      }); db.close();
    });
    await reader.page.reload();
    await paste(author.page, ["import-one.png"], fixture.bytes); await expect(author.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await reader.context.setOffline(false);
    await expect(reader.page.locator(".image-card")).toHaveCount(2);
    await expect(reader.page.locator("#save-status")).toContainText("Enable auto-sync");
    expect((await snapshot(reader.page)).state.settings.layout).toBe("grid");
    expect((await snapshot(reader.page)).state.tabs.map(tab => tab.name)).toEqual(["My inspiration"]);
    await paste(author.page, ["import-two.png"], fixture.bytes); await expect(author.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await reader.page.locator("#more").click(); await reader.page.getByRole("button", { name: "Force re-sync", exact: true }).click();
    await expect(reader.page.locator(".image-card")).toHaveCount(3);
    expect((await snapshot(reader.page)).state.settings.layout).toBe("grid");
    await authenticateShared(reader.page);
    expect(shared.record.board.state.settings.layout).toBe("grid");
    expect(shared.record.board.state.tabs.map(tab => tab.name)).toEqual(["My inspiration"]);
    expect(shared.record.board.assets).toHaveLength(3);
  } finally { await shared.close(); }
});

test("fresh mobile readers browse originals and tabs before a slow background original finishes", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), delayed = { ...fixture.board.assets[0][1], name: "delayed.png" };
  fixture.board.assets.push(["delayed", delayed]);
  fixture.board.state.tabs.push({ id: "outfits", name: "Outfits", sections: [{ id: "outfit-section", name: "Slow original", collapsed: false,
    items: [{ id: "outfit-item", assetId: "delayed", title: "delayed.png", notes: "" }] }] });
  const shared = await sharedHarness(browser, fixture.board), context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await shared.connect(context);
    await context.route(/\/images\/[^/]+-delayed\.png$/, async route => { await gate; await route.fallback(); });
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#save-status")).toHaveText("Saved to GitHub");
    await expect(reader.locator(".tab")).toHaveCount(2);
    await expect(reader.locator(".image-hit img")).toHaveJSProperty("naturalWidth", 120);
    expect((await snapshot(reader)).assets.find(([id]) => id === "delayed")[1].bytes).toBeNull();
    await reader.locator('.tab[data-tab-id="outfits"]').click(); await expect(reader.locator(".image-card")).toHaveCount(1);
    await reader.getByRole("button", { name: "Grid", exact: true }).click();
    await authenticateShared(reader);
    expect(shared.record.board.state.settings.layout).toBe("grid");
    expect((await snapshot(reader)).assets.find(([id]) => id === "delayed")[1].bytes).toBeNull();
    release();
    await expect(reader.locator(".image-hit img")).toHaveJSProperty("naturalWidth", 120);
    await expect.poll(async () => (await snapshot(reader)).assets.every(([, asset]) => asset.bytes !== null)).toBe(true);
  } finally { release(); await context.close(); await shared.close(); }
});

test("touch tab dragging supports cancellation and persistence", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await ready(page); await newTab(page, "Second"); await newTab(page, "Third");
    await page.locator("#reorder-tabs").click();
    const client = await context.newCDPSession(page);
    const drag = async cancel => {
      const from = await page.locator(".tab-order-handle").last().boundingBox(), to = await page.locator(".tab-order-row").first().boundingBox();
      const x = from.x + from.width / 2;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from.y + from.height / 2 }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: to.y + 2 }] });
      await expect(page.locator(".tab-order-name").first()).toHaveText("Third");
      await client.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
    };
    await drag(true); await expect(page.locator(".tab-order-name").first()).toHaveText("My inspiration");
    await drag(false); await saveDialog(page);
    await page.reload(); await expect(page.locator(".tab-name").first()).toHaveText("Third");
  } finally { await context.close(); }
});

test("collapse-all and details rearranging preserve state and keep current entries bold", async ({ page }) => {
  await ready(page); await newSection(page, "Second"); await newSection(page, "Third");
  await page.locator("#collapse-sections").click();
  await expect(page.locator(".section.collapsed")).toHaveCount(3);
  await expect(page.locator("#collapse-sections")).toBeDisabled();
  await page.reload(); await expect(page.locator(".section.collapsed")).toHaveCount(3);
  await page.getByRole("button", { name: "Edit section Third", exact: true }).click();
  await expect(page.locator("#editor .hint")).toHaveCount(0);
  const details = page.locator("#editor .rearrange-control");
  await expect(details).not.toHaveAttribute("open");
  expect(await details.evaluate(node => Boolean(node.previousElementSibling.querySelector("[name=position]")))).toBe(true);
  await details.locator("summary").click(); await expect(details.locator("strong")).toHaveText("Third");
  await details.locator(".tab-order-handle").last().press("Home");
  await expect(page.locator("#editor [name=position]")).toHaveValue("1");
  await saveDialog(page); await expect(page.locator(".section-toggle strong").first()).toHaveText("Third");
  await newTab(page, "Second tab"); await newTab(page, "Third tab"); await editTab(page);
  await expect(page.locator("#editor .hint")).toHaveCount(0);
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click(); await expect(details.locator("strong")).toHaveText("Third tab");
  await details.locator(".tab-order-handle").last().press("Home");
  await page.locator("#cancel-editor").click(); await expect(page.locator(".tab-name").first()).toHaveText("My inspiration");
  await editTab(page); await details.locator("summary").click();
  await details.locator(".tab-order-handle").last().press("Home"); await saveDialog(page);
  await expect(page.locator(".tab-name").first()).toHaveText("Third tab");
  await page.reload(); await expect(page.locator(".tab-name").first()).toHaveText("Third tab");
  await page.locator(".tab").filter({ hasText: "My inspiration" }).click();
  await expect(tabTitle(page)).toHaveText("My inspiration");
  await page.getByRole("button", { name: "Edit section Third", exact: true }).click();
  const target = (await snapshot(page)).state.tabs.find(tab => tab.name === "Second tab").id;
  await page.locator("#editor [name=tab]").selectOption(target);
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click(); await expect(details.locator(".tab-order-name")).toHaveText(["Third"]);
  await saveDialog(page); await expect(tabTitle(page)).toHaveText("Second tab");
  await expect(page.locator(".section-toggle strong")).toHaveText(["Third"]);
});

test("phone section header dragging cancels safely and persists dropped and keyboard orders", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await ready(page); await newSection(page, "Second"); await newSection(page, "Third");
    const before = (await snapshot(page)).state.tabs[0].sections.map(section => [section.id, section.collapsed]);
    const client = await context.newCDPSession(page);
    const drag = async cancel => {
      const from = await page.locator(".section-drag").last().boundingBox(), to = await page.locator(".section-header").first().boundingBox();
      const x = from.x + from.width / 2;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from.y + from.height / 2 }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: to.y + 2 }] });
      await expect(page.locator(".section-toggle strong").first()).toHaveText("Third");
      await client.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
    };
    await drag(true); await expect(page.locator(".section-toggle strong").first()).toHaveText("The little things");
    expect((await snapshot(page)).state.tabs[0].sections.map(section => [section.id, section.collapsed])).toEqual(before);
    await drag(false); await expect.poll(async () => (await snapshot(page)).state.tabs[0].sections[0].name).toBe("Third");
    expect((await snapshot(page)).state.tabs[0].sections.every(section => !section.collapsed)).toBe(true);
    await page.reload(); await expect(page.locator(".section-toggle strong").first()).toHaveText("Third");
    await page.locator(".section-drag").first().press("End");
    await expect.poll(async () => (await snapshot(page)).state.tabs[0].sections.at(-1).name).toBe("Third");
    const savedOrder = (await snapshot(page)).state.tabs[0].sections.map(section => section.name);
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    await page.locator(".section-drag").last().press("Home");
    await expect(page.locator("#notice")).toContainText("Could not save");
    await expect(page.locator(".section-toggle strong")).toHaveText(savedOrder);
    await page.locator("#edit-toggle").click(); await expect(page.locator(".section-drag").first()).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally { await context.close(); }
});

test("lightbox has square icon controls and links to every other section sharing the original", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["everywhere.png"], bytes);
  const saved = await snapshot(page), source = saved.state.tabs[0].sections[0].items[0];
  source.sourceUrl = "https://example.test/story"; source.sourceImageUrl = "https://example.test/original.png";
  saved.state.tabs[0].sections.push({ id: "also-here", name: "Also here", collapsed: false, items: [{ ...source, id: "copy-a" }, { ...source, id: "copy-b" }] });
  saved.state.tabs.push({ id: "elsewhere", name: "Elsewhere", sections: [{ id: "far-away", name: "Far away", collapsed: true, items: [{ ...source, id: "copy-c" }] }] });
  const [id, original] = saved.assets[0];
  const lines = [
    { format: "moodboard-lines", version: 1, state: saved.state, assetCount: 1 },
    [id, { name: original.name, width: original.width, height: original.height, data: `data:image/png;base64,${bytes.toString("base64")}` }]
  ].map(record => JSON.stringify(record)).join("\n");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "locations.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
  await expect(page.locator("#notice")).toContainText("Backup imported");
  await expect(page.locator(".image-card .source-button").first().locator("svg circle")).toHaveCount(1);
  for (const width of [1000, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.locator(".image-hit").first().click();
    await expect(page.locator("#viewer-source")).toHaveAccessibleName("Source webpage");
    await expect(page.locator("#viewer-source svg circle")).toHaveCount(1);
    await expect(page.locator("#viewer-original")).toHaveAccessibleName("Open original");
    await expect(page.locator("#viewer-original")).toHaveAttribute("href", source.sourceImageUrl);
    await expect(page.locator("#viewer-zoom")).toHaveAccessibleName("Actual size");
    const expand = await page.locator("#viewer-zoom svg").innerHTML();
    await page.locator("#viewer-zoom").click(); await expect(page.locator("#viewer-zoom")).toHaveAccessibleName("Fit image");
    expect(await page.locator("#viewer-zoom svg").innerHTML()).not.toBe(expand);
    const sizes = await page.locator("#viewer .viewer-button:visible").evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return [rect.width, rect.height]; }));
    expect(sizes.every(([width, height]) => width === 40 && height === 40)).toBe(true);
    await expect(page.locator("#viewer-locations")).not.toBeVisible();
    await expect(page.locator("#viewer-locations-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await page.locator("#viewer-locations-toggle").evaluate(node => node.nextElementSibling.id)).toBe("viewer-download");
    await page.locator("#viewer-locations-toggle").click();
    await expect(page.locator("#viewer-locations-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".viewer-location")).toHaveText(["My inspiration > Also here", "Elsewhere > Far away"]);
    const fontRatio = await page.locator(".viewer-location").first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) / parseFloat(getComputedStyle(node.parentElement).fontSize));
    expect(fontRatio).toBeCloseTo(0.7, 2);
    if (width === 1000) await page.locator("#viewer-close").click();
  }
  await page.getByRole("button", { name: "Elsewhere > Far away", exact: true }).click();
  await expect(page.locator("#viewer")).not.toBeVisible(); await expect(tabTitle(page)).toHaveText("Elsewhere");
  await expect(page.locator(".section")).not.toHaveClass(/collapsed/);
  expect((await snapshot(page)).state.tabs[1].sections[0].collapsed).toBe(false);
});

test("save status uses available header width without wrapping or pushing controls offscreen", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const device = await shared.open(); await setSpacing(device.page, 23);
    await expect(device.page.locator("#save-status")).toContainText("Enable auto-sync");
    for (const width of [1200, 800, 390, 320]) {
      await device.page.setViewportSize({ width, height: 844 });
      const metrics = await device.page.locator("#save-status").evaluate(node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return { whitespace: style.whiteSpace, maxWidth: style.maxWidth, height: rect.height, lineHeight: parseFloat(style.lineHeight), width: rect.width, scrollWidth: node.scrollWidth };
      });
      expect(metrics.whitespace).toBe("nowrap"); expect(metrics.maxWidth).toBe("none");
      expect(await device.page.locator("#save-status").evaluate(node => getComputedStyle(node).flexGrow)).toBe("1");
      expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1);
      if (width >= 800) { expect(metrics.width).toBeGreaterThan(110); expect(metrics.width + 1).toBeGreaterThanOrEqual(metrics.scrollWidth); }
      const right = await device.page.locator("#save-portable").evaluate(node => node.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(width);
      await expect.poll(() => device.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally { await shared.close(); }
});

test("populated section ends use slim paste gaps while empty sections keep large targets", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["first.png"], bytes);
  await setSpacing(page, 12); await newSection(page, "Empty");
  const populated = page.locator(".section").first(), empty = page.locator(".section").last();
  const end = populated.locator(".section-end");
  await expect(end).toHaveClass(/insert-slot.*section-end-slim/);
  expect(await end.evaluate(node => node.getBoundingClientRect().height)).toBe(12);
  expect(await populated.locator(".tile .insert-slot").evaluate(node => node.getBoundingClientRect().height)).toBe(12);
  expect(await empty.locator(".section-end").evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(132);
  await end.click(); await expect(end).toHaveClass(/chosen/);
  await paste(page, ["last.png"], bytes);
  await expect(populated.locator(".card-caption h3")).toHaveText(["first.png", "last.png"]);
  await expect(empty.locator(".image-card")).toHaveCount(0);
  await page.locator("#edit-toggle").click(); await expect(end).not.toBeVisible();
});

test("exports remain disabled while local storage is still opening", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: { open: () => ({}) } }); });
  await page.goto("/");
  await expect(page.locator("#save-status")).toHaveText("Opening your space…");
  await expect(page.locator("#save-portable")).toBeDisabled();
  await expect(page.locator("#export-selected")).toBeDisabled();
});

test("selected HTML exports include only chosen sections, deduplicate originals and stay independent", async ({ page, browser }, testInfo) => {
  await ready(page); const bytes = await png(page); await upload(page, ["shared.png", "excluded.png"], bytes);
  const original = await snapshot(page), [shared, excluded] = original.state.tabs[0].sections[0].items;
  original.state.tabs[0].sections[0].items = [shared];
  original.state.tabs[0].sections.push({ id: "shared-again", name: "Shared again", collapsed: true, items: [{ ...shared, id: "shared-copy" }] });
  original.state.tabs.push({ id: "excluded-tab", name: "Excluded tab", sections: [{ id: "excluded-section", name: "Excluded section", collapsed: false, items: [excluded] }] });
  original.state.tabs.push({ id: "empty-tab", name: "Empty tab", sections: [] });
  const records = original.assets.map(([id, asset]) => [id, { name: asset.name, width: asset.width, height: asset.height, data: `data:image/png;base64,${Buffer.from(asset.bytes).toString("base64")}` }]);
  const lines = [{ format: "moodboard-lines", version: 1, state: original.state, assetCount: records.length }, ...records].map(record => JSON.stringify(record)).join("\n");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "export-fixture.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
  await expect(page.locator("#notice")).toContainText("Backup imported");
  const before = await snapshot(page);
  const fullPath = testInfo.outputPath("full-board.html"), selectedPath = testInfo.outputPath("selected-board.html");
  let event = page.waitForEvent("download"); await page.locator("#save-portable").click(); await (await event).saveAs(fullPath);
  await page.locator("#export-selected").click();
  await expect(page.locator("#editor-submit")).toBeDisabled();
  await page.locator("#cancel-editor").click(); await editTab(page); await expect(page.locator("#editor-submit")).toBeEnabled(); await page.locator("#cancel-editor").click();
  await page.locator("#export-selected").click();
  const all = page.getByRole("checkbox", { name: "Select all tabs and sections", exact: true });
  await all.check(); await expect(page.locator("#editor-submit")).toBeEnabled();
  await all.uncheck(); await expect(page.locator("#editor-submit")).toBeDisabled();
  const master = page.getByRole("checkbox", { name: "Select all sections in My inspiration", exact: true });
  await master.check(); await page.locator(".export-tab > summary").first().click({ position: { x: 5, y: 15 } });
  await page.getByRole("checkbox", { name: "Export section Shared again in My inspiration", exact: true }).uncheck();
  await expect(master).toHaveJSProperty("indeterminate", true);
  await master.check(); await expect(master).toBeChecked();
  await page.getByRole("checkbox", { name: "Include tab Empty tab", exact: true }).check();
  await expect(page.locator(".export-summary")).toHaveText("2 tabs · 2 sections · 1 original image");
  event = page.waitForEvent("download"); await page.locator("#editor-submit").click();
  const download = await event; expect(download.suggestedFilename()).toContain("moodboard-selection-"); await download.saveAs(selectedPath);
  await expect(page.locator("#editor")).not.toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  const payload = portablePayload(fs.readFileSync(selectedPath, "utf8"));
  expect(payload.state.id).not.toBe(before.state.id); expect(payload.state.revision).toBe(0);
  expect(payload.state.tabs.map(tab => tab.name)).toEqual(["My inspiration", "Empty tab"]);
  expect(payload.state.tabs[0].sections.map(section => section.name)).toEqual(["The little things", "Shared again"]);
  expect(payload.assets).toHaveLength(1); expect(payload.assets[0][0]).toBe(shared.assetId);
  expect(Buffer.from(payload.assets[0][1].data.split(",")[1], "base64").equals(bytes)).toBe(true);
  const offline = await browser.newContext({ offline: true });
  try {
    const full = await offline.newPage(); await full.goto(pathToFileURL(fullPath).href);
    await expect(full.locator(".tab")).toHaveCount(3);
    const selected = await offline.newPage(); await selected.goto(pathToFileURL(selectedPath).href);
    await expect(selected.locator(".tab")).toHaveCount(2);
    await expect(selected.locator(".section")).toHaveCount(2);
    expect((await snapshot(selected)).assets).toHaveLength(1);
    expect((await snapshot(selected)).state.id).toBe(payload.state.id);
  } finally { await offline.close(); }
});

test("exporting only part of a memory-only board does not mark unexported edits safe to discard", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: { open() { throw new Error("Storage disabled"); } } }); });
    const page = await context.newPage(); await page.goto("http://127.0.0.1:8085/");
    await expect(page.locator("#save-status")).toHaveText("Export to keep changes");
    await page.locator("#image-files").setInputFiles([file("memory.png", await png(page))]);
    await expect(page.locator(".image-card")).toHaveCount(1);
    await page.locator("#export-selected").click();
    await page.getByRole("checkbox", { name: "Select all sections in My inspiration", exact: true }).check();
    const event = page.waitForEvent("download"); await page.locator("#editor-submit").click(); await event;
    await expect(page.locator("#editor")).not.toBeVisible();
    expect(await page.evaluate(() => !dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  } finally { await context.close(); }
});

test("selected export failures keep the chooser open and never download a partial board", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    shared.corruptOriginal(); await shared.connect(context);
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#notice")).toContainText("integrity check");
    const before = (await snapshot(reader)).state;
    await reader.locator("#export-selected").click();
    await reader.getByRole("checkbox", { name: "Select all tabs and sections", exact: true }).check();
    let downloads = 0; reader.on("download", () => downloads++);
    await reader.locator("#editor-submit").click();
    await expect(reader.locator("#editor-error")).toContainText("integrity check");
    await expect(reader.locator("#editor")).toBeVisible();
    expect(downloads).toBe(0); expect((await snapshot(reader)).state).toEqual(before);
  } finally { await context.close(); await shared.close(); }
});

test("batch original ZIP exports preserve bytes, safe names and selection deduplication for file transfer", async ({ page, browser }, testInfo) => {
  await ready(page);
  const first = await png(page), second = await png(page, 90, 150, "#123456"), third = await png(page, 240, 60, "#aa3344");
  await page.locator("#image-files").setInputFiles([file("same.png", first), file("same.png", second), file("你好.png", third)]);
  await expect(page.locator(".image-card")).toHaveCount(3);
  const saved = await snapshot(page), state = saved.state;
  state.tabs[0].sections[0].items.push({ ...state.tabs[0].sections[0].items[0], id: "extra-placement", crop: { x: 0, y: 0, width: 0.5, height: 0.5 } });
  saved.assets[2][1].name = "../你好.png";
  const records = saved.assets.map(([id, asset]) => [id, { name: asset.name, width: asset.width, height: asset.height, data: `data:image/png;base64,${Buffer.from(asset.bytes).toString("base64")}` }]);
  const lines = [{ format: "moodboard-lines", version: 1, state, assetCount: 3 }, ...records].map(record => JSON.stringify(record)).join("\n");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "zip-fixture.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
  await expect(page.locator(".image-card")).toHaveCount(4);
  await page.locator(".select-section").check();
  const before = await snapshot(page), event = page.waitForEvent("download");
  await page.locator("#download-selected").click();
  const download = await event, output = testInfo.outputPath("originals.zip"); await download.saveAs(output);
  const bytes = fs.readFileSync(output), extracted = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    expect(bytes.readUInt16LE(offset + 6) & 0x800).toBe(0x800);
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), start = offset + 30 + nameLength + extra;
    const data = bytes.subarray(start, start + size);
    expect(require("node:zlib").crc32(data)).toBe(bytes.readUInt32LE(offset + 14));
    extracted.push({ name, data }); offset = start + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  expect(bytes.readUInt16LE(bytes.length - 12)).toBe(3);
  expect(extracted.map(record => record.name)).toEqual(["same.png", "same (2).png", ".._你好.png"]);
  expect(extracted.map(record => record.data)).toEqual([first, second, third]);
  expect(await snapshot(page)).toEqual(before);
  const target = await browser.newContext(), destination = await target.newPage();
  try {
    await ready(destination);
    await destination.locator("#image-files").setInputFiles(extracted.map(record => file(record.name, record.data)));
    await expect(destination.locator(".image-card")).toHaveCount(3);
    expect((await snapshot(destination)).assets.map(([, asset]) => Buffer.from(asset.bytes))).toEqual([first, second, third]);
  } finally { await target.close(); }
  await page.locator("#clear-selection").click();
  await page.locator(".select-image").first().check();
  const singleEvent = page.waitForEvent("download"); await page.locator("#download-selected").click();
  const singlePath = testInfo.outputPath("single.zip"); await (await singleEvent).saveAs(singlePath);
  const single = fs.readFileSync(singlePath);
  expect(single.readUInt16LE(single.length - 12)).toBe(1);
});

test("memory-only portable isolation never touches browser storage and survives saved copies", async ({ page, browser }, testInfo) => {
  await ready(page); const bytes = await png(page); await upload(page, ["isolated.png"], bytes);
  const saved = await snapshot(page), original = saved.assets[0][1];
  const payload = { format: "moodboard", version: 1, state: saved.state, assets: [[saved.assets[0][0], {
    name: original.name, width: original.width, height: original.height, data: `data:image/png;base64,${bytes.toString("base64")}`
  }]] };
  const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
    .replace(/(<script id="portable-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + JSON.stringify(payload) + close)
    .replace(/(<script id="portable-options" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"memoryOnly":true}$2');
  const context = await browser.newContext({ offline: true });
  try {
    await context.addInitScript(() => {
      window.storageTouches = 0;
      const forbidden = () => { window.storageTouches++; throw new Error("Isolated file touched browser storage."); };
      Object.defineProperty(window, "indexedDB", { value: { open: forbidden } });
      Object.defineProperty(window, "BroadcastChannel", { value: forbidden });
      Object.defineProperty(navigator, "serviceWorker", { value: { register: forbidden } });
    });
    await context.route("http://127.0.0.1:8085/isolated.html", route => route.fulfill({ contentType: "text/html", body: source }));
    const isolated = await context.newPage(); await isolated.goto("http://127.0.0.1:8085/isolated.html");
    await expect(isolated.locator(".image-card")).toHaveCount(1);
    await expect(isolated.locator("#storage-warning")).toContainText("does not use browser autosave");
    await expect(isolated.locator("#connection-status")).toContainText("Memory-only portable");
    await setSpacing(isolated, 29);
    const event = isolated.waitForEvent("download"); await isolated.locator("#save-portable").click();
    const output = testInfo.outputPath("memory-only-copy.html"); await (await event).saveAs(output);
    expect(fs.readFileSync(output, "utf8")).toContain('<script id="portable-options" type="application/json">{"memoryOnly":true}</script>');
    const copy = await context.newPage(); await copy.goto(pathToFileURL(output).href);
    await expect(copy.locator(".image-card")).toHaveCount(1); await expect(copy.locator("#spacing")).toHaveValue("29");
    expect(await copy.evaluate(() => window.storageTouches)).toBe(0);
    expect(await isolated.evaluate(() => window.storageTouches)).toBe(0);
    expect(await snapshot(page)).toEqual(saved);
    await isolated.locator("#more").click();
    await expect(isolated.getByRole("button", { name: "Protect browser storage", exact: true })).toHaveCount(0);
    await expect(isolated.locator("#editor")).toContainText("in memory only");
    await isolated.locator("#cancel-editor").click();
    await isolated.locator("#export-selected").click();
    await isolated.getByRole("checkbox", { name: "Select all tabs and sections", exact: true }).check();
    const selectedEvent = isolated.waitForEvent("download"); await isolated.locator("#editor-submit").click();
    const selectedPath = testInfo.outputPath("isolated-selection.html"); await (await selectedEvent).saveAs(selectedPath);
    expect(fs.readFileSync(selectedPath, "utf8")).toContain('<script id="portable-options" type="application/json">{"memoryOnly":true}</script>');
  } finally { await context.close(); }
});

test("failed batch original download reports the error without a partial ZIP", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    shared.corruptOriginal(); await shared.connect(context);
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#notice")).toContainText("integrity check");
    await reader.locator(".select-image").check();
    let downloads = 0; reader.on("download", () => downloads++);
    await reader.locator("#download-selected").click();
    await expect(reader.locator("#notice")).toContainText("integrity check");
    await expect(reader.locator("#download-selected")).toBeEnabled();
    expect(downloads).toBe(0);
  } finally { await context.close(); await shared.close(); }
});

test.describe("portable storage recovery", () => {
test.use({ serviceWorkers: "block" });
test("portable files recover from staging, read and final-save storage failures without touching the existing board", async ({ page, context }, testInfo) => {
  await ready(page); const bytes = await png(page); await upload(page, ["existing.png"], bytes);
  const before = await snapshot(page), original = before.assets[0][1], state = structuredClone(before.state);
  state.id = "recovery-board";
  const payload = { format: "moodboard", version: 1, state, assets: [[before.assets[0][0], {
    name: original.name, width: original.width, height: original.height, data: `data:image/png;base64,${bytes.toString("base64")}`
  }]] };
  const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
    .replace(/(<script id="portable-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + JSON.stringify(payload) + close)
    .replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, "$1null$2");
  for (const failure of ["stage", "read", "final-save"]) {
    const reader = await context.newPage();
    await reader.addInitScript(failure => {
      const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.get = function(key) {
        if (failure === "read" && key === "recovery-board") throw new DOMException("Device read unavailable.", "UnknownError");
        return get.call(this, key);
      };
      IDBObjectStore.prototype.put = function(value, key) {
        if (failure === "stage" && value.blob instanceof Blob || failure === "final-save" && key === "recovery-board") {
          throw new DOMException("Device storage is full.", "QuotaExceededError");
        }
        return put.call(this, value, key);
      };
    }, failure);
    await reader.route(`http://127.0.0.1:8085/recovery-${failure}.html`, route => route.fulfill({ contentType: "text/html", body: source }));
    await reader.goto(`http://127.0.0.1:8085/recovery-${failure}.html`);
    await expect(reader.locator(".image-card")).toHaveCount(1);
    await expect(reader.locator("#storage-warning")).toContainText("Browser autosave failed");
    await expect(reader.locator("#storage-warning")).toContainText("Newer browser-only edits may not be included");
    await setSpacing(reader, 31);
    const event = reader.waitForEvent("download"); await reader.locator("#save-portable").click();
    const output = testInfo.outputPath(`recovered-${failure}.html`); await (await event).saveAs(output);
    const html = fs.readFileSync(output, "utf8");
    expect(html).toContain('<script id="portable-options" type="application/json">{"memoryOnly":true}</script>');
    expect(Buffer.from(portablePayload(html).assets[0][1].data.split(",")[1], "base64")).toEqual(bytes);
    expect(await snapshot(page)).toEqual(before);
    await reader.close();
  }
});
});

test("memory-only export checkbox produces independent files without browser autosave", async ({ page }, testInfo) => {
  await ready(page); await upload(page, ["travel.png"], await png(page));
  await page.locator("#export-selected").click();
  await page.getByRole("checkbox", { name: "Select all tabs and sections", exact: true }).check();
  const choice = page.getByRole("checkbox", { name: "Memory-only file (no browser autosave)", exact: true });
  await expect(choice).not.toBeChecked(); await choice.check();
  const event = page.waitForEvent("download"); await page.locator("#editor-submit").click();
  const output = testInfo.outputPath("travel-memory.html"); await (await event).saveAs(output);
  expect(fs.readFileSync(output, "utf8")).toContain('<script id="portable-options" type="application/json">{"memoryOnly":true}</script>');
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
});

test("button and native clipboard transfer originals and all photo details from a local HTML to another board", async ({ browser }, testInfo) => {
  const sourceContext = await browser.newContext({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
  const targetContext = await browser.newContext({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
  try {
    const setup = await sourceContext.newPage(); await ready(setup);
    const first = await png(setup, 140, 220, "#334455"), second = await png(setup, 300, 120, "#223344");
    await setup.locator("#image-files").setInputFiles([file("first-original.png", first), file("second-original.png", second)]);
    await expect(setup.locator(".image-card")).toHaveCount(2);
    const original = await snapshot(setup), entries = original.state.tabs[0].sections[0].items;
    entries.forEach((item, index) => Object.assign(item, {
      title: `Custom title ${index}`, notes: `Private organizing notes ${index}`,
      sourceUrl: `https://example.test/blog/${index}`, sourceImageUrl: `https://example.test/full/${index}.png`,
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.5 }
    }));
    const records = original.assets.map(([id, asset]) => [id, { name: asset.name, width: asset.width, height: asset.height, data: `data:image/png;base64,${Buffer.from(asset.bytes).toString("base64")}` }]);
    const lines = [{ format: "moodboard-lines", version: 1, state: original.state, assetCount: 2 }, ...records].map(record => JSON.stringify(record)).join("\n");
    setup.once("dialog", dialog => dialog.accept());
    await setup.locator("#backup-file").setInputFiles({ name: "metadata.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
    await expect(setup.locator("#notice")).toContainText("Backup imported");
    await setup.locator("#export-selected").click();
    await setup.getByRole("checkbox", { name: "Select all tabs and sections", exact: true }).check();
    await setup.getByRole("checkbox", { name: "Memory-only file (no browser autosave)", exact: true }).check();
    const download = setup.waitForEvent("download"); await setup.locator("#editor-submit").click();
    const output = testInfo.outputPath("clipboard-source.html"); await (await download).saveAs(output);
    const source = await sourceContext.newPage(); await source.goto(pathToFileURL(output).href);
    await expect(source.locator(".image-card")).toHaveCount(2);
    await source.locator(".select-section").check(); await source.locator("#copy-selected").click();
    await expect(source.locator("#notice")).toContainText("Copied 2 images with original files");
    const text = await source.evaluate(() => navigator.clipboard.readText());
    expect(text.startsWith("MOODBOARD_ORIGINALS_V1:")).toBe(true);
    const target = await targetContext.newPage(); await ready(target);
    await upload(target, ["existing.png"], await png(target, 60, 40, "#ff9933"));
    const targetBefore = await snapshot(target);
    await target.locator(".tile .insert-slot").first().click(); await target.keyboard.press("Control+v");
    await expect(target.locator(".image-card")).toHaveCount(3);
    const copied = await snapshot(target), items = copied.state.tabs[0].sections[0].items;
    for (let index = 0; index < 2; index++) {
      const { id, assetId, ...metadata } = items[index], { id: oldId, assetId: oldAssetId, ...expected } = entries[index];
      expect(metadata).toEqual(expected); expect(id).not.toBe(oldId);
      const asset = new Map(copied.assets).get(assetId);
      expect(Buffer.from(asset.bytes)).toEqual(index ? second : first);
      expect(asset.name).toBe(index ? "second-original.png" : "first-original.png");
    }
    expect(copied.state.settings).toEqual(targetBefore.state.settings);
    expect(copied.state.id).toBe(targetBefore.state.id);
    await source.keyboard.press("Control+c");
    await expect(source.locator("#notice")).toContainText("Copied 2 images with original files");
    await source.close();
    await target.evaluate(() => document.querySelector("#paste-button").click());
    await expect(target.locator(".image-card")).toHaveCount(5);
    expect((await snapshot(target)).assets).toHaveLength(3);
    const beforeFailure = await snapshot(target), corrupted = JSON.parse(text.slice("MOODBOARD_ORIGINALS_V1:".length));
    corrupted.assets[0][1].sha256 = "0".repeat(64);
    await target.evaluate(text => {
      const data = new DataTransfer(); data.setData("text/plain", text);
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, "MOODBOARD_ORIGINALS_V1:" + JSON.stringify(corrupted));
    await expect(target.locator("#notice")).toContainText("integrity check");
    expect(await snapshot(target)).toEqual(beforeFailure);
  } finally { await sourceContext.close(); await targetContext.close(); }
});

test("clipboard denial is explicit and leaves the board unchanged", async ({ page }) => {
  await ready(page); await upload(page, ["denied.png"], await png(page));
  const before = await snapshot(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: () => Promise.reject(new DOMException("Clipboard permission denied.", "NotAllowedError"))
    } });
  });
  await page.locator(".select-image").check(); await page.locator("#copy-selected").click();
  await expect(page.locator("#notice")).toContainText("Could not copy originals");
  expect(await snapshot(page)).toEqual(before);
});

test("page-icon library links every independent HTML without preloading and survives offline exports", async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  const before = await snapshot(page);
  const requests = [];
  page.on("request", request => { if (request.url().includes("/releases/download/")) requests.push(request.url()); });
  await page.getByRole("button", { name: "Separate HTML files", exact: true }).click();
  await expect(page.locator("#editor-title")).toHaveText("Separate HTML files");
  await expect(page.locator("#editor-fields h3")).toHaveCount(7);
  const links = await page.locator("#editor-fields a").evaluateAll(nodes => nodes.map(node => node.href));
  expect(links).toContain("https://wendyyuanlu.github.io/moodboard/");
  expect(links).toContain("https://wendyyuanlu.github.io/moodboard/hanfu-moodboard.html");
  expect(links).toContain("https://github.com/wendyyuanlu/moodboard/releases/download/campaign-boards-v1/index.html");
  await expect(page.locator("#save-portable")).toHaveText("Download");
  for (const row of await page.locator(".html-file-row").all()) {
    const heading = await row.locator("h3").boundingBox(), actions = await row.locator(".dialog-extra").boundingBox();
    expect(actions.x).toBeGreaterThanOrEqual(heading.x + heading.width);
    expect(Math.abs(heading.y + heading.height / 2 - actions.y - actions.height / 2)).toBeLessThan(2);
  }
  expect(links.filter(link => link.includes("releases/download/") && link.includes("/campaign-kyoto-"))).toHaveLength(3);
  expect(links.filter(link => link.includes("releases/download/") && link.includes("/campaign-hanashizuku-"))).toHaveLength(2);
  expect(links).toContain("https://wendyyuanlu.github.io/moodboard/campaign-kyoto-1.html");
  expect(links).toContain("https://wendyyuanlu.github.io/moodboard/campaign-hanashizuku-2.html");
  expect(requests).toEqual([]);
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#cancel-editor").click();
  const download = page.waitForEvent("download"); await page.locator("#save-portable").click();
  const filename = testInfo.outputPath("library-portable.html"); await (await download).saveAs(filename);
  const context = await browser.newContext({ offline: true, serviceWorkers: "block" });
  try {
    const portable = await context.newPage(); await portable.goto(pathToFileURL(filename).href);
    await portable.getByRole("button", { name: "Separate HTML files", exact: true }).click();
    await expect(portable.locator("#editor-fields a")).toHaveCount(14);
    await expect(portable.locator("#save-portable")).toHaveText("Download");
    const local = await portable.locator("a[data-local-file]").evaluateAll(nodes => nodes.map(node => node.href));
    expect(local).toContain(pathToFileURL(path.join(path.dirname(filename), "campaign-kyoto-1.html")).href);
    expect(local).toContain(pathToFileURL(path.join(path.dirname(filename), "campaign-hanashizuku-2.html")).href);
  } finally { await context.close(); }
});

test.describe("isolated online campaign pages", () => {
test.use({ serviceWorkers: "block" });
test("hosted campaign pages load full originals without a database and export verified offline HTML", async ({ page, browser }, testInfo) => {
  await ready(page);
  const bytes = [await png(page, 150, 240, "#112233"), await png(page, 320, 180, "#445566")];
  await page.locator("#image-files").setInputFiles(bytes.map((data, index) => file(`original-${index}.png`, data)));
  await expect(page.locator(".image-card")).toHaveCount(2);
  const saved = await snapshot(page), fixture = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  saved.state.tabs[0].sections[0].items[0].notes = "Preserve campaign source metadata";
  const originals = saved.assets.map(([id, asset], index) => {
    const sha256 = crypto.createHash("sha256").update(bytes[index]).digest("hex");
    return [id, { name: asset.name, width: asset.width, height: asset.height,
      remote: { url: `https://raw.githubusercontent.com/wendyyuanlu/moodboard/${"a".repeat(40)}/images/${sha256}-original-${index}.png`,
        sha: crypto.createHash("sha1").update(`blob ${bytes[index].length}\0`).update(bytes[index]).digest("hex"), mime: "image/png" } }];
  });
  const payload = { format: "moodboard", version: 1, state: saved.state, assets: originals };
  const html = fixture
    .replace(/(<script id="portable-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + JSON.stringify(payload) + close)
    .replace(/(<script id="portable-options" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"memoryOnly":true,"remoteOriginals":true}$2')
    .replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, "$1null$2");
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      window.storageTouches = 0;
      const forbidden = () => { window.storageTouches++; throw new Error("Hosted campaign touched browser storage"); };
      Object.defineProperty(window, "indexedDB", { value: { open: forbidden } });
      Object.defineProperty(window, "BroadcastChannel", { value: forbidden });
      Object.defineProperty(navigator, "serviceWorker", { value: { register: forbidden } });
    });
    await context.route("**/hosted-campaign.html", route => route.fulfill({ contentType: "text/html", body: html }));
    let corrupt = false, originalReads = 0;
    for (const [index, [, asset]] of originals.entries()) await context.route(asset.remote.url, route => {
      originalReads++;
      return route.fulfill({ contentType: "image/png", body: corrupt ? Buffer.from("corrupt") : bytes[index] });
    });
    const hosted = await context.newPage(); await hosted.goto("/hosted-campaign.html");
    await expect(hosted.locator(".image-card")).toHaveCount(2);
    await expect(hosted.locator("#storage-warning")).toContainText("not an offline copy");
    await expect(hosted.locator("#connection-status")).toContainText("Online campaign");
    await expect.poll(() => hosted.locator(".image-hit img").first().evaluate(image => image.naturalWidth)).toBe(150);
    const download = hosted.waitForEvent("download"); await hosted.locator("#save-portable").click();
    const output = testInfo.outputPath("hosted-to-offline.html"); await (await download).saveAs(output);
    const portable = portablePayload(fs.readFileSync(output, "utf8"));
    expect(portable.state).toEqual(saved.state);
    for (const [index, [, asset]] of portable.assets.entries()) expect(Buffer.from(asset.data.split(",")[1], "base64")).toEqual(bytes[index]);
    expect(originalReads).toBeGreaterThanOrEqual(2);
    let failedDownloads = 0; hosted.on("download", () => failedDownloads++);
    corrupt = true; await hosted.locator("#save-portable").click();
    await expect(hosted.locator("#notice")).toContainText("integrity check");
    expect(failedDownloads).toBe(0);
    await context.setOffline(true);
    const offline = await context.newPage(); await offline.goto(pathToFileURL(output).href);
    await expect(offline.locator(".image-card")).toHaveCount(2);
    await expect(offline.locator("#storage-warning")).toContainText("does not use browser autosave");
    expect(await hosted.evaluate(() => window.storageTouches)).toBe(0);
    expect(await offline.evaluate(() => window.storageTouches)).toBe(0);
  } finally { await context.close(); }
});

test("metadata-only originals require the explicit isolated online-page option", async ({ page }) => {
  await ready(page); await upload(page, ["keep.png"], await png(page));
  const before = await snapshot(page), fixture = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const payload = { format: "moodboard", version: 1, state: before.state, assets: before.assets.map(([id, asset]) => [id, {
    name: asset.name, width: asset.width, height: asset.height,
    remote: { url: `https://raw.githubusercontent.com/wendyyuanlu/moodboard/${"a".repeat(40)}/images/${"b".repeat(64)}-image.png`, sha: "c".repeat(40), mime: "image/png" }
  }]) };
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "not-offline.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
  await expect(page.locator("#notice")).toContainText("unsupported image");
  expect(await snapshot(page)).toEqual(before);
  const html = fixture
    .replace(/(<script id="portable-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + JSON.stringify(payload) + close)
    .replace(/(<script id="portable-options" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"memoryOnly":true}$2')
    .replace(/(<script id="cloud-config" type="application\/json">)[\s\S]*?(<\/script>)/, "$1null$2");
  await page.route("**/missing-online-option.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("/missing-online-option.html");
  await expect(page.locator("#storage-warning")).toContainText("unsupported image");
  await expect(page.locator(".image-card")).toHaveCount(0);
});
});

test("competing edits to the same notes still protect both versions with a real conflict", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const author = await shared.open({ authenticated: true }), reader = await shared.open({ authenticated: true });
    await reader.context.setOffline(true);
    for (const [device, value] of [[reader.page, "Local notes"], [author.page, "Shared notes"]]) {
      await device.getByRole("button", { name: "Edit image shared-original.png", exact: true }).click();
      await device.locator("#editor [name=notes]").fill(value); await saveDialog(device);
    }
    await expect(author.page.locator("#save-status")).toHaveText("Saved to GitHub");
    await reader.context.setOffline(false);
    await expect(reader.page.locator("#save-status")).toHaveText("Save conflict · kept on device");
    expect((await snapshot(reader.page)).state.tabs[0].sections[0].items[0].notes).toBe("Local notes");
    expect(shared.record.board.state.tabs[0].sections[0].items[0].notes).toBe("Shared notes");
    await reader.page.locator("#more").click(); await expect(reader.page.locator("#manage-conflict")).toBeVisible();
  } finally { await shared.close(); }
});

test("a GitHub branch race retries and rebases rather than leaving a permanent save conflict", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), shared = await sharedHarness(browser, fixture.board);
  try {
    const author = await shared.open({ authenticated: true });
    shared.raceNextSave();
    await paste(author.page, ["local-after-race.png"], fixture.bytes);
    await expect(author.page.locator(".image-card")).toHaveCount(3);
    await expect(author.page.locator("#save-status")).toHaveText("Saved to GitHub");
    expect(new Set(await titles(author.page))).toEqual(new Set(["shared-original.png", "racing-import.png", "local-after-race.png"]));
    expect(shared.record.board.state.tabs).toHaveLength(1);
  } finally { await shared.close(); }
});

test("JSON Lines backups restore originals and reject missing or duplicate records without replacement", async ({ page }) => {
  await ready(page); const bytes = await png(page); await upload(page, ["lines.png"], bytes);
  const saved = await snapshot(page);
  const header = { format: "moodboard-lines", version: 1, state: saved.state, assetCount: 1 };
  const [id, original] = saved.assets[0];
  const record = [id, { name: original.name, width: original.width, height: original.height, data: `data:image/png;base64,${bytes.toString("base64")}` }];
  const lines = JSON.stringify(header) + "\n" + JSON.stringify(record) + "\n";
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backup-file").setInputFiles({ name: "backup.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(lines) });
  await expect(page.locator("#notice")).toContainText("Backup imported");
  expect(Buffer.from((await snapshot(page)).assets[0][1].bytes).equals(bytes)).toBe(true);
  const restored = (await snapshot(page)).state;
  for (const invalid of [JSON.stringify(header) + "\n", lines + JSON.stringify(record) + "\n"]) {
    await page.locator("#backup-file").setInputFiles({ name: "bad.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(invalid) });
    await expect(page.locator("#notice")).toContainText("Import failed");
    expect((await snapshot(page)).state).toEqual(restored);
  }
});

test("exports above 512 MiB open offline and streaming JSON Lines restores every original", async ({ page, browser }, testInfo) => {
  test.setTimeout(240000);
  await ready(page); await upload(page, ["large-original.png"], await png(page));
  const expectedHash = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const read = (s, k) => new Promise(resolve => { const r = db.transaction(s).objectStore(s).get(k); r.onsuccess = () => resolve(r.result); });
    const id = await read("meta", "active"), board = await read("boards", id), original = board.assets[0][1];
    if (original.storageKey) original.blob = (await read("boards", original.storageKey)).blob;
    const blob = new Blob([original.blob, new Uint8Array(17 * 1024 * 1024)], { type: "image/png" });
    const item = board.state.tabs[0].sections[0].items[0];
    delete original.storageKey;
    board.assets = Array.from({ length: 24 }, (_, index) => [`asset-${index}`, { ...original, blob, name: `large-${index}.png` }]);
    board.state.tabs[0].sections[0].items = board.assets.map(([assetId], index) => ({ ...item, id: `item-${index}`, assetId }));
    board.state.revision++;
    await new Promise((resolve, reject) => { const tx = db.transaction("boards", "readwrite"); tx.objectStore("boards").put(board, id); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    db.close();
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  });
  await page.reload(); await expect(page.locator(".image-card")).toHaveCount(24);
  const portable = testInfo.outputPath("large-portable.html"), backup = testInfo.outputPath("large-backup.jsonl");
  const offline = await browser.newContext({ offline: true });
  const hashes = async reader => reader.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("moodboard-portable", 1); r.onsuccess = () => resolve(r.result); });
    const get = (s, k) => new Promise(resolve => { const r = db.transaction(s).objectStore(s).get(k); r.onsuccess = () => resolve(r.result); });
    const board = await get("boards", await get("meta", "active"));
    const result = [];
    for (const [, asset] of [board.assets[0], board.assets.at(-1)]) {
      const blob = asset.storageKey ? (await get("boards", asset.storageKey)).blob : asset.blob;
      result.push([...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join(""));
    }
    db.close();
    return { count: board.assets.length, hashes: result };
  });
  try {
    const htmlDownload = page.waitForEvent("download", { timeout: 120000 });
    await page.locator("#save-portable").click(); await (await htmlDownload).saveAs(portable);
    expect(fs.statSync(portable).size).toBeGreaterThan(512 * 1024 * 1024);
    const reader = await offline.newPage(), errors = [], requests = [];
    reader.on("pageerror", error => errors.push(error.message));
    reader.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await reader.goto(pathToFileURL(portable).href, { timeout: 120000 });
    await expect(reader.locator(".image-card")).toHaveCount(24, { timeout: 120000 });
    expect(await hashes(reader)).toEqual({ count: 24, hashes: [expectedHash, expectedHash] });
    expect(errors).toEqual([]); expect(requests).toEqual([]);
    await reader.close(); fs.unlinkSync(portable);
    await page.locator("#more").click();
    const jsonDownload = page.waitForEvent("download", { timeout: 120000 });
    await page.getByRole("button", { name: "Export JSON backup", exact: true }).click();
    const download = await jsonDownload; expect(download.suggestedFilename()).toMatch(/\.jsonl$/); await download.saveAs(backup);
    expect(fs.statSync(backup).size).toBeGreaterThan(512 * 1024 * 1024);
    await page.locator("#cancel-editor").click();
    page.once("dialog", dialog => dialog.accept()); await page.locator("#backup-file").setInputFiles(backup);
    await expect(page.locator("#notice")).toContainText("Backup imported", { timeout: 120000 });
    expect(await hashes(page)).toEqual({ count: 24, hashes: [expectedHash, expectedHash] });
  } finally {
    await offline.close();
    for (const file of [portable, backup]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test("background original decoding is serialized to bound phone pixel memory", async ({ page, browser }) => {
  const fixture = await sharedFixture(page), item = fixture.board.state.tabs[0].sections[0].items[0];
  for (let index = 0; index < 6; index++) {
    fixture.board.assets.push([`extra-${index}`, { ...fixture.board.assets[0][1], name: `extra-${index}.png` }]);
    fixture.board.state.tabs[0].sections[0].items.push({ ...item, id: `extra-item-${index}`, assetId: `extra-${index}` });
  }
  const shared = await sharedHarness(browser, fixture.board), context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      const decode = window.createImageBitmap; window.decoding = 0; window.maxDecoding = 0;
      window.createImageBitmap = async (...args) => {
        window.decoding++; window.maxDecoding = Math.max(window.maxDecoding, window.decoding);
        try { await new Promise(resolve => setTimeout(resolve, 60)); return await decode(...args); }
        finally { window.decoding--; }
      };
    });
    await shared.connect(context);
    const reader = await context.newPage(); await reader.goto("http://127.0.0.1:8085/");
    await expect(reader.locator("#save-status")).toHaveText("Saved to GitHub");
    await expect.poll(async () => {
      const record = await snapshot(reader);
      return record?.assets.length === 7 && record.assets.every(([, asset]) => asset.bytes !== null);
    }).toBe(true);
    expect(await reader.evaluate(() => window.maxDecoding)).toBe(1);
  } finally { await context.close(); await shared.close(); }
});
