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
  await page.locator("#new-section").click();
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

test("rapid paste positions, original bytes, full-size viewer and portable offline HTML", async ({ page, browser }, testInfo) => {
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const buffer = await png(page, 1920, 1080);
  await upload(page, ["A.png", "B.png"], buffer);
  await expect(page.locator(".image-card")).toHaveCount(2);
  await expect(page.locator(".card-caption").first()).toBeVisible();
  await expect(page.locator(".card-caption h3").first()).toBeHidden();
  await expect(page.locator(".card-meta").first()).toBeHidden();
  await expect(page.locator(".source-missing").first()).toHaveText("No source URL available");
  await expect(page.locator(".card-caption h3").first()).toHaveText("A.png");
  await expect(page.locator(".card-meta").first()).toContainText("1920 × 1080");
  await page.getByRole("button", { name: "Paste before B.png", exact: true }).click();
  await paste(page, ["C.png", "D.png"], buffer);
  await paste(page, ["E.png"], buffer);
  await expect.poll(() => titles(page)).toEqual(["A.png", "C.png", "D.png", "E.png", "B.png"]);
  await page.locator("#paste-bottom").click();
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
  await second.locator("#new-section").click();
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
  await expect(page.locator(".source-missing")).toHaveText("No source URL available");
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
  await page.locator("#paste-button").click();
  await expect(page.locator(".source-link")).toHaveAttribute("href", "https://example.test/original-page?one=1&two=2");
  await paste(page, ["open-graph.png"], buffer, '<meta property="og:url" content="https://example.test/og-page"><img src="https://example.test/picture.png">');
  await expect(page.locator(".source-link").last()).toHaveAttribute("href", "https://example.test/og-page");
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///C:/private/file.html", "https://user:password@example.test/page"]) {
    await paste(page, [`unsafe-${url.split(":")[0]}.png`], buffer, `SourceURL:${url}\r\n<link rel="canonical" href="${url}"><script>window.clipboardExecuted=true</script>`);
  }
  await expect(page.locator(".image-card")).toHaveCount(6);
  await expect(page.locator(".source-missing")).toHaveCount(4);
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
  await expect(page.locator(".source-missing")).toHaveText("No source URL available");
  await expect(page.locator(".image-card")).toHaveCount(1);
  const saved = await snapshot(page);
  expect(Buffer.from(saved.assets[0][1].bytes).equals(buffer)).toBe(true);
});

test("each card has Move, Delete, More controls and deletion requires confirmation", async ({ page }) => {
  await ready(page); await upload(page, ["keep.png", "remove.png"], await png(page));
  const tools = page.locator(".image-card").last().locator(".card-tools");
  expect(await tools.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["Drag remove.png", "Delete image remove.png", "Edit image remove.png"]);
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

test("hidden intro keeps uploads available and pencil edit toggle shares the layout row", async ({ page }) => {
  await ready(page);
  await expect(page.locator("section.intro")).toBeHidden();
  await expect(page.locator("#edit-toggle")).toHaveText("✎");
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
