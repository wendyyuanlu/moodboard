(() => {
  "use strict";
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const uid = () => globalThis.crypto?.randomUUID?.() || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const clone = (value) => structuredClone(value);
  const editor = $("#editor");
  const viewer = $("#viewer");
  const deleteWarning = $("#delete-warning");
  let deleteSkipsRemaining = 0, deleting = false;
  let state, db, openingDB, assets = new Map(), urls = new Map();
  let editable = true, selection = new Set(), sectionSelection = new Set(), cursor = null, editorAction, editorDelete, editorSuccess;
  let queue = Promise.resolve(), pending = 0, memoryOnly = false, dirty = false, exporting = false;
  let noticeTimer, viewItems = [], viewIndex = 0, internalClipboard = [];
  let suppressClickUntil = 0, gesture = null, dragFrame = 0, selectedTarget = null;
  let masonryFrame = 0, sectionOrdering;
  const masonryObserver = new ResizeObserver(() => scheduleMasonry());
  let channel;
  const { supportedImage, sourcePageURL, validCrop, validate } = MoodboardFormat;
  let isolatedPortable = JSON.parse($("#portable-options").textContent)?.memoryOnly === true;
  const cloudConfig = JSON.parse($("#cloud-config").textContent);
  const cloudEnabled = Boolean(!isolatedPortable && cloudConfig && location.protocol !== "file:" && location.origin === new URL(cloudConfig.site).origin && location.pathname.startsWith(new URL(cloudConfig.site).pathname));
  const github = cloudEnabled ? MoodboardGitHub.createGitHubStore(cloudConfig) : null;
  const couponCode = "l33thelper";
  let showManageHelp = false;
  let cloudInfo = { collection: cloudConfig?.collection, revision: null, dirty: false, lastSyncedAt: null };
  let cloudReady = false, cloudSaving = false, cloudConflict = false, cloudError = "", cloudTimer, lastCloudRead = 0;
  let shellReady = false, cachingOriginals = false, originalCacheError = "";
  const originalDownloads = new Map();
  let originalDecoder = Promise.resolve(), originalReadbackFailed = false;
  const cacheStorageReserve = 64 * 1024 * 1024;
  let cacheSpaceRequired = 0;
  const globeIcon = '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, className = "text-button") {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function setIcon(node, shapes) {
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${shapes}</svg>`;
  }
  function notify(message) {
    clearTimeout(noticeTimer);
    syncText($("#notice"), message);
    $("#notice").hidden = false;
    noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, 7000);
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function report(error) { console.error(error); notify(errorMessage(error)); }
  function warning(message) {
    $("#storage-warning").textContent = message;
    $("#storage-warning").hidden = false;
  }
  function activeTab(data = state) { return data.tabs.find((tab) => tab.id === data.activeTab); }
  function sections(data = state) { return data.tabs.flatMap((tab) => tab.sections); }
  function allItems(data = state) { return sections(data).flatMap((section) => section.items); }
  function findSection(sectionId, data = state) { return sections(data).find((section) => section.id === sectionId); }
  function tabItems() { return activeTab().sections.flatMap((section) => section.items); }
  function imageURL(assetId) {
    const asset = assets.get(assetId);
    if (!(asset.blob instanceof Blob)) return asset.remote.url;
    if (!urls.has(assetId)) urls.set(assetId, URL.createObjectURL(asset.blob));
    return urls.get(assetId);
  }
  function sizeText(size) {
    return size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  function sourceLink(item, className) {
    const sourceUrl = sourcePageURL(item.sourceUrl);
    if (!sourceUrl) return null;
    const link = el("a", className);
    link.href = sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open source page for ${item.title}`); link.title = "Open source page";
    setIcon(link, globeIcon);
    return link;
  }
  function clipboardSourcePage(html) {
    const header = html.match(/(?:^|[\r\n])SourceURL:\s*([^\r\n]+)/i);
    const fromHeader = sourcePageURL(header?.[1]);
    if (fromHeader) return fromHeader;
    // Template contents stay inert; never attach clipboard HTML to the page.
    const template = document.createElement("template");
    template.innerHTML = html;
    const canonical = template.content.querySelector('link[rel~="canonical"][href]');
    const openGraph = template.content.querySelector('meta[property="og:url"][content]');
    return sourcePageURL(canonical?.getAttribute("href")) || sourcePageURL(openGraph?.getAttribute("content"));
  }
  function clipboardSourceImage(html) {
    const template = document.createElement("template"); template.innerHTML = html;
    const base = clipboardSourcePage(html);
    const sources = new Set([...template.content.querySelectorAll("img[src]")].map((image) => {
      const value = image.getAttribute("src");
      if (!value?.trim()) return "";
      try { return sourcePageURL(new URL(value, base || undefined).href); } catch { return ""; }
    }).filter(Boolean));
    return sources.size === 1 ? [...sources][0] : "";
  }
  function initialState() {
    const tabId = uid();
    return { schema: 1, id: uid(), revision: 0, activeTab: tabId, settings: { layout: "masonry", zoom: matchMedia("(max-width: 600px)").matches ? 150 : 220, theme: "light", accent: "#637554", showCaptions: false, showFilenames: false, showUrls: true },
      tabs: [{ id: tabId, name: "My inspiration", sections: [{ id: uid(), name: "The little things", collapsed: false, items: [] }] }] };
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("moodboard-portable", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("boards");
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => {
        const connection = request.result;
        const disconnected = () => { if (db === connection) db = null; };
        connection.onclose = disconnected;
        connection.onversionchange = () => { disconnected(); connection.close(); };
        resolve(connection);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => warning("Close other moodboard windows so local storage can open.");
    });
  }
  async function storageDB() {
    if (db) return db;
    if (!openingDB) openingDB = openDB().then(connection => { db = connection; return connection; }).finally(() => { openingDB = null; });
    return openingDB;
  }
  async function storageTransaction(stores, mode, action) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const connection = await storageDB();
      try {
        return await new Promise((resolve, reject) => {
          const tx = connection.transaction(stores, mode);
          let result, failure;
          const fail = error => { if (!failure) { failure = error; tx.abort(); } };
          tx.oncomplete = () => resolve(result);
          tx.onabort = () => reject(failure || tx.error || new DOMException("The storage transaction was aborted.", "AbortError"));
          tx.onerror = () => { /* The abort handler preserves the underlying storage error. */ };
          try { action(tx, value => { result = value; }, fail); }
          catch (error) { fail(error); }
        });
      } catch (error) {
        if (attempt === 0 && ["InvalidStateError", "AbortError"].includes(error.name)) {
          if (db === connection) db = null;
          connection.close();
          continue;
        }
        throw error;
      }
    }
  }
  function readDB(store, key) {
    return storageTransaction(store, "readonly", (tx, result, fail) => {
      const records = tx.objectStore(store), request = records.get(key);
      request.onsuccess = () => {
        const record = request.result;
        result(record);
        if (store !== "boards" || !record?.assets) return;
        for (const [, asset] of record.assets) {
          if (!asset.storageKey) continue;
          const original = records.get(asset.storageKey);
          original.onsuccess = () => {
            if (!(original.result?.blob instanceof Blob)) { fail(new Error("A saved original image is missing. Reconnect and restore from GitHub or a backup.")); return; }
            asset.blob = original.result.blob;
          };
        }
      };
    });
  }
  const originalStorageKey = (boardId, assetId) => ["original", boardId, assetId];
  const storedOriginal = (asset, boardId, assetId) => Array.isArray(asset.storageKey) &&
    asset.storageKey.length === 3 && asset.storageKey[0] === "original" && asset.storageKey[1] === boardId && asset.storageKey[2] === assetId;
  async function persist(next, nextAssets, expectedRevision, syncMeta, activate = true) {
    if (memoryOnly) return;
    const added = [];
    try {
      await storageTransaction(["boards", "meta"], "readwrite", (tx, result, fail) => {
        const store = tx.objectStore("boards");
        const request = store.get(next.id);
        request.onsuccess = () => {
          try {
            if (request.result && request.result.state.revision !== expectedRevision) {
              fail(new Error("This collection changed in another window. Reload before editing to avoid overwriting it.")); return;
            }
            added.length = 0;
            const records = [...nextAssets].map(([id, asset]) => {
              const record = { ...asset }; delete record.blob; delete record.storageKey;
              if (asset.blob instanceof Blob) {
                record.storageKey = originalStorageKey(next.id, id);
                if (!storedOriginal(asset, next.id, id)) {
                  store.put({ blob: asset.blob }, record.storageKey);
                  added.push(id);
                }
              }
              return [id, record];
            });
            for (const [id, asset] of request.result?.assets || []) {
              if (storedOriginal(asset, next.id, id) && !(nextAssets.get(id)?.blob instanceof Blob)) store.delete(asset.storageKey);
            }
            store.put({ state: next, assets: records }, next.id);
            if (activate) tx.objectStore("meta").put(next.id, "active");
            if (syncMeta) tx.objectStore("meta").put(syncMeta, `cloud:${next.id}`);
          } catch (error) { fail(error); }
        };
      });
    } catch (error) {
      if (error.message.includes("another window")) throw error;
      throw new DOMException(`Could not save (${error.name}): ${errorMessage(error)} Nothing from this action was changed. Free space or export a portable copy and try again.`, error.name);
    }
    // Release newly downloaded Blob backing after IndexedDB has durably saved it.
    if (added.length) {
      for (const id of added) nextAssets.set(id, { ...nextAssets.get(id), storageKey: originalStorageKey(next.id, id) });
      try {
        await storageTransaction("boards", "readonly", (tx, result, fail) => {
          for (const id of added) {
            const storageKey = originalStorageKey(next.id, id), request = tx.objectStore("boards").get(storageKey);
            request.onsuccess = () => {
              if (!(request.result?.blob instanceof Blob)) { fail(new Error("A newly saved original image is missing.")); return; }
              nextAssets.set(id, { ...nextAssets.get(id), blob: request.result.blob, storageKey });
            };
          }
        });
      } catch (error) {
        warning(`Your changes were saved, but cached originals could not be reopened: ${errorMessage(error)} Reload before caching more images.`);
        originalCacheError = errorMessage(error);
        originalReadbackFailed = true;
      }
    }
  }
  function setSaveStatus() {
    let status = memoryOnly ? "Export to keep changes" : "Saved on this device";
    if (cloudEnabled) {
      status = cloudConflict ? "Save conflict · kept on device" : cloudSaving ? "Syncing with GitHub…"
        : cloudError ? cloudInfo.revision || allItems().length ? "Saved here · GitHub unavailable" : "Could not load GitHub board" : !cloudReady ? "Connecting to shared board…"
        : cloudInfo.dirty ? github.connected ? "Saved here · waiting for GitHub" : "Saved here · Enable auto-sync" : "Saved to GitHub";
      if (memoryOnly && cloudInfo.dirty) status = "In memory · export a backup";
    }
    syncText($("#save-status"), pending ? "Saving…" : status);
    $("#save-portable").disabled = exporting || pending > 0 || !state || Boolean(cloudEnabled && !cloudReady && !cloudInfo.revision && !allItems().length);
    $("#export-selected").disabled = $("#save-portable").disabled;
    $("#download-selected").disabled = exporting || pending > 0;
    updateGitHubControls();
  }
  function syncText(node, text) {
    const label = "Enable auto-sync";
    if (!cloudEnabled || !text.includes(label)) { node.textContent = text; return; }
    if (node.textContent === text && node.querySelector(".auto-sync-link")) return;
    node.replaceChildren();
    text.split(label).forEach((part, index) => {
      if (index) {
        const link = el("a", "auto-sync-link", label); link.href = "#enable-auto-sync";
        link.addEventListener("click", (event) => { event.preventDefault(); if (navigator.onLine) connectGitHub(); });
        node.append(link);
      }
      node.append(document.createTextNode(part));
    });
    updateGitHubControls();
  }
  function updateGitHubControls() {
    const conflict = $("#manage-conflict"), lastSync = $("#last-sync");
    if (conflict) conflict.hidden = !cloudConflict;
    if (lastSync) {
      lastSync.replaceChildren(document.createTextNode("Last sync: "));
      if (cloudEnabled && cloudInfo.lastSyncedAt) {
        const date = new Date(cloudInfo.lastSyncedAt);
        const time = el("time", "", date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }));
        time.dateTime = date.toISOString(); lastSync.append(time);
      } else lastSync.append(document.createTextNode("Not synced on this device"));
    }
    const copyCoupon = $("#copy-coupon");
    if (copyCoupon) copyCoupon.disabled = !$("#coupon-code").value || $("#editor-submit").disabled;
    const unavailable = !navigator.onLine ? "Reconnect to the internet to use GitHub."
      : !cloudEnabled ? "GitHub sync is available on the published website. Local and portable copies save on this device." : "";
    for (const control of $$(".github-action")) {
      control.disabled = Boolean(unavailable) || $("#editor-submit").disabled;
      control.title = unavailable || (control.querySelector(".sync-check") ? "Auto-sync is enabled for this tab" : "");
    }
    for (const link of $$(".github-login, .auto-sync-link")) {
      link.setAttribute("aria-disabled", String(!navigator.onLine)); link.tabIndex = navigator.onLine ? 0 : -1;
      link.title = navigator.onLine ? "" : unavailable;
    }
  }
  function enqueue(action, reportFailure = true) {
    pending++; setSaveStatus();
    const result = queue.then(action);
    queue = result.catch(error => { if (reportFailure) report(error); }).finally(() => { pending--; setSaveStatus(); });
    return result;
  }
  async function commit(change, additions = new Map()) {
    const next = clone(state);
    const nextAssets = new Map([...assets, ...additions]);
    change(next);
    next.revision = state.revision + 1;
    const used = new Set(allItems(next).map((item) => item.assetId));
    for (const key of nextAssets.keys()) if (!used.has(key)) nextAssets.delete(key);
    validate(next, nextAssets);
    await persist(next, nextAssets, state.revision, cloudEnabled ? { ...cloudInfo, dirty: true } : undefined);
    state = next; assets = nextAssets; dirty = true;
    if (cloudEnabled) { cloudInfo.dirty = true; scheduleCloud(); }
    for (const [key, url] of urls) if (!assets.has(key)) { URL.revokeObjectURL(url); urls.delete(key); }
    selection = new Set([...selection].filter((id) => tabItems().some((item) => item.id === id)));
    sectionSelection = new Set([...sectionSelection].filter((id) => activeTab().sections.some((section) => section.id === id)));
    if (cursor && !activeTab().sections.some((section) => section.id === cursor.sectionId)) cursor = null;
    if (cursor?.beforeId && !findSection(cursor.sectionId).items.some((item) => item.id === cursor.beforeId)) cursor.beforeId = null;
    render();
    channel?.postMessage({ id: state.id, revision: state.revision });
  }
  function mutate(change) { enqueue(() => commit(change)).catch(() => {}); }
  function setCursor(sectionId, beforeId = null) {
    cursor = { sectionId, beforeId };
    renderCursor(); notify("Paste location set. Paste images here, or choose another gap.");
  }
  function resolveTarget(target, data = state) {
    const tab = activeTab(data);
    let section = target && tab.sections.find((section) => section.id === target.sectionId);
    if (!section) section = tab.sections.at(-1);
    if (!section) {
      section = { id: uid(), name: "Collected images", collapsed: false, items: [] };
      tab.sections.push(section);
    }
    return { section, beforeId: target?.sectionId === section.id ? target.beforeId : null };
  }
  function insertItems(data, items, target) {
    const { section, beforeId } = resolveTarget(target, data);
    const before = section.items.findIndex((item) => item.id === beforeId);
    section.items.splice(before < 0 ? section.items.length : before, 0, ...items);
    section.collapsed = false;
  }

  function renderCursor() {
    const location = cursor && findSection(cursor.sectionId);
    const before = location?.items.find((item) => item.id === cursor.beforeId);
    $("#paste-location").textContent = location ? `Paste in ${location.name}${before ? ` · before “${before.title}”` : " · at the end"}` : "Paste at the bottom of this tab";
    for (const slot of $$("[data-paste-section]")) {
      slot.classList.toggle("chosen", Boolean(cursor && slot.dataset.pasteSection === cursor.sectionId && (slot.dataset.before || null) === (cursor.beforeId || null)));
    }
  }
  function renderSelection() {
    for (const card of $$(".image-card")) {
      const selected = selection.has(card.dataset.itemId);
      card.classList.toggle("selected", selected);
      $(".select-image", card).checked = selected;
    }
    for (const section of $$(".section")) {
      const selected = sectionSelection.has(section.dataset.sectionId);
      section.classList.toggle("section-selected", selected);
      $(".select-section", section).checked = selected;
    }
    const wholeSections = sectionSelection.size > 0, count = wholeSections ? sectionSelection.size : selection.size;
    $("#selection-bar").hidden = !editable || !count;
    $("#selection-bar").setAttribute("aria-label", wholeSections ? "Selected section actions" : "Selected image actions");
    $("#selection-count").textContent = wholeSections ? `${count} ${count === 1 ? "section" : "sections"} selected` : `${count} selected`;
    $("#select-section").hidden = wholeSections;
    $("#select-all").title = wholeSections ? "Select every section in this tab" : "Select every image in this tab";
    for (const [id, action] of [["copy-selected", "Copy"], ["move-selected", "Move"], ["delete-selected", "Delete"]]) {
      const label = `${action} selected ${wholeSections ? "sections" : "images"}`;
      $(`#${id}`).setAttribute("aria-label", label); $(`#${id}`).title = label;
    }
  }
  function createTabControl(tabId) {
    const control = button("", () => { if (!editor.open) switchTab(tabId); }, "tab");
    control.dataset.tabId = tabId;
    control.append(el("span", "tab-name"), el("small"));
    const edit = () => {
      if (editable && control.isConnected && !editor.open) openTab(state.tabs.find((tab) => tab.id === tabId));
    };
    control.addEventListener("dblclick", (event) => { event.preventDefault(); edit(); });
    control.addEventListener("keydown", (event) => { if (event.key === "F2") { event.preventDefault(); edit(); } });
    let holdTimer, start;
    const cancelHold = () => { clearTimeout(holdTimer); start = null; };
    control.addEventListener("pointerdown", (event) => {
      cancelHold();
      if (event.pointerType !== "touch" || !editable) return;
      start = { x: event.clientX, y: event.clientY };
      holdTimer = setTimeout(edit, 500);
    });
    control.addEventListener("pointermove", (event) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelHold();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) control.addEventListener(type, cancelHold);
    control.addEventListener("contextmenu", (event) => { if (editable) event.preventDefault(); });
    return control;
  }
  function renderTabs() {
    const container = $("#tabs");
    const existing = new Map($$(".tab", container).map((control) => [control.dataset.tabId, control]));
    const desired = state.tabs.map((tab) => {
      const control = existing.get(tab.id) || createTabControl(tab.id);
      $(".tab-name", control).textContent = tab.name;
      $("small", control).textContent = tab.sections.reduce((count, section) => count + section.items.length, 0);
      control.setAttribute("aria-current", String(tab.id === state.activeTab));
      control.title = editable ? "Double-click to edit · F2 · touch and hold" : tab.name;
      if (editable) control.setAttribute("aria-keyshortcuts", "F2"); else control.removeAttribute("aria-keyshortcuts");
      return control;
    });
    for (const control of existing.values()) if (!desired.includes(control)) control.remove();
    desired.forEach((control, index) => {
      if (container.children[index] !== control) container.insertBefore(control, container.children[index] || null);
    });
  }
  function render() {
    const current = activeTab();
    document.body.dataset.theme = state.settings.theme;
    document.body.classList.toggle("edit-off", !editable);
    document.body.classList.toggle("hide-add-images", !(state.settings.showAddImages ?? false));
    document.documentElement.style.setProperty("--accent", state.settings.accent);
    document.documentElement.style.setProperty("--tile-size", `${state.settings.zoom}px`);
    $("#zoom").value = state.settings.zoom;
    document.documentElement.style.setProperty("--card-gap", `${cardGap()}px`);
    $("#spacing").value = cardGap();
    $("#card-spacing").title = `Card spacing: ${cardGap()}px`;
    $("#edit-toggle").setAttribute("aria-label", editable ? "Turn editing off" : "Turn editing on");
    $("#edit-toggle").title = editable ? "Editing on — click to turn off" : "Editing off — click to turn on";
    $("#edit-toggle").setAttribute("aria-pressed", String(editable));
    $("#add-images").disabled = !editable;
    for (const control of $$("[data-layout]")) {
      if (control.tagName === "BUTTON") control.setAttribute("aria-pressed", String(control.dataset.layout === state.settings.layout));
    }
    renderTabs();
    masonryObserver.disconnect();
    sectionOrdering?.destroy();
    $("#sections").replaceChildren(...current.sections.map(renderSection));
    if (editable) sectionOrdering = sectionOrderHandles();
    $("#collapse-sections").disabled = !current.sections.some(section => !section.collapsed);
    renderCursor(); renderSelection(); setSaveStatus(); updateOfflineStatus();
    masonryObserver.observe($("#sections"));
    for (const card of $$(".image-card")) masonryObserver.observe(card);
    scheduleMasonry();
  }
  function scheduleMasonry() {
    cancelAnimationFrame(masonryFrame);
    masonryFrame = requestAnimationFrame(layoutMasonry);
  }
  function cardGap(data = state) {
    return data.settings.spacing ?? (innerWidth <= 600 ? 10 : 18);
  }
  function layoutMasonry() {
    if (!state) return;
    const gap = cardGap();
    document.documentElement.style.setProperty("--card-gap", `${gap}px`);
    for (const container of $$(".images[data-layout=masonry]")) {
      const tiles = [...container.children], width = container.clientWidth;
      if (!width || !tiles.length) { container.style.height = "0px"; continue; }
      const preferredSize = Number($("#zoom").value);
      const columns = Math.min(tiles.length, Math.max(1, Math.floor((width + gap) / (preferredSize + gap))));
      const tileWidth = (width - gap * (columns - 1)) / columns;
      const heights = Array(columns).fill(0);
      for (const tile of tiles) tile.style.width = `${tileWidth}px`;
      for (const tile of tiles) {
        const column = heights.indexOf(Math.min(...heights));
        tile.style.left = `${column * (tileWidth + gap)}px`;
        tile.style.top = `${heights[column]}px`;
        heights[column] += tile.getBoundingClientRect().height + (editable ? 0 : gap);
      }
      container.style.height = `${Math.max(...heights) - (editable ? 0 : gap)}px`;
    }
  }
  function slot(sectionId, beforeId, label, className = "insert-slot") {
    const control = button("", () => { if (editable) setCursor(sectionId, beforeId); }, className);
    control.dataset.pasteSection = sectionId;
    if (beforeId) control.dataset.before = beforeId;
    control.setAttribute("aria-label", label);
    control.append(el("span", "", className === "section-end" ? "+ Add or paste at the end" : "+ Paste here"));
    return control;
  }
  function renderSection(section) {
    const node = el("section", `section${section.collapsed ? " collapsed" : ""}`);
    node.dataset.sectionId = section.id;
    const header = el("div", "section-header");
    const toggle = button("", () => mutate((next) => { findSection(section.id, next).collapsed = !findSection(section.id, next).collapsed; }), "section-toggle");
    toggle.setAttribute("aria-expanded", String(!section.collapsed));
    const chevron = el("span", "chevron"); setIcon(chevron, '<path d="m6 9 6 6 6-6"/>');
    const title = el("strong", "", section.name); title.title = section.name;
    toggle.append(chevron, title);
    const actions = el("div", "section-actions edit-control");
    const drag = button("", () => {}, "icon-button section-drag");
    drag.setAttribute("aria-label", `Drag section ${section.name}`); drag.title = `Drag section ${section.name}`;
    setIcon(drag, '<path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01"/>');
    const add = button("", () => { setCursor(section.id); $("#image-files").click(); }, "icon-button section-upload");
    add.setAttribute("aria-label", `Add images to ${section.name}`); add.title = `Add images to ${section.name}`;
    add.append($("#add-images svg").cloneNode(true));
    const edit = button("···", () => openSection(section), "icon-button");
    setIcon(edit, '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>');
    edit.setAttribute("aria-label", `Edit section ${section.name}`);
    const check = el("input", "select-section"); check.type = "checkbox";
    check.setAttribute("aria-label", `Select section ${section.name}`);
    check.addEventListener("change", () => {
      selection.clear();
      if (check.checked) sectionSelection.add(section.id); else sectionSelection.delete(section.id);
      renderSelection();
    });
    const checkArea = el("label", "section-selection"); checkArea.append(check);
    actions.append(checkArea, drag, add, edit);
    header.append(toggle, el("small", "section-count", String(section.items.length)), actions); node.append(header);
    const body = el("div", "section-body");
    body.hidden = section.collapsed;
    const images = el("div", "images"); images.dataset.layout = state.settings.layout;
    for (const item of section.items) images.append(renderItem(item, section.id));
    body.append(images);
    const end = slot(section.id, null, `Paste at end of ${section.name}`, "section-end");
    if (!section.items.length) {
      const empty = el("div", "empty-section edit-control");
      empty.append(end);
      body.append(empty);
    } else {
      end.classList.add("insert-slot", "section-end-slim"); end.firstElementChild.textContent = "+ Paste here";
      body.append(end);
    }
    node.append(body);
    return node;
  }
  function renderItem(item, sectionId) {
    const asset = assets.get(item.assetId);
    const tile = el("div", "tile"); tile.dataset.tileId = item.id;
    tile.append(slot(sectionId, item.id, `Paste before ${item.title}`));
    const card = el("article", "image-card"); card.dataset.itemId = item.id; card.dataset.sectionId = sectionId;
    const hit = button("", (event) => {
      if (performance.now() < suppressClickUntil) return;
      if (editable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
        sectionSelection.clear();
        if (event.shiftKey && selection.size) {
          const items = tabItems(); const start = items.findIndex((entry) => entry.id === [...selection].at(-1));
          const end = items.findIndex((entry) => entry.id === item.id);
          for (let index = Math.min(start, end); index <= Math.max(start, end); index++) if (items[index]) selection.add(items[index].id);
        } else if (selection.has(item.id)) selection.delete(item.id); else selection.add(item.id);
        renderSelection();
      } else openViewer(item.id);
    }, "image-hit");
    hit.setAttribute("aria-label", `Open original image: ${item.title}`);
    let img;
    if (item.crop) {
      const svg = (name) => document.createElementNS("http://www.w3.org/2000/svg", name);
      const { x, y, width, height } = item.crop;
      const rect = { x: x * asset.width, y: y * asset.height, width: width * asset.width, height: height * asset.height };
      img = svg("svg"); img.classList.add("cropped-preview"); img.setAttribute("role", "img"); img.setAttribute("aria-label", item.title);
      img.setAttribute("viewBox", `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
      img.setAttribute("width", rect.width); img.setAttribute("height", rect.height);
      // The nested viewport clips the original even in letterboxed Grid/List views.
      const viewport = svg("svg");
      for (const [key, value] of Object.entries(rect)) viewport.setAttribute(key, value);
      viewport.setAttribute("viewBox", `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
      viewport.setAttribute("overflow", "hidden");
      const original = svg("image");
      original.setAttribute("href", imageURL(item.assetId)); original.setAttribute("width", asset.width); original.setAttribute("height", asset.height);
      viewport.append(original); img.append(viewport);
      original.addEventListener("error", () => notify(`Could not display the crop of “${item.title}”. Open the original or reset its crop.`), { once: true });
    } else {
      img = el("img"); img.src = imageURL(item.assetId); img.alt = item.title; img.loading = "lazy"; img.decoding = "async"; img.draggable = false;
      img.width = asset.width; img.height = asset.height;
    }
    img.addEventListener("error", () => notify(`Could not display “${item.title}”. ${assets.get(item.assetId)?.blob
      ? "The saved original is still available for export."
      : originalCacheError || "This original is not cached yet. Stay online and use Force re-sync to retry."}`), { once: true });
    const caption = el("div", "card-caption"), filename = el("h3", "", item.title);
    filename.hidden = !(state.settings.showFilenames ?? false); caption.append(filename);
    if (item.notes) caption.append(el("p", "", item.notes));
    caption.append(el("small", "card-meta", `${asset.width} × ${asset.height} · ${asset.blob ? sizeText(asset.blob.size) : "original not cached yet"}`));
    const sourceUrl = sourcePageURL(item.sourceUrl);
    if (sourceUrl) {
      const link = el("a", "source-link", sourceUrl);
      link.href = sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.hidden = state.settings.showUrls === false;
      caption.append(link);
    }
    caption.hidden = !(state.settings.showCaptions ?? false) || (filename.hidden && (!sourceUrl || state.settings.showUrls === false));
    hit.append(img);
    const check = el("input", "select-image"); check.type = "checkbox";
    check.setAttribute("aria-label", `Select ${item.title}`);
    check.addEventListener("change", () => { sectionSelection.clear(); if (check.checked) selection.add(item.id); else selection.delete(item.id); renderSelection(); });
    const checkArea = el("label", "image-selection"); checkArea.append(check);
    const tools = el("div", "card-tools");
    const drag = button("⠿", () => {
      if (performance.now() >= suppressClickUntil) { sectionSelection.clear(); selection.add(item.id); renderSelection(); notify("Hold and drag to rearrange, or use Move to… below."); }
    }, "card-tool drag-handle");
    drag.setAttribute("aria-label", `Drag ${item.title}`);
    setIcon(drag, '<circle cx="8" cy="5" r="1"/><circle cx="16" cy="5" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="19" r="1"/>');
    const remove = button("×", () => { removeItems([item.id]).catch(report); }, "card-tool danger");
    remove.setAttribute("aria-label", `Delete image ${item.title}`);
    remove.title = "Delete image";
    setIcon(remove, '<path d="m6 6 12 12M18 6 6 18"/>');
    const crop = button("", () => openCrop(item.id), "card-tool");
    crop.setAttribute("aria-label", `Crop image ${item.title}`); crop.title = "Crop image";
    crop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v15h15M3 6h15v15M10 6h8v8"/></svg>';
    const edit = button("···", () => openImage(item.id), "card-tool");
    edit.setAttribute("aria-label", `Edit image ${item.title}`);
    setIcon(edit, '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>');
    tools.append(drag, remove, crop);
    const sourceButton = sourceLink(item, "card-tool source-button");
    if (sourceButton) tools.append(sourceButton);
    const frame = el("div", "image-frame");
    tools.append(edit); frame.append(hit, checkArea, tools); card.append(frame, caption); tile.append(card);
    return tile;
  }
  function switchTab(tabId) {
    if (state.activeTab === tabId) return;
    cursor = null; selection.clear(); sectionSelection.clear();
    mutate((next) => { next.activeTab = tabId; });
  }

  function field(labelText, name, value = "", type = "text", options) {
    const label = el("label", "field"); label.append(el("span", "", labelText));
    const control = el(options ? "select" : type === "textarea" ? "textarea" : "input");
    control.name = name;
    if (options) {
      for (const [key, title] of options) { const option = el("option", "", title); option.value = key; control.append(option); }
    } else if (type !== "textarea") control.type = type;
    control.value = value; label.append(control); $("#editor-fields").append(label);
    return control;
  }
  function hint(text) { const node = el("p", "hint"); syncText(node, text); $("#editor-fields").append(node); }
  function openEditor(title, save, remove) {
    $("#editor-form").append($(".dialog-footer"));
    $("#crop-reset")?.remove();
    editor.classList.remove("crop-editor", "settings-editor");
    editorSuccess = "Saved to your space.";
    editorAction = save; editorDelete = remove;
    $("#editor-form").reset(); $("#editor-fields").replaceChildren(); $("#editor-extra").replaceChildren();
    $("#editor-title").textContent = title; $("#editor-error").hidden = true;
    $("#editor-title").hidden = false;
    $("#editor-delete").hidden = !remove;
    $("#editor-submit").hidden = !save;
    $("#editor-submit").textContent = "Save";
    $("#editor-submit").disabled = false;
    $("#cancel-editor").textContent = save ? "Cancel" : "Done";
    if (!editor.open) editor.showModal();
  }
  function nameField(label, value) {
    const input = field(label, "name", value); input.required = true; input.maxLength = 150; return input;
  }
  function positionField(position, maximum) {
    const input = field("Position", "position", String(position), "number");
    input.min = 1; input.max = maximum; input.step = 1; input.required = true;
    return input;
  }
  function reorder(array, item, position) {
    const index = array.findIndex((entry) => entry.id === item.id);
    if (index >= 0) array.splice(index, 1);
    array.splice(Math.min(array.length, Math.max(0, Number(position) - 1)), 0, item);
  }
  function requireName(form) {
    const name = form.get("name").trim();
    if (!name) throw new Error("Please enter a name.");
    return name;
  }
  function duplicateSection(section) {
    return { ...clone(section), id: uid(), items: section.items.map((item) => ({ ...clone(item), id: uid() })) };
  }
  function applyOrder(entries, ids) {
    if (entries.length !== ids.length || new Set(ids).size !== ids.length || entries.some(entry => !ids.includes(entry.id))) {
      throw new Error("The collection changed while rearranging. Reopen it before saving.");
    }
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    entries.splice(0, entries.length, ...ids.map(id => byId.get(id)));
  }
  function sortable(list, handleSelector, onChange, page = false) {
    const owner = page ? document : editor;
    let drag = null, frame = 0;
    const rows = () => [...list.children];
    const ids = () => rows().map(row => row.dataset.orderId || row.dataset.sectionId);
    const update = () => {
      rows().forEach((row, index) => {
        if (!page) {
          row.setAttribute("aria-posinset", String(index + 1)); row.setAttribute("aria-setsize", String(list.children.length));
          $(handleSelector, row).setAttribute("aria-label", `Move ${$(".tab-order-name", row).textContent}, position ${index + 1} of ${list.children.length}`);
        }
      });
    };
    const finish = cancel => {
      if (!drag) return;
      const current = drag; drag = null; cancelAnimationFrame(frame);
      if (cancel) for (const row of current.order) list.append(row);
      current.row.classList.remove("reordering");
      if (page) {
        const top = current.row.getBoundingClientRect().top;
        document.body.classList.remove("section-sorting");
        if (cancel) scrollTo(0, current.scrollY);
        else scrollBy(0, current.row.getBoundingClientRect().top - top);
      }
      if (list.hasPointerCapture(current.pointerId)) list.releasePointerCapture(current.pointerId);
      update();
      if (!cancel && rows().some((row, index) => row !== current.order[index])) onChange(ids(), current.row.dataset.orderId || current.row.dataset.sectionId);
    };
    for (const row of rows()) {
      const handle = $(handleSelector, row);
      handle.addEventListener("keydown", event => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const order = rows(), index = order.indexOf(row);
        const destination = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1
          : Math.max(0, Math.min(order.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
        if (destination === index) return;
        order.splice(index, 1); order.splice(destination, 0, row);
        for (const entry of order) list.append(entry);
        update(); handle.focus(); onChange(ids(), row.dataset.orderId || row.dataset.sectionId);
      });
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || drag || pending) return;
        event.preventDefault(); handle.focus();
        drag = { row, pointerId: event.pointerId, y: event.clientY, order: rows(), scrollY };
        row.classList.add("reordering"); list.setPointerCapture(event.pointerId);
        if (page) {
          document.body.classList.add("section-sorting");
          scrollBy(0, row.getBoundingClientRect().top - event.clientY);
        }
        const scroll = () => {
          if (!drag) return;
          const bounds = page ? { top: 0, bottom: innerHeight } : list.getBoundingClientRect();
          const delta = drag.y < bounds.top + (page ? 160 : 36) ? -8 : drag.y > bounds.bottom - 36 ? 8 : 0;
          if (page) scrollBy(0, delta); else list.scrollTop += delta;
          const target = rows().find(entry => entry !== row && drag.y < entry.getBoundingClientRect().top + entry.getBoundingClientRect().height / 2);
          list.insertBefore(row, target || null);
          frame = requestAnimationFrame(scroll);
        };
        frame = requestAnimationFrame(scroll);
      });
    }
    const move = event => { if (drag?.pointerId === event.pointerId) { event.preventDefault(); drag.y = event.clientY; } };
    const drop = event => { if (drag?.pointerId === event.pointerId) finish(false); };
    const cancel = () => finish(true);
    const cancelDrag = event => { if (drag && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(true); } };
    list.addEventListener("pointermove", move); list.addEventListener("pointerup", drop);
    list.addEventListener("pointercancel", cancel); list.addEventListener("lostpointercapture", cancel);
    owner.addEventListener("keydown", cancelDrag, true);
    const destroy = () => {
      finish(true); list.removeEventListener("pointermove", move); list.removeEventListener("pointerup", drop);
      list.removeEventListener("pointercancel", cancel); list.removeEventListener("lostpointercapture", cancel);
      owner.removeEventListener("keydown", cancelDrag, true); owner.removeEventListener("close", destroy);
    };
    if (!page) owner.addEventListener("close", destroy, { once: true });
    update(); return { ids, update, destroy };
  }
  function orderList(entries, currentId, label, onChange = () => {}) {
    const list = el("div", "tab-order-list");
    list.setAttribute("role", "list"); list.setAttribute("aria-label", label);
    for (const entry of entries) {
      const row = el("div", "tab-order-row"), handle = button("", () => {}, "icon-button tab-order-handle");
      row.dataset.orderId = row.dataset.tabId = entry.id; row.setAttribute("role", "listitem");
      setIcon(handle, '<path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01"/>');
      const name = el(entry.id === currentId ? "strong" : "span", "tab-order-name", entry.name); name.title = entry.name;
      row.append(handle, name); list.append(row);
    }
    return { list, ...sortable(list, ".tab-order-handle", onChange) };
  }
  function rearrangeField(entries, currentId, position, label) {
    const details = el("details", "rearrange-control"); details.append(el("summary", "", "Rearrange"));
    const order = orderList(entries, currentId, label, ids => { position.value = ids.indexOf(currentId) + 1; });
    details.append(order.list); $("#editor-fields").append(details);
    const reposition = () => {
      const rows = [...order.list.children], current = rows.find(row => row.dataset.orderId === currentId);
      const others = [...order.list.children].filter(row => row !== current);
      order.list.insertBefore(current, others[Math.max(0, Math.min(others.length, Number(position.value) - 1))] || null);
      order.update();
    };
    position.addEventListener("input", reposition);
    return { ...order, details, destroy() { position.removeEventListener("input", reposition); order.destroy(); } };
  }
  function sectionOrderHandles() {
    const tabId = state.activeTab;
    return sortable($("#sections"), ".section-drag", (ids, movedId) => {
      enqueue(() => commit(next => { applyOrder(next.tabs.find(tab => tab.id === tabId).sections, ids); }))
        .then(() => {
          const row = [...$("#sections").children].find(section => section.dataset.sectionId === movedId);
          $(".section-drag", row)?.focus({ preventScroll: true });
        }).catch(() => { render(); });
    }, true);
  }
  function openTabOrder() {
    let order;
    openEditor("Reorder tabs", () => enqueue(() => commit(next => applyOrder(next.tabs, order.ids()))));
    order = orderList(state.tabs, state.activeTab, "Tab order");
    $("#editor-fields").append(order.list);
  }
  function openTab(tab) {
    const id = tab?.id || uid();
    let tabOrder;
    openEditor(tab ? "Your tab, your way" : "A new space for inspiration", async (form) => {
      const name = requireName(form);
      await enqueue(() => commit((next) => {
        const item = tab ? next.tabs.find((entry) => entry.id === id) : { id, sections: [] };
        item.name = name;
        if (!tab) next.tabs.push(item);
        applyOrder(next.tabs, tabOrder.ids()); reorder(next.tabs, item, form.get("position")); next.activeTab = item.id;
      }));
      cursor = null; selection.clear(); sectionSelection.clear(); render();
    }, tab ? async () => {
      if (state.tabs.length === 1) throw new Error("Keep at least one tab. You can rename or empty this one.");
      if (!confirm(`Delete “${tab.name}” and everything inside it? Export a backup first if you want to keep a copy.`)) return false;
      await enqueue(() => commit((next) => {
        next.tabs = next.tabs.filter((entry) => entry.id !== tab.id);
        if (next.activeTab === tab.id) next.activeTab = next.tabs[0].id;
      }));
    } : null);
    const name = nameField("Tab name", tab?.name || ""); name.focus(); name.select();
    const position = positionField(tab ? state.tabs.findIndex((entry) => entry.id === id) + 1 : state.tabs.length + 1, state.tabs.length + (tab ? 0 : 1));
    tabOrder = rearrangeField(tab ? state.tabs : [...state.tabs, { id, name: "New tab" }], id, position, "Tab order");
    name.addEventListener("input", () => {
      const row = [...tabOrder.list.children].find(row => row.dataset.orderId === id);
      $(".tab-order-name", row).textContent = name.value || "New tab"; tabOrder.update();
    });
    if (tab) $("#editor-extra").append(button("Duplicate tab", async () => {
      try {
        await enqueue(() => commit((next) => {
          const source = next.tabs.find((entry) => entry.id === tab.id);
          const copy = { ...clone(source), id: uid(), name: `${source.name.slice(0, 140)} (copy)`, sections: source.sections.map(duplicateSection) };
          next.tabs.splice(next.tabs.findIndex((entry) => entry.id === tab.id) + 1, 0, copy);
          next.activeTab = copy.id;
        }));
        cursor = null; selection.clear(); sectionSelection.clear(); editor.close(); render(); notify("Tab duplicated.");
      } catch (error) { showEditorError(error); }
    }, "button"));
  }
  function openSection(section) {
    const tabId = state.activeTab;
    const current = activeTab();
    const id = section?.id || uid();
    let sectionOrder;
    openEditor(section ? "A collection of your own" : "A new collection", async (form) => {
      const name = requireName(form);
      await enqueue(() => commit((next) => {
        const item = section ? findSection(section.id, next) : { id, items: [], collapsed: false };
        if (section) for (const tab of next.tabs) tab.sections = tab.sections.filter((entry) => entry.id !== item.id);
        item.name = name;
        const target = next.tabs.find((tab) => tab.id === form.get("tab")).sections;
        target.push(item); applyOrder(target, sectionOrder.ids());
        reorder(target, item, form.get("position"));
        next.activeTab = form.get("tab");
      }));
    }, section ? () => removeItems([section.id], true) : null);
    const name = nameField("Section name", section?.name || "");
    const tabSelect = field("Tab", "tab", tabId, "text", state.tabs.map((tab) => [tab.id, tab.name]));
    const position = positionField(section ? current.sections.findIndex((entry) => entry.id === id) + 1 : current.sections.length + 1, current.sections.length + (section ? 0 : 1));
    const rearrange = () => {
      if (sectionOrder) { sectionOrder.destroy(); sectionOrder.details.remove(); }
      const entries = [...state.tabs.find(tab => tab.id === tabSelect.value).sections.filter(entry => entry.id !== id)];
      const moving = { id, name: name.value || "New section" };
      entries.splice(Math.max(0, Math.min(entries.length, Number(position.value) - 1)), 0, moving);
      sectionOrder = rearrangeField(entries, id, position, "Section order");
    };
    rearrange();
    tabSelect.addEventListener("change", () => {
      const max = state.tabs.find((tab) => tab.id === tabSelect.value).sections.filter((entry) => entry.id !== section?.id).length + 1;
      $("[name=position]", editor).max = $("[name=position]", editor).value = max;
      rearrange();
    });
    name.addEventListener("input", () => {
      const row = [...sectionOrder.list.children].find(row => row.dataset.orderId === id);
      $(".tab-order-name", row).textContent = name.value || "New section"; sectionOrder.update();
    });
    if (section) $("#editor-extra").append(button("Duplicate section", async () => {
      try {
        await enqueue(() => commit((next) => {
          const list = next.tabs.find((tab) => tab.id === tabId).sections;
          const source = list.find((entry) => entry.id === section.id);
          const copy = duplicateSection(source); copy.name = `${source.name.slice(0, 140)} (copy)`;
          list.splice(list.findIndex((entry) => entry.id === source.id) + 1, 0, copy);
        }));
        editor.close(); notify("Section duplicated.");
      } catch (error) { showEditorError(error); }
    }, "button"));
  }
  function sectionOptions() {
    return state.tabs.flatMap((tab) => tab.sections.map((section) => [section.id, `${tab.name} / ${section.name}`]));
  }
  function openCrop(itemId) {
    const item = allItems().find((entry) => entry.id === itemId);
    const asset = assets.get(item.assetId);
    let crop = clone(item.crop || { x: 0, y: 0, width: 1, height: 1 }), drag;
    openEditor("Crop image", async () => {
      const saved = clone(crop);
      if (!validCrop(saved)) throw new Error("Choose a non-empty crop inside the original image.");
      await enqueue(() => commit((next) => {
        const target = allItems(next).find((entry) => entry.id === itemId);
        if (!target) throw new Error("This image is no longer in the collection.");
        if (saved.x === 0 && saved.y === 0 && saved.width === 1 && saved.height === 1) delete target.crop;
        else target.crop = saved;
      }));
    });
    editor.classList.add("crop-editor");
    const stage = el("div", "crop-stage");
    stage.style.aspectRatio = `${asset.width} / ${asset.height}`;
    stage.style.width = `min(100%, ${50 * asset.width / asset.height}vh)`;
    const original = el("img"); original.src = imageURL(item.assetId); original.alt = `Full original: ${item.title}`; original.draggable = false;
    original.addEventListener("error", () => showEditorError(new Error("Could not load the original image. Cancel and try again.")), { once: true });
    const frame = el("div", "crop-frame");
    frame.tabIndex = 0; frame.setAttribute("role", "group");
    frame.setAttribute("aria-label", "Crop selection. Arrow keys move; Shift and arrow keys resize in one-percent steps.");
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = el("span", "crop-handle"); handle.dataset.corner = corner; handle.setAttribute("aria-hidden", "true"); frame.append(handle);
    }
    stage.append(original, frame); $("#editor-fields").append(stage);
    function paint() {
      Object.assign(frame.style, { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` });
    }
    frame.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const horizontal = ["ArrowLeft", "ArrowRight"].includes(event.key);
      const key = event.shiftKey ? horizontal ? "width" : "height" : horizontal ? "x" : "y";
      const minimum = event.shiftKey ? 1 / (horizontal ? asset.width : asset.height) : 0;
      const maximum = event.shiftKey ? 1 - crop[horizontal ? "x" : "y"] : 1 - crop[horizontal ? "width" : "height"];
      const delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -.01 : .01;
      crop[key] = Math.max(minimum, Math.min(maximum, Number((crop[key] + delta).toFixed(8))));
      $("#editor-error").hidden = true; paint();
    });
    const point = (event) => {
      const rect = stage.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    };
    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      const start = point(event), corner = event.target.closest("[data-corner]")?.dataset.corner;
      drag = { id: event.pointerId, start, crop: clone(crop), mode: corner || (event.target.closest(".crop-frame") ? "move" : "draw") };
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const current = point(event), before = drag.crop;
      if (drag.mode === "move") {
        crop = { ...before, x: Math.max(0, Math.min(1 - before.width, before.x + current.x - drag.start.x)), y: Math.max(0, Math.min(1 - before.height, before.y + current.y - drag.start.y)) };
      } else {
        const anchor = drag.mode === "draw" ? drag.start : {
          x: before.x + (drag.mode.includes("w") ? before.width : 0),
          y: before.y + (drag.mode.includes("n") ? before.height : 0)
        };
        const width = Math.max(1 / asset.width, Math.abs(current.x - anchor.x));
        const height = Math.max(1 / asset.height, Math.abs(current.y - anchor.y));
        crop = { x: Math.min(1 - width, Math.min(anchor.x, current.x)), y: Math.min(1 - height, Math.min(anchor.y, current.y)), width, height };
      }
      $("#editor-error").hidden = true; paint();
    });
    const end = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (event.type === "pointercancel") { crop = drag.crop; paint(); }
      drag = null;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    };
    stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end); stage.addEventListener("lostpointercapture", end);
    const reset = button("Reset crop", () => { crop = { x: 0, y: 0, width: 1, height: 1 }; $("#editor-error").hidden = true; paint(); }, "button");
    reset.id = "crop-reset"; $(".dialog-footer").prepend(reset);
    paint();
  }
  function openImage(itemId) {
    const source = sections().find((section) => section.items.some((item) => item.id === itemId));
    const item = source.items.find((entry) => entry.id === itemId);
    openEditor("The details", async (form) => {
      const title = form.get("title").trim();
      if (!title) throw new Error("Please enter a filename.");
      const enteredSource = form.get("sourceUrl").trim();
      const sourceUrl = sourcePageURL(enteredSource);
      if (enteredSource && !sourceUrl) throw new Error("Use a full HTTP or HTTPS source page URL without a username or password.");
      await enqueue(() => commit((next) => {
        const updated = { ...allItems(next).find((entry) => entry.id === itemId), title, notes: form.get("notes"), sourceUrl };
        transfer(next, [itemId], { sectionId: form.get("section"), index: Number(form.get("position")) - 1 }, false, [updated]);
      }));
    }, () => removeItems([itemId]));
    const sourceUrl = field("Source page URL", "sourceUrl", item.sourceUrl || "", "url"); sourceUrl.maxLength = 8192;
    const sourceHeading = sourceUrl.previousElementSibling; sourceHeading.classList.add("source-field-label");
    const updateSourceLink = () => {
      sourceHeading.querySelector(".source-go")?.remove();
      const link = sourceLink({ ...item, sourceUrl: sourceUrl.value }, "source-button source-go");
      if (link) {
        link.title = "Go to site"; link.setAttribute("aria-label", `Go to site for ${item.title}`);
        link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3 11 13M10 5H4v15h15v-6"/></svg>';
        sourceHeading.append(link);
      }
    };
    sourceUrl.addEventListener("input", updateSourceLink); updateSourceLink();
    const section = field("Section", "section", source.id, "text", sectionOptions());
    positionField(source.items.findIndex((entry) => entry.id === itemId) + 1, source.items.length);
    section.addEventListener("change", () => {
      const count = findSection(section.value).items.filter((entry) => entry.id !== itemId).length + 1;
      $("[name=position]", editor).max = $("[name=position]", editor).value = count;
    });
    const notes = field("Notes", "notes", item.notes, "textarea"); notes.maxLength = 10000;
    const title = field("Filename", "title", item.title); title.required = true; title.maxLength = 300;
    const asset = assets.get(item.assetId);
    hint(`Original: ${asset.width} × ${asset.height} pixels · ${asset.blob ? sizeText(asset.blob.size) : "not cached yet"} · ${asset.blob?.type || asset.remote.mime}.`);
  }
  function transfer(data, ids, target, copy, replacements) {
    const wanted = new Set(ids);
    const items = replacements || allItems(data).filter((item) => wanted.has(item.id));
    let destination = findSection(target.sectionId, data);
    if (!destination) throw new Error("Choose an existing destination section.");
    let beforeId = target.beforeId;
    if (!copy && beforeId && wanted.has(beforeId)) {
      const index = destination.items.findIndex((item) => item.id === beforeId);
      beforeId = destination.items.slice(index).find((item) => !wanted.has(item.id))?.id || null;
    }
    if (!copy) for (const section of sections(data)) section.items = section.items.filter((item) => !wanted.has(item.id));
    destination = findSection(target.sectionId, data);
    const before = beforeId ? destination.items.findIndex((item) => item.id === beforeId) : -1;
    const index = target.index !== undefined ? Math.min(destination.items.length, target.index) : before < 0 ? destination.items.length : before;
    destination.items.splice(Math.max(0, index), 0, ...items.map((item) => copy ? { ...clone(item), id: uid() } : item));
    destination.collapsed = false;
  }
  function openTransfer(copy) {
    if (sectionSelection.size) { openSectionTransfer(copy); return; }
    if (!selection.size) return;
    const ids = [...selection];
    const options = sectionOptions();
    if (!options.length) { notify("Create a destination section first."); return; }
    openEditor(`${copy ? "Copy" : "Move"} ${ids.length} ${ids.length === 1 ? "image" : "images"}`, async (form) => {
      await enqueue(() => commit((next) => transfer(next, ids, { sectionId: form.get("section"), index: Number(form.get("position")) - 1 }, copy)));
      selection.clear(); renderSelection();
    });
    const select = field("Destination (tab / section)", "section", cursor?.sectionId || activeTab().sections[0]?.id || options[0][0], "text", options);
    const maximum = () => findSection(select.value).items.filter((item) => copy || !ids.includes(item.id)).length + 1;
    positionField(maximum(), maximum());
    select.addEventListener("change", () => { $("[name=position]", editor).max = $("[name=position]", editor).value = maximum(); });
    hint("The selected images keep their relative order. Copies share the original bytes without doubling local storage.");
  }
  function openSectionTransfer(copy) {
    const ids = new Set(sectionSelection), tabId = state.activeTab;
    const targetTab = state.tabs.find((tab) => tab.id !== tabId) || activeTab();
    openEditor(`${copy ? "Copy" : "Move"} ${ids.size} ${ids.size === 1 ? "section" : "sections"}`, async (form) => {
      await enqueue(() => commit((next) => {
        const source = next.tabs.find((tab) => tab.id === tabId);
        const selected = source.sections.filter((section) => ids.has(section.id));
        if (selected.length !== ids.size) throw new Error("The selected sections changed. Close this dialog and select them again.");
        const target = next.tabs.find((tab) => tab.id === form.get("tab"));
        if (!target) throw new Error("The destination tab no longer exists. Choose another tab.");
        if (!copy) source.sections = source.sections.filter((section) => !ids.has(section.id));
        const index = Math.max(0, Math.min(target.sections.length, Number(form.get("position")) - 1));
        target.sections.splice(index, 0, ...selected.map((section) => copy ? duplicateSection(section) : section));
      }));
      sectionSelection.clear(); renderSelection();
    });
    const select = field("Destination tab", "tab", targetTab.id, "text", state.tabs.map((tab) => [tab.id, tab.name]));
    const maximum = () => state.tabs.find((tab) => tab.id === select.value).sections.filter((section) => copy || !ids.has(section.id)).length + 1;
    positionField(maximum(), maximum());
    select.addEventListener("change", () => { $("[name=position]", editor).max = $("[name=position]", editor).value = maximum(); });
    hint("Sections keep their relative order, images, crops, and collapsed state. Copies share original files without duplicating storage.");
  }
  async function removeItems(ids, wholeSections = false) {
    if (!ids.length) { notify("Select something to delete first."); return false; }
    if (deleting) { notify("Finish the current deletion first."); return false; }
    deleting = true;
    try {
      const skipped = deleteSkipsRemaining > 0;
      let allowance = deleteSkipsRemaining;
      if (!skipped) {
        $("#delete-warning-form").reset(); $("#delete-skip").setCustomValidity("");
        const images = wholeSections ? sections().filter((section) => ids.includes(section.id)).reduce((count, section) => count + section.items.length, 0) : ids.length;
        $("#delete-warning-message").textContent = wholeSections
          ? `Delete ${ids.length} ${ids.length === 1 ? "section" : "sections"} and their ${images} ${images === 1 ? "image" : "images"}? This cannot be undone.`
          : `Delete ${ids.length} ${ids.length === 1 ? "image" : "images"}? This cannot be undone.`;
        deleteWarning.returnValue = "";
        allowance = await new Promise((resolve) => {
          deleteWarning.addEventListener("close", () => resolve(deleteWarning.returnValue === "delete" ? Number($("#delete-skip").value) : null), { once: true });
          deleteWarning.showModal();
        });
        if (allowance === null) return false;
      }
      const wanted = new Set(ids);
      await enqueue(() => commit((next) => {
        if (wholeSections) for (const tab of next.tabs) tab.sections = tab.sections.filter((section) => !wanted.has(section.id));
        else for (const section of sections(next)) section.items = section.items.filter((item) => !wanted.has(item.id));
      }));
      deleteSkipsRemaining = skipped ? allowance - 1 : allowance;
      selection.clear(); sectionSelection.clear(); renderSelection();
      return true;
    } finally { deleting = false; }
  }
  $("#delete-warning-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#delete-skip"), count = Number(input.value);
    if (!Number.isSafeInteger(count) || count < 0) {
      input.setCustomValidity("Enter a whole number of delete clicks, zero or greater."); input.reportValidity(); return;
    }
    deleteWarning.close("delete");
  });
  $("#delete-skip").addEventListener("input", (event) => event.target.setCustomValidity(""));
  $("#delete-warning-cancel").addEventListener("click", () => deleteWarning.close("cancel"));
  function showEditorError(error) {
    console.error(error); syncText($("#editor-error"), errorMessage(error)); $("#editor-error").hidden = false;
  }

  async function readImage(file) {
    if (!supportedImage.test(file.type)) throw new Error(`“${file.name || "Image"}” is not a supported raster image. Use PNG, JPEG, GIF, WebP, AVIF, or BMP.`);
    const record = (width, height) => {
      if (!width || !height) throw new Error("The image has no readable dimensions.");
      return { blob: file, name: (file.name || `pasted-${Date.now()}.${file.type.split("/")[1]}`).slice(0, 500), width, height };
    };
    try {
      if (typeof createImageBitmap === "function") {
        let bitmap;
        try { bitmap = await createImageBitmap(file); }
        catch (error) {
          if (!(error instanceof DOMException) || !["InvalidStateError", "NotSupportedError"].includes(error.name)) throw error;
          console.info("Using the browser image decoder for this format.", error.name);
        }
        // Bitmap decoding does not wait for a visible document or a paint frame.
        if (bitmap) {
          try { return record(bitmap.width, bitmap.height); }
          finally { bitmap.close(); }
        }
      }
      const url = URL.createObjectURL(file);
      try {
        const image = new Image(); image.src = url; await image.decode();
        return record(image.naturalWidth, image.naturalHeight);
      } finally { URL.revokeObjectURL(url); }
    } catch (error) {
      throw new Error(`Could not read “${file.name || "pasted image"}”. Choose an image supported by this browser.`, { cause: error });
    }
  }
  function addFiles(files, target = cursor && { ...cursor }, sourceUrls = [], sourceImageUrls = []) {
    if (!editable) { notify("Turn Edit on to add images."); return; }
    const list = [...files];
    if (!list.length) { notify("No image files found. Copy an image or use Add images."); return; }
    enqueue(async () => {
      const additions = new Map(), items = [];
      for (const [index, file] of list.entries()) {
        const asset = await readImage(file), assetId = uid();
        additions.set(assetId, asset);
        items.push({ id: uid(), assetId, title: asset.name.slice(0, 300), notes: "", sourceUrl: sourceUrls[index] || "", sourceImageUrl: sourceImageUrls[index] || "" });
      }
      await commit((next) => insertItems(next, items, target), additions);
      const linked = items.filter((item) => item.sourceUrl).length;
      notify(`${items.length} ${items.length === 1 ? "image" : "images"} added · original bytes preserved.${linked ? ` ${linked} source ${linked === 1 ? "link" : "links"} saved.` : ""}`);
    }).catch(() => {});
  }
  function textTarget(target) {
    return target instanceof Element && Boolean(target.closest("input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable=true]"));
  }
  document.addEventListener("paste", (event) => {
    if (!state || textTarget(event.target) || editor.open || viewer.open || deleteWarning.open) return;
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) {
      event.preventDefault();
      const html = event.clipboardData.getData("text/html"), sourceUrl = clipboardSourcePage(html);
      addFiles(files, cursor && { ...cursor }, files.map(() => sourceUrl), files.length === 1 ? [clipboardSourceImage(html)] : []); return;
    }
    if (internalClipboard.length && editable && event.clipboardData?.getData("text/plain") === "moodboard image selection") {
      event.preventDefault(); pasteInternal();
    }
  });
  async function pasteFromButton() {
    if (!editable) return;
    const target = cursor && { ...cursor };
    if (!navigator.clipboard?.read) {
      notify("Use Ctrl+V / ⌘V to paste, or Add images. Your browser does not support the Paste button here.");
      return;
    }
    try {
      const entries = await navigator.clipboard.read();
      const images = [], pageSources = new Set(), imageSources = new Set();
      for (const entry of entries) {
        const html = entry.types.includes("text/html") ? await (await entry.getType("text/html")).text() : "";
        const sourceUrl = clipboardSourcePage(html);
        const sourceImageUrl = clipboardSourceImage(html);
        if (sourceUrl) pageSources.add(sourceUrl);
        if (sourceImageUrl) imageSources.add(sourceImageUrl);
        const type = entry.types.find((type) => supportedImage.test(type));
        if (type) images.push({ file: await entry.getType(type), sourceUrl, sourceImageUrl });
      }
      const commonSource = pageSources.size === 1 ? [...pageSources][0] : "";
      const commonImageSource = images.length === 1 && imageSources.size === 1 ? [...imageSources][0] : "";
      if (images.length) addFiles(images.map((image) => image.file), target, images.map((image) => image.sourceUrl || commonSource), images.map((image) => image.sourceImageUrl || commonImageSource));
      else if (internalClipboard.length) pasteInternal();
      else notify("No image in the clipboard. Copy an image, then paste again, or use Add images.");
    } catch (error) {
      console.error(error);
      notify("Clipboard access was blocked. Use Ctrl+V / ⌘V, or add images from your device.");
    }
  }
  function pasteInternal() {
    const copies = clone(internalClipboard);
    const target = cursor && { ...cursor };
    enqueue(() => commit((next) => {
      if (copies.some((item) => !assets.has(item.assetId))) throw new Error("Some copied images were deleted. Select and copy the images again.");
      insertItems(next, copies.map((item) => ({ ...item, id: uid() })), target);
    })).catch(() => {});
  }
  document.addEventListener("copy", (event) => {
    if (!state || !editable || !selection.size || textTarget(event.target) || editor.open || viewer.open || deleteWarning.open) return;
    internalClipboard = clone(tabItems().filter((item) => selection.has(item.id)));
    event.preventDefault(); event.clipboardData.setData("text/plain", "moodboard image selection");
    notify(`${internalClipboard.length} images copied inside moodboard. Choose a location or tab and paste.`);
  });

  function openViewer(itemId) {
    viewItems = tabItems().map((item) => item.id);
    viewIndex = Math.max(0, viewItems.indexOf(itemId));
    $("#viewer-stage").classList.remove("actual");
    updateViewerZoom(false);
    showViewer();
    viewer.showModal();
  }
  function showViewer() {
    const item = allItems().find((item) => item.id === viewItems[viewIndex]);
    if (!item) return;
    const asset = assets.get(item.assetId), url = imageURL(item.assetId);
    $("#viewer-title").textContent = item.title;
    $("#viewer-details").textContent = `${asset.width} × ${asset.height} · ${asset.blob ? sizeText(asset.blob.size) : "not cached yet"} · original`;
    const image = $("#viewer-image"); image.src = url; image.alt = item.title;
    image.width = asset.width; image.height = asset.height;
    const sourceImageUrl = sourcePageURL(item.sourceImageUrl);
    $("#viewer-original").href = sourceImageUrl || url;
    $("#viewer-original").title = sourceImageUrl ? "Open the source image on its website" : "Open the saved original (source image URL unavailable)";
    const sourceUrl = sourcePageURL(item.sourceUrl);
    $("#viewer-source").hidden = !sourceUrl;
    if (sourceUrl) $("#viewer-source").href = sourceUrl;
    else $("#viewer-source").removeAttribute("href");
    $("#viewer-download").href = url; $("#viewer-download").download = asset.name;
    $("#viewer-position").textContent = `${viewIndex + 1} / ${viewItems.length}`;
    $("#viewer-prev").disabled = viewIndex === 0;
    $("#viewer-next").disabled = viewIndex === viewItems.length - 1;
    $("#viewer-stage").scrollTo(0, 0);
    const locations = $("#viewer-locations-list"), currentSection = sections().find(section => section.items.some(entry => entry.id === item.id));
    locations.replaceChildren(); $("#viewer-locations").hidden = true;
    $("#viewer-locations-toggle").setAttribute("aria-expanded", "false");
    for (const tab of state.tabs) for (const section of tab.sections) {
      if (section.id === currentSection?.id || !section.items.some(entry => entry.assetId === item.assetId ||
        asset.remote?.sha && assets.get(entry.assetId)?.remote?.sha === asset.remote.sha)) continue;
      const link = button(`${tab.name} > ${section.name}`, () => {
        viewer.close();
        enqueue(() => commit(next => {
          next.activeTab = tab.id; findSection(section.id, next).collapsed = false;
        })).then(() => {
          const target = [...$("#sections").children].find(node => node.dataset.sectionId === section.id);
          target?.scrollIntoView({ block: "start" });
        }).catch(() => {});
      }, "viewer-location");
      locations.append(link);
    }
    $("#viewer-locations-toggle").hidden = !locations.children.length;
    $("#viewer-locations-toggle").title = `Other sections (${locations.children.length})`;
  }
  function updateViewerZoom(actual) {
    const label = actual ? "Fit image" : "Actual size", control = $("#viewer-zoom");
    control.setAttribute("aria-pressed", String(actual)); control.setAttribute("aria-label", label); control.title = label;
    setIcon(control, actual ? '<path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5"/>'
      : '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>');
  }
  function stepViewer(step) {
    viewIndex = Math.max(0, Math.min(viewItems.length - 1, viewIndex + step)); showViewer();
  }
  let swipe;
  $("#viewer-stage").addEventListener("pointerdown", (event) => {
    if (!$("#viewer-stage").classList.contains("actual")) swipe = { x: event.clientX, y: event.clientY };
  });
  $("#viewer-stage").addEventListener("pointerup", (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1);
    swipe = null;
  });
  $("#viewer-stage").addEventListener("pointercancel", () => { swipe = null; });
  $("#viewer-prev").addEventListener("click", () => stepViewer(-1));
  $("#viewer-next").addEventListener("click", () => stepViewer(1));
  $("#viewer-close").addEventListener("click", () => viewer.close());
  $("#viewer-locations-toggle").addEventListener("click", () => {
    const panel = $("#viewer-locations"), toggle = $("#viewer-locations-toggle");
    panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  setIcon($("#viewer-source"), globeIcon);
  $("#viewer-download").addEventListener("click", async event => {
    event.preventDefault();
    const item = allItems().find(item => item.id === viewItems[viewIndex]);
    if (!item) { report(new Error("This image is no longer in the board.")); return; }
    const asset = assets.get(item.assetId);
    try { download((await ensureOriginal(item.assetId, asset)).blob, asset.name); }
    catch (error) { report(error); }
  });
  $("#viewer-zoom").addEventListener("click", () => {
    const actual = $("#viewer-stage").classList.toggle("actual");
    updateViewerZoom(actual);
  });

  function dropLocation(x, y) {
    const target = document.elementFromPoint(x, y);
    const slotNode = target?.closest("[data-paste-section]");
    if (slotNode) return { sectionId: slotNode.dataset.pasteSection, beforeId: slotNode.dataset.before || null, node: slotNode };
    const card = target?.closest(".image-card");
    if (card) {
      const bounds = card.getBoundingClientRect();
      const section = findSection(card.dataset.sectionId);
      const index = section.items.findIndex((item) => item.id === card.dataset.itemId);
      const before = y < bounds.top + bounds.height / 2 ? index : index + 1;
      const item = section.items[before];
      const node = item ? $(`[data-paste-section="${section.id}"][data-before="${item.id}"]`) : $(`.section-end[data-paste-section="${section.id}"]`);
      return { sectionId: section.id, beforeId: item?.id || null, node };
    }
    const sectionNode = target?.closest(".section");
    if (sectionNode) return { sectionId: sectionNode.dataset.sectionId, beforeId: null, node: $(".section-end", sectionNode) || sectionNode };
    return null;
  }
  function startDrag() {
    if (!gesture || !editable) return;
    revealHeader();
    gesture.dragging = true;
    sectionSelection.clear();
    if (!selection.has(gesture.itemId)) { selection.clear(); selection.add(gesture.itemId); }
    gesture.ids = tabItems().filter((item) => selection.has(item.id)).map((item) => item.id);
    renderSelection();
    document.body.classList.add("dragging");
    for (const card of $$(".image-card")) if (selection.has(card.dataset.itemId)) card.classList.add("drag-source");
    $("#drag-preview").textContent = `Moving ${gesture.ids.length} ${gesture.ids.length === 1 ? "image" : "images"}`;
    $("#drag-preview").hidden = false;
    suppressClickUntil = performance.now() + 1000;
    gesture.capture?.setPointerCapture?.(gesture.pointerId);
    moveDrag();
    if (navigator.vibrate) navigator.vibrate(25);
  }
  function moveDrag() {
    if (!gesture?.dragging) return;
    $("#drag-preview").style.left = `${Math.min(innerWidth - 155, gesture.x + 15)}px`;
    $("#drag-preview").style.top = `${gesture.y + 15}px`;
    selectedTarget?.node?.classList.remove("drop-target");
    selectedTarget = dropLocation(gesture.x, gesture.y);
    selectedTarget?.node?.classList.add("drop-target");
    const hoveredTab = document.elementFromPoint(gesture.x, gesture.y)?.closest("[data-tab-id]");
    if (hoveredTab && hoveredTab.dataset.tabId !== state.activeTab) {
      if (gesture.hoverTab !== hoveredTab.dataset.tabId) {
        gesture.hoverTab = hoveredTab.dataset.tabId; gesture.hoverTime = performance.now();
      } else if (performance.now() - gesture.hoverTime > 650 && !gesture.switching) {
        gesture.switching = true;
        const targetId = gesture.hoverTab;
        enqueue(async () => {
          await commit((next) => { next.activeTab = targetId; });
          if (gesture) { gesture.switching = false; gesture.hoverTab = null; }
        }).catch(() => {});
      }
    } else gesture.hoverTab = null;
    const edge = 70, speed = hoveredTab ? 0 : gesture.y < edge ? -16 : gesture.y > innerHeight - edge ? 16 : 0;
    if (speed) window.scrollBy(0, speed);
    dragFrame = requestAnimationFrame(moveDrag);
  }
  function startSelectionBox() {
    if (!gesture || gesture.boxActive) return;
    revealHeader();
    clearTimeout(gesture.timer);
    sectionSelection.clear();
    gesture.box = gesture.boxActive = true;
    gesture.capture = $("#sections");
    gesture.capture.setPointerCapture(gesture.pointerId);
    document.body.classList.add("selecting");
    moveSelectionBox();
  }
  function moveSelectionBox() {
    if (!gesture?.boxActive) return;
    const speed = gesture.y < 50 ? -12 : gesture.y > innerHeight - 50 ? 12 : 0;
    if (speed) window.scrollBy(0, speed);
    const endX = gesture.x + scrollX, endY = gesture.y + scrollY;
    const left = Math.min(gesture.anchorX, endX), top = Math.min(gesture.anchorY, endY);
    const width = Math.abs(endX - gesture.anchorX), height = Math.abs(endY - gesture.anchorY);
    const box = $("#rubber-band"); box.hidden = false;
    Object.assign(box.style, { left: `${left - scrollX}px`, top: `${top - scrollY}px`, width: `${width}px`, height: `${height}px` });
    selection = new Set(gesture.initial);
    for (const card of $$(".image-card")) {
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const x = rect.left + scrollX, y = rect.top + scrollY;
      if (x + rect.width >= left && x <= left + width && y + rect.height >= top && y <= top + height) selection.add(card.dataset.itemId);
    }
    renderSelection();
    dragFrame = requestAnimationFrame(moveSelectionBox);
  }
  function endGesture(cancelled = false) {
    if (!gesture) return;
    clearTimeout(gesture.timer); cancelAnimationFrame(dragFrame);
    const old = gesture, target = selectedTarget;
    gesture = null; selectedTarget = null;
    if (old.capture?.hasPointerCapture(old.pointerId)) old.capture.releasePointerCapture(old.pointerId);
    document.body.classList.remove("dragging", "selecting");
    for (const node of $$(".drag-source,.drop-target")) node.classList.remove("drag-source", "drop-target");
    $("#drag-preview").hidden = true; $("#rubber-band").hidden = true;
    if (old.boxActive) {
      suppressClickUntil = performance.now() + 500;
      if (cancelled) { selection = old.previous; sectionSelection = old.previousSections; renderSelection(); }
    }
    if (old.dragging) {
      suppressClickUntil = performance.now() + 500;
      if (!cancelled && target) {
        enqueue(() => commit((next) => transfer(next, old.ids, target, false))).catch(() => {});
      } else if (!cancelled) notify("Drop on an image, a paste gap, or inside a section. Nothing was moved.");
    }
  }
  document.addEventListener("pointerdown", () => {
    if (!gesture?.dragging) suppressClickUntil = 0;
  }, true);
  document.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil && event.target.closest("#sections")) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!editable || event.button !== 0 || !event.target.closest("main") || event.target.closest("#board-header,.section-header") || editor.open || viewer.open || deleteWarning.open || pending) return;
    const card = event.target.closest(".image-card");
    const fromCheckbox = Boolean(event.target.closest(".image-selection"));
    const origin = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      anchorX: event.clientX + scrollX, anchorY: event.clientY + scrollY, previous: new Set(selection), previousSections: new Set(sectionSelection),
      initial: event.ctrlKey || event.metaKey || event.shiftKey ? new Set(selection) : new Set() };
    if (card && (event.target.closest(".image-hit") || event.target.closest(".drag-handle") || fromCheckbox)) {
      if (fromCheckbox && event.pointerType !== "mouse") return;
      const handle = event.target.closest(".drag-handle");
      gesture = { ...origin, itemId: card.dataset.itemId, capture: handle || $(".image-hit", card), handle: Boolean(handle), dragging: false };
      if (!fromCheckbox) gesture.timer = setTimeout(startDrag, handle ? 120 : 420);
      return;
    }
    const pasteGap = event.target.closest(".insert-slot,.section-end");
    if (event.pointerType !== "mouse" || (!pasteGap && event.target.closest("button,input,a,.image-card"))) return;
    event.preventDefault();
    gesture = { ...origin, box: true };
  });
  document.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (gesture.box) {
      if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > 6) startSelectionBox();
      if (gesture.boxActive) event.preventDefault();
      return;
    }
    if (!gesture.dragging && Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > (gesture.pointerType === "mouse" ? 6 : 10)) {
      if (gesture.handle) startDrag();
      else if (gesture.pointerType === "mouse") { startSelectionBox(); event.preventDefault(); }
      else { clearTimeout(gesture.timer); gesture = null; }
    } else if (gesture.dragging) event.preventDefault();
  }, { passive: false });
  document.addEventListener("pointerup", () => endGesture());
  document.addEventListener("pointercancel", () => endGesture(true));
  document.addEventListener("contextmenu", (event) => { if (editable && event.target.closest(".image-hit,.drag-handle")) event.preventDefault(); });
  document.addEventListener("dragstart", (event) => { if (event.target.closest(".image-hit")) event.preventDefault(); });
  document.addEventListener("dragover", (event) => {
    if (editable && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  });
  document.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    if (editor.open || viewer.open || deleteWarning.open) return;
    const location = dropLocation(event.clientX, event.clientY);
    const html = event.dataTransfer.getData("text/html"), files = [...event.dataTransfer.files];
    addFiles(files, location || cursor, files.map(() => clipboardSourcePage(html)), files.length === 1 ? [clipboardSourceImage(html)] : []);
  });

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read an original image for export."));
      reader.readAsDataURL(blob);
    });
  }
  function updateOfflineStatus() {
    const cached = [...assets.values()].filter(asset => asset.blob instanceof Blob).length;
    if (cached === assets.size) { originalCacheError = ""; cacheSpaceRequired = 0; }
    if (!shellReady && !cacheSpaceRequired && !originalCacheError) return;
    $("#connection-status").textContent = cacheSpaceRequired ? "Original caching paused · free device storage · online browsing available"
      : originalCacheError ? "Originals not fully cached · reconnect and Force re-sync"
      : memoryOnly ? "Offline shell only · export to keep originals"
        : cached < assets.size ? `Caching originals ${cached}/${assets.size} · stay online` : "Offline ready";
  }
  async function ensureOriginal(id, asset) {
    if (asset.blob instanceof Blob) return asset;
    const key = `${id}:${asset.remote.sha}`;
    if (!originalDownloads.has(key)) {
      originalDownloads.set(key, (async () => {
        const blob = await github.readOriginal(asset.remote);
        // Bound decoded-pixel memory on phones while network downloads stay concurrent.
        const decoding = originalDecoder.then(() => readImage(blob));
        originalDecoder = decoding.catch(() => {});
        const decoded = await decoding;
        if (decoded.width !== asset.width || decoded.height !== asset.height) throw new Error(`The dimensions of “${asset.name}” do not match its shared original.`);
        return { ...asset, blob };
      })().finally(() => originalDownloads.delete(key)));
    }
    return originalDownloads.get(key);
  }
  async function cacheOriginals() {
    if (cachingOriginals || memoryOnly || originalReadbackFailed || !navigator.onLine) { updateOfflineStatus(); return; }
    const originals = [...assets].filter(([, asset]) => !(asset.blob instanceof Blob));
    if (!originals.length) { updateOfflineStatus(); return; }
    cachingOriginals = true; originalCacheError = ""; updateOfflineStatus();
    let index = 0, failure = null;
    const completed = [];
    const flush = async () => {
      const batch = completed.splice(0);
      if (!batch.length || failure) return;
      await enqueue(async () => {
        const nextAssets = new Map(assets);
        let bytes = 0;
        for (const [id, asset] of batch) {
          if (nextAssets.get(id)?.remote?.sha === asset.remote.sha && !(nextAssets.get(id).blob instanceof Blob)) {
            nextAssets.set(id, asset); bytes += asset.blob.size;
          }
        }
        const space = await navigator.storage?.estimate?.();
        if (space && space.quota - space.usage < bytes + cacheStorageReserve) {
          cacheSpaceRequired = bytes + cacheStorageReserve;
          throw new DOMException("Not enough browser storage remains to cache more originals safely.", "QuotaExceededError");
        }
        await persist(state, nextAssets, state.revision, cloudEnabled ? cloudInfo : undefined);
        assets = nextAssets; updateOfflineStatus();
      }, false);
    };
    try {
      if (cacheSpaceRequired) {
        const space = await navigator.storage?.estimate?.();
        if (space && space.quota - space.usage < cacheSpaceRequired) return;
        cacheSpaceRequired = 0;
      }
      await Promise.all(Array.from({ length: Math.min(4, originals.length) }, async () => {
        while (index < originals.length && !failure && !originalReadbackFailed) {
          const [id, asset] = originals[index++];
          try {
            completed.push([id, await ensureOriginal(id, asset)]);
            if (completed.length >= 16 || completed.reduce((bytes, [, original]) => bytes + original.blob.size, 0) >= 8 * 1024 * 1024) await flush();
          } catch (error) { failure ||= error; }
        }
      }));
      await flush();
      if (failure) throw failure;
    } catch (error) {
      originalCacheError = errorMessage(error);
      if (error.name === "QuotaExceededError") {
        cacheSpaceRequired ||= cacheStorageReserve;
        warning("Original caching paused because browser storage is low. Online browsing and edits to already saved content remain available. Free device storage, then use Force re-sync. This board is not fully available offline.");
        console.warn("Original caching paused:", error);
      } else report(new Error(`Original image caching failed: ${originalCacheError} Browsing stays available online; do not go offline until Offline ready appears.`));
    } finally {
      cachingOriginals = false; updateOfflineStatus();
      if (!originalCacheError && !cacheSpaceRequired && !originalReadbackFailed && [...assets.values()].some(asset => !(asset.blob instanceof Blob))) cacheOriginals();
    }
  }
  function originalStaging(originals) {
    const id = uid();
    let flushed = 0, saved = false, pendingBytes = 0;
    return {
      async flush(force = false, bytes = 0) {
        pendingBytes += bytes;
        if (memoryOnly || originals.size === flushed || !force && originals.size - flushed < 16 && pendingBytes < 8 * 1024 * 1024) return;
        await persist({ id, revision: 0 }, originals, saved ? 0 : -1, undefined, false);
        saved = true; flushed = originals.size; pendingBytes = 0;
        if (originalReadbackFailed) throw new Error("Could not reopen staged originals. Reload before importing again; the active board has not been replaced.");
      },
      async cleanup() {
        if (!saved && !db) return;
        try {
          await storageTransaction("boards", "readwrite", tx => {
            const store = tx.objectStore("boards");
            store.delete(id);
            for (const key of originals.keys()) store.delete(originalStorageKey(id, key));
          });
        } catch (error) {
          report(new Error(`Could not remove temporary import data: ${errorMessage(error)} Your existing board has not been replaced by temporary data.`));
        }
      }
    };
  }
  async function unpackBoard(data, shared = false, portable = false) {
    if (!data || data.format !== "moodboard" || data.version !== 1 || !Array.isArray(data.assets)) throw new Error("Choose a valid moodboard JSON backup.");
    const result = new Map(), staging = shared ? null : originalStaging(result);
    try {
      for (const entry of data.assets) {
        const bytes = await unpackAsset(entry, result, shared);
        if (portable) await stagePortable(staging, false, bytes);
        else await staging?.flush(false, bytes);
      }
      validate(data.state, result);
      if (portable) await stagePortable(staging, true);
      else await staging?.flush(true);
      return { state: data.state, assets: result, cleanup: staging?.cleanup };
    } catch (error) { await staging?.cleanup(); throw error; }
  }
  function recoverPortable(error) {
    console.error("Portable browser storage failed; using embedded originals:", error);
    memoryOnly = true; isolatedPortable = true;
    warning("Browser autosave failed. Using the photos embedded in this file, without browser storage. Newer browser-only edits may not be included; stored boards were not replaced. Save a NEW portable copy before closing to keep changes.");
  }
  async function stagePortable(staging, force, bytes = 0) {
    if (memoryOnly) return;
    try { await staging.flush(force, bytes); }
    catch (error) { recoverPortable(error); }
  }
  async function unpackAsset(entry, result, shared = false) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || result.has(entry[0])) throw new Error("The backup contains invalid or duplicate image records.");
    const [key, asset] = entry;
    if (shared && asset && MoodboardFormat.validRemote(asset.remote)) { result.set(key, asset); return; }
    if (!asset || typeof asset.data !== "string" || !/^data:image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\r\n]+$/i.test(asset.data)) throw new Error("The backup contains an unsupported image.");
    const comma = asset.data.indexOf(","), mime = asset.data.slice(5, asset.data.indexOf(";"));
    const binary = atob(asset.data.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: mime });
    const decoded = await readImage(blob);
    result.set(key, { ...decoded, name: asset.name });
    return blob.size;
  }
  async function readBackup(file) {
    const prefix = await file.slice(0, 100).text();
    if (!prefix.startsWith('{"format":"moodboard-lines",')) return unpackBoard(JSON.parse(await file.text()));
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader(), originals = new Map();
    const staging = originalStaging(originals);
    let header = null, parts = [];
    const line = async value => {
      if (!value.trim()) return;
      const record = JSON.parse(value);
      if (!header) {
        if (record.format !== "moodboard-lines" || record.version !== 1 || !Number.isSafeInteger(record.assetCount) || record.assetCount < 0) throw new Error("Choose a valid moodboard JSON Lines backup.");
        header = record;
      } else { const bytes = await unpackAsset(record, originals); await staging.flush(false, bytes); }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        let start = 0, end;
        while ((end = value.indexOf("\n", start)) !== -1) {
          parts.push(value.slice(start, end)); await line(parts.join("")); parts = []; start = end + 1;
        }
        if (start < value.length) parts.push(value.slice(start));
      }
      if (parts.length) await line(parts.join(""));
      if (!header || header.assetCount !== originals.size) throw new Error("The backup is incomplete. Your current board has not been replaced.");
      validate(header.state, originals);
      await staging.flush(true);
      return { state: header.state, assets: originals, cleanup: staging.cleanup };
    } catch (error) {
      await staging.cleanup(); throw error;
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  function exportSnapshot(selected) {
    const snapshot = { state: clone(state), assets: new Map(assets) };
    if (selected) {
      for (const [tabId, sectionIds] of selected) {
        const tab = snapshot.state.tabs.find(tab => tab.id === tabId);
        if (!tab || [...sectionIds].some(id => !tab.sections.some(section => section.id === id))) throw new Error("Selected content changed. Reopen Export and select it again.");
      }
      snapshot.state.tabs = snapshot.state.tabs.filter(tab => selected.has(tab.id));
      for (const tab of snapshot.state.tabs) tab.sections = tab.sections.filter(section => selected.get(tab.id).has(section.id));
      if (!snapshot.state.tabs.length) throw new Error("Select at least one tab or section to export.");
      snapshot.state.id = uid(); snapshot.state.revision = 0;
      if (!snapshot.state.tabs.some(tab => tab.id === snapshot.state.activeTab)) snapshot.state.activeTab = snapshot.state.tabs[0].id;
      const referenced = new Set(allItems(snapshot.state).map(item => item.assetId));
      for (const id of snapshot.assets.keys()) if (!referenced.has(id)) snapshot.assets.delete(id);
    }
    validate(snapshot.state, snapshot.assets);
    return snapshot;
  }
  async function* encodedOriginals(snapshot) {
    for (const [id, asset] of snapshot.assets) {
      const original = await ensureOriginal(id, asset);
      yield JSON.stringify([id, { name: asset.name, width: asset.width, height: asset.height, data: await blobToDataURL(original.blob) }]);
    }
  }
  function scheduleCloud(delay = 1200) {
    if (!cloudEnabled) return;
    clearTimeout(cloudTimer); cloudTimer = setTimeout(syncCloud, delay);
  }
  async function saveCloudMeta() {
    if (memoryOnly) return;
    await storageTransaction("meta", "readwrite", tx => {
      tx.objectStore("meta").put(clone(cloudInfo), `cloud:${state.id}`);
    });
  }
  async function cloudRequest(method = "GET", body, conditional = false) {
    const data = method === "GET" ? await github.readCached(conditional ? cloudInfo.revision : undefined, new Map(assets)) : await github.writeCached(body.expectedRevision, body.board.state, body.board.assets);
    if (data === null) return null;
    if (!(data.revision === null || typeof data.revision === "string" && /^[a-f0-9]{40}$/.test(data.revision))) throw new Error("The save service returned an invalid revision.");
    return data;
  }
  async function installShared(record, merge = false) {
    const imported = await unpackBoard(record.board, true);
    const next = clone(imported.state), nextAssets = new Map(imported.assets);
    if (merge) {
      const assetIds = new Map();
      for (const [id, asset] of assets) {
        const newId = nextAssets.has(id) ? uid() : id;
        assetIds.set(id, newId); nextAssets.set(newId, asset);
      }
      for (const tab of clone(state.tabs)) {
        const oldId = tab.id; tab.id = uid();
        if (oldId === state.activeTab) next.activeTab = tab.id;
        for (const section of tab.sections) {
          section.id = uid();
          for (const item of section.items) { item.id = uid(); item.assetId = assetIds.get(item.assetId); }
        }
        next.tabs.push(tab);
      }
      next.revision = Math.max(next.revision, state.revision) + 1;
    }
    if (!allItems().length && !activeTab(next).sections.some(section => section.items.length)) {
      next.activeTab = next.tabs.find(tab => tab.sections.some(section => section.items.length))?.id || next.activeTab;
    }
    validate(next, nextAssets);
    const existing = !memoryOnly ? await readDB("boards", next.id) : null;
    const info = { collection: cloudConfig.collection, revision: record.revision, baseState: clone(imported.state), dirty: merge, lastSyncedAt: merge ? cloudInfo.lastSyncedAt ?? null : Date.now() };
    await persist(next, nextAssets, next.id === state.id ? state.revision : existing?.state.revision ?? -1, info);
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); state = next; assets = nextAssets; cloudInfo = info;
    selection.clear(); sectionSelection.clear(); cursor = null; internalClipboard = []; cloudConflict = false;
    render(); channel?.postMessage({ id: state.id, revision: state.revision });
    cacheOriginals();
    if (merge) notify("This device's existing images were added to the public board without removing shared images.");
  }
  async function syncCloud() {
    if (!cloudEnabled || !state || cloudSaving || cloudConflict) return;
    if (editor.open || viewer.open || deleteWarning.open || gesture || document.body.classList.contains("section-sorting")) { scheduleCloud(1500); return; }
    if (!navigator.onLine) { cloudError = "Offline. Changes are queued on this device."; setSaveStatus(); return; }
    cloudSaving = true; setSaveStatus();
    let retryWrite = false;
    try {
      await queue;
      {
        lastCloudRead = Date.now();
        const record = await cloudRequest("GET", undefined, Boolean(cloudInfo.revision));
        let deferred = false;
        await enqueue(async () => {
          if (editor.open || viewer.open || deleteWarning.open || gesture || document.body.classList.contains("section-sorting")) { deferred = true; return; }
          if (record) {
            if (record.board === null && record.revision === null) {
              cloudInfo.revision = null; cloudInfo.dirty = true; await saveCloudMeta();
            } else if (!record.board || !record.revision) throw new Error("The shared board response is incomplete.");
            else if (!cloudInfo.revision && state.id !== record.board.state.id && allItems().length) {
              await installShared(record, true);
            } else if (!cloudInfo.revision && allItems().length && JSON.stringify(state) !== JSON.stringify(record.board.state)) {
              const error = new Error("This device has an existing local version. Merge it with the shared board in Settings, or export it before loading the shared version.");
              error.conflict = true; throw error;
            } else if (cloudInfo.dirty) {
              if (cloudInfo.revision !== record.revision) {
                const baseline = cloudInfo.baseState || await github.readState(cloudInfo.revision);
                const merged = MoodboardFormat.mergeStates(baseline, state, record.board.state);
                if (!merged) { const error = new Error("A newer shared save changes the same content. Resolve the conflict in Settings; your local changes are safe."); error.conflict = true; throw error; }
                const imported = await unpackBoard(record.board, true), mergedAssets = new Map([...imported.assets, ...assets]);
                const referenced = new Set(allItems(merged).map(item => item.assetId));
                for (const id of mergedAssets.keys()) if (!referenced.has(id)) mergedAssets.delete(id);
                validate(merged, mergedAssets);
                const info = { ...cloudInfo, revision: record.revision, baseState: clone(record.board.state), lastSyncedAt: Date.now(), dirty: true };
                await persist(merged, mergedAssets, state.revision, info);
                state = merged; assets = mergedAssets; cloudInfo = info; cloudConflict = false;
                render(); channel?.postMessage({ id: state.id, revision: state.revision }); cacheOriginals();
              }
            } else if (cloudInfo.revision !== record.revision || state.id !== record.board.state.id) await installShared(record);
          }
          cloudReady = true; cloudError = ""; cacheOriginals();
          if (!cloudInfo.dirty) { cloudInfo.lastSyncedAt = Date.now(); cloudInfo.baseState ||= clone(state); await saveCloudMeta(); }
        });
        if (deferred) { scheduleCloud(1500); return; }
      }
      if (cloudInfo.dirty) {
        if (!github.connected) { cloudError = ""; cloudReady = true; return; }
        await queue;
        const board = exportSnapshot(), sentId = board.state.id, sentRevision = board.state.revision;
        const saved = await cloudRequest("PUT", { expectedRevision: cloudInfo.revision, board });
        await enqueue(async () => {
          cloudInfo.revision = saved.revision;
          cloudInfo.baseState = clone(board.state);
          cloudInfo.dirty = state.id !== sentId || state.revision !== sentRevision;
          cloudInfo.lastSyncedAt = Date.now();
          const nextAssets = new Map(assets);
          for (const [id, remote] of saved.originals) if (nextAssets.has(id)) nextAssets.set(id, { ...nextAssets.get(id), remote });
          await persist(state, nextAssets, state.revision, cloudInfo); assets = nextAssets;
        });
      }
      cloudError = ""; cloudReady = true;
    } catch (error) {
      retryWrite = error.status === 409;
      if (error.authentication) github.disconnect();
      cloudConflict = Boolean(error.conflict && error.status !== 409);
      if (cloudError !== errorMessage(error)) {
        console.error(error);
        notify(`${cloudConflict ? "Shared save conflict" : "GitHub saving unavailable"}: ${errorMessage(error)} Your changes remain on this device.`);
      }
      cloudError = errorMessage(error);
    } finally {
      cloudSaving = false; setSaveStatus();
      if (cloudInfo.dirty && !cloudConflict && github.connected) scheduleCloud(retryWrite ? 1500 : cloudError ? 30000 : 1200);
    }
  }
  async function resolveShared(mode) {
    if (cloudSaving) { notify("A GitHub save is in progress. Try again when it finishes."); return; }
    if (mode === "replace" && !confirm("Replace the public GitHub board with this device's version? This can remove other people's edits. Export a backup first.")) return;
    if (mode === "load" && cloudInfo.dirty && !confirm("Discard this device's pending changes and load the shared board? Export a backup first.")) return;
    cloudSaving = true; setSaveStatus();
    try {
      const record = await cloudRequest();
      await enqueue(async () => {
        if (mode === "replace") { cloudInfo.revision = record.revision; cloudInfo.dirty = true; await saveCloudMeta(); }
        else if (record.board) await installShared(record, mode === "merge");
        else throw new Error("There is no shared board to load.");
      });
      cloudConflict = false; cloudError = ""; cloudReady = true; editor.close();
    } catch (error) { showEditorError(error); }
    finally { cloudSaving = false; setSaveStatus(); }
    if (!cloudConflict) scheduleCloud(0);
  }
  function connectGitHub() {
    openEditor("Enable auto-sync", async (form) => {
      await github.connect(form.get("githubToken"));
      cloudReady = false; cloudError = ""; scheduleCloud(0);
    });
    editorSuccess = "Auto-sync enabled. Pending edits will upload automatically.";
    hint("Sign in to GitHub and create a fine-grained access token restricted to the moodboard repository, with Contents: Read and write. This is GitHub token authentication, not a separate moodboard account.");
    const setup = el("a", "button");
    setup.href = `https://github.com/settings/personal-access-tokens/new?name=Moodboard&target_name=${encodeURIComponent(cloudConfig.owner)}&contents=write&expires_in=30`;
    setup.target = "_blank"; setup.rel = "noopener noreferrer"; setup.textContent = "Open GitHub sign-in and token setup";
    $("#editor-fields").append(setup);
    const input = field("Repository-scoped GitHub token", "githubToken", "", "password");
    input.placeholder = "PUT IT HERE NAO";
    input.required = true; input.autocomplete = "off"; input.spellcheck = false;
    hint("The token is kept only in this open tab and sent only to api.github.com. It is never stored in a backup, portable HTML, browser storage, or your repository. Reconnect after reloading if you want to upload more edits; public browsing needs no token.");
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = el("a");
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function downloadSelectedOriginals() {
    if (exporting) { notify("An export is already being prepared. Wait for its download before starting another."); return; }
    const wanted = new Set(tabItems().filter(item => selection.has(item.id)).map(item => item.assetId));
    for (const section of activeTab().sections) if (sectionSelection.has(section.id)) for (const item of section.items) wanted.add(item.assetId);
    if (!wanted.size) { notify("Select images or nonempty sections to download their originals."); return; }
    if (wanted.size > 65535) { report(new Error("Select fewer than 65,536 originals for one ZIP download.")); return; }
    const originals = new Map([...wanted].map(id => [id, assets.get(id)]));
    exporting = true; setSaveStatus();
    try {
      const parts = [], directory = [], encoder = new TextEncoder(), names = new Set();
      let offset = 0;
      const header = length => {
        const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
        return { bytes, short: (at, value) => view.setUint16(at, value, true), long: (at, value) => view.setUint32(at, value, true) };
      };
      const table = Uint32Array.from({ length: 256 }, (_, value) => {
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
        return value >>> 0;
      });
      for (const [id, asset] of originals) {
        const { blob } = await ensureOriginal(id, asset);
        if (blob.size > 0xffffffff || offset + blob.size + 100000 > 0xffffffff) throw new Error("This selection exceeds the 4 GB ZIP limit. Download fewer originals at a time.");
        let name = asset.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 200) || "original";
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
        const base = name, dot = base.lastIndexOf("."), stem = dot > 0 ? base.slice(0, dot) : base, extension = dot > 0 ? base.slice(dot) : "";
        let suffix = 1;
        while (names.has(name.toLowerCase())) name = `${stem} (${++suffix})${extension}`;
        names.add(name.toLowerCase());
        const filename = encoder.encode(name);
        let crc = 0xffffffff;
        const reader = blob.stream().getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const byte of value) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
          }
        } finally { reader.releaseLock(); }
        crc = (crc ^ 0xffffffff) >>> 0;
        const local = header(30), central = header(46);
        local.long(0, 0x04034b50); local.short(4, 20); local.short(6, 0x800); local.short(12, 33);
        local.long(14, crc); local.long(18, blob.size); local.long(22, blob.size); local.short(26, filename.length);
        central.long(0, 0x02014b50); central.short(4, 20); central.short(6, 20); central.short(8, 0x800); central.short(14, 33);
        central.long(16, crc); central.long(20, blob.size); central.long(24, blob.size); central.short(28, filename.length); central.long(42, offset);
        parts.push(local.bytes, filename, blob); directory.push(central.bytes, filename);
        offset += local.bytes.length + filename.length + blob.size;
      }
      const directorySize = directory.reduce((size, part) => size + part.length, 0);
      if (offset + directorySize + 22 > 0xffffffff) throw new Error("This selection exceeds the 4 GB ZIP limit. Download fewer originals at a time.");
      const end = header(22);
      end.long(0, 0x06054b50); end.short(8, originals.size); end.short(10, originals.size); end.long(12, directorySize); end.long(16, offset);
      download(new Blob([...parts, ...directory, end.bytes], { type: "application/zip" }), `moodboard-originals-${new Date().toISOString().slice(0, 10)}.zip`);
      notify(`${originals.size} original files downloaded. Extract the ZIP, then drop the images into your other moodboard. Files are not resized; new imports use that board's storage.`);
    } catch (error) { report(error); }
    finally { exporting = false; setSaveStatus(); }
  }
  function openExport() {
    const groups = [];
    let avoidStorage;
    const selected = () => new Map(groups.filter(group => group.master.checked || group.master.indeterminate)
      .map(group => [group.id, new Set(group.sections.filter(section => section.input.checked).map(section => section.id))]));
    openEditor("Export tabs and sections", () => exportPortable(selected(), true, avoidStorage.input.checked));
    editorSuccess = "Selected content exported as a separate HTML file. Your full board is unchanged.";
    $("#editor-submit").textContent = "Export HTML";
    const container = el("div", "export-choices"), summary = el("p", "export-summary");
    summary.setAttribute("role", "status");
    const choice = (name, label) => {
      const node = el("label", "export-choice"), input = el("input"); input.type = "checkbox";
      input.setAttribute("aria-label", label);
      const text = el("span", "", name); text.title = name;
      node.append(input, text); return { node, input };
    };
    const all = choice("Select all tabs and sections", "Select all tabs and sections");
    const update = () => {
      for (const group of groups) if (group.sections.length) {
        const count = group.sections.filter(section => section.input.checked).length;
        group.master.checked = count === group.sections.length;
        group.master.indeterminate = count > 0 && count < group.sections.length;
      }
      const selection = selected(), ids = new Set();
      let count = 0;
      for (const tab of state.tabs) for (const section of tab.sections) if (selection.get(tab.id)?.has(section.id)) {
        count++; for (const item of section.items) ids.add(item.assetId);
      }
      all.input.checked = groups.length > 0 && groups.every(group => group.master.checked);
      all.input.indeterminate = selection.size > 0 && !all.input.checked;
      summary.textContent = `${selection.size} tabs · ${count} sections · ${ids.size} original ${ids.size === 1 ? "image" : "images"}`;
      $("#editor-submit").disabled = selection.size === 0;
    };
    for (const tab of state.tabs) {
      const details = el("details", "export-tab"), heading = el("summary"), sectionList = el("div", "export-section-list");
      const master = choice(tab.name, tab.sections.length ? `Select all sections in ${tab.name}` : `Include tab ${tab.name}`);
      master.node.addEventListener("click", event => event.stopPropagation());
      heading.append(master.node, el("small", "", `${tab.sections.length} sections`)); details.append(heading, sectionList);
      const group = { id: tab.id, master: master.input, sections: [] }; groups.push(group);
      for (const section of tab.sections) {
        const check = choice(`${section.name} (${section.items.length})`, `Export section ${section.name} in ${tab.name}`);
        group.sections.push({ id: section.id, input: check.input });
        check.input.addEventListener("change", update); sectionList.append(check.node);
      }
      master.input.addEventListener("change", () => {
        for (const section of group.sections) section.input.checked = master.input.checked;
        update();
      });
      container.append(details);
    }
    all.input.addEventListener("change", () => {
      for (const group of groups) {
        group.master.checked = all.input.checked;
        for (const section of group.sections) section.input.checked = all.input.checked;
      }
      update();
    });
    avoidStorage = choice("Memory-only file (no browser autosave)", "Memory-only file (no browser autosave)");
    avoidStorage.input.checked = isolatedPortable || memoryOnly;
    $("#editor-fields").append(all.node, container, summary, avoidStorage.node);
    hint("Only selected sections and their full original images are included. The exported file is an independent board; it does not replace this one.");
    hint("Memory-only files avoid the browser image database, but still need RAM. Save a new HTML copy after editing; changes are not autosaved.");
    update();
  }
  async function exportPortable(selected, throwErrors = false, avoidStorage = isolatedPortable || memoryOnly) {
    if (!state) return;
    if (exporting) { notify("An export is already being prepared. Wait for its download before starting another."); return; }
    exporting = true; setSaveStatus();
    const control = $("#save-portable");
    control.disabled = true; control.textContent = "Preparing copy…";
    try {
      await queue;
      const snapshot = exportSnapshot(selected);
      const html = document.documentElement.cloneNode(true);
      const find = (selector) => html.querySelector(selector);
      for (const manifest of html.querySelectorAll("link[rel=manifest]")) manifest.remove();
      find("#portable-data").textContent = JSON.stringify({ format: "moodboard", version: 1, state: snapshot.state, assets: [], embeddedAssetCount: snapshot.assets.size }).replace(/</g, "\\u003c");
      const marker = "<!--MOODBOARD_PORTABLE_ORIGINALS-->";
      find("#portable-data").after(document.createComment("MOODBOARD_PORTABLE_ORIGINALS"));
      find("#cloud-config").textContent = "null";
      find("#portable-options").textContent = avoidStorage ? '{"memoryOnly":true}' : "null";
      find("#board-header").classList.remove("shy-hidden");
      find(".app-header").classList.remove("shy-hidden");
      find("#editor-form").append(find(".dialog-footer"));
      for (const selector of ["#sections", "#tabs", "#editor-fields", "#editor-extra"]) find(selector).replaceChildren();
      for (const node of html.querySelectorAll("dialog")) node.removeAttribute("open");
      for (const selector of ["#notice", "#selection-bar", "#drag-preview", "#rubber-band", "#storage-warning", "#editor-error"]) find(selector).hidden = true;
      find("#viewer-image").removeAttribute("src");
      find("#viewer-original").removeAttribute("href"); find("#viewer-download").removeAttribute("href");
      find("#viewer-source").removeAttribute("href"); find("#viewer-source").hidden = true;
      find("#viewer-locations-list").replaceChildren(); find("#viewer-locations").hidden = true;
      find("#viewer-locations-toggle").hidden = true; find("#viewer-locations-toggle").setAttribute("aria-expanded", "false");
      find("#save-portable").removeAttribute("disabled"); find("#save-portable").textContent = "↓ Save portable copy";
      find("#save-status").textContent = "Opening your space…";
      html.querySelector("body").classList.remove("edit-off", "dragging");
      for (const node of html.querySelectorAll("[disabled]")) node.removeAttribute("disabled");
      const template = html.outerHTML, boundary = template.indexOf(marker);
      const parts = [new Blob(["<!doctype html>\n", template.slice(0, boundary)])];
      let count = 0;
      for await (const original of encodedOriginals(snapshot)) {
        parts.push(new Blob(['<script type="application/json" data-portable-asset>', original.replace(/</g, "\\u003c"), "</" + "script>"]));
        control.textContent = `Preparing ${++count}/${snapshot.assets.size}…`;
      }
      parts.push(new Blob([template.slice(boundary + marker.length)]));
      download(new Blob(parts, { type: "text/html;charset=utf-8" }), `moodboard-${selected ? "selection-" : ""}${new Date().toISOString().slice(0, 10)}.html`);
      if (!selected) dirty = false;
      notify(selected ? "Selected content exported. Your full board is unchanged." : "Portable HTML saved with all original images. Copy it to your USB. Save a new copy after making more changes.");
    } catch (error) { if (throwErrors) throw error; report(error); }
    finally { exporting = false; control.textContent = "↓ Save portable copy"; setSaveStatus(); }
  }
  async function exportJSON() {
    if (exporting) { notify("An export is already being prepared. Wait for its download before starting another."); return; }
    exporting = true; setSaveStatus();
    try {
      await queue;
      const snapshot = exportSnapshot();
      const large = [...snapshot.assets.values()].some(asset => !asset.blob) || [...snapshot.assets.values()].reduce((sum, asset) => sum + asset.blob.size, 0) > 128 * 1024 * 1024;
      const header = large
        ? JSON.stringify({ format: "moodboard-lines", version: 1, state: snapshot.state, assetCount: snapshot.assets.size }) + "\n"
        : JSON.stringify({ format: "moodboard", version: 1, state: snapshot.state }).slice(0, -1) + ',"assets":[';
      const parts = [new Blob([header])]; let first = true;
      for await (const original of encodedOriginals(snapshot)) {
        parts.push(new Blob([large || first ? "" : ",", original, large ? "\n" : ""])); first = false;
      }
      if (!large) parts.push(new Blob(["]}"]));
      download(new Blob(parts, { type: large ? "application/x-ndjson" : "application/json" }), `moodboard-backup-${new Date().toISOString().slice(0, 10)}.${large ? "jsonl" : "json"}`);
      dirty = false; notify("Backup exported with all original images.");
    } catch (error) { report(error); }
    finally { exporting = false; setSaveStatus(); }
  }
  function guide() {
    openEditor("Take your inspiration anywhere", null);
    const paragraphs = [
      ["Add quickly", "Press Ctrl+V / ⌘V anywhere outside a text field. Choose a “Paste here” gap first, or the end-of-section gap to append. Use the header image-plus icon for your photo library. Consecutive pastes keep their order."],
      ["Source pages", "When the clipboard includes an explicit source-page URL or canonical page metadata, it is saved with the image. Image URLs are not mistaken for page URLs. Screenshots and most copied images omit the page address; add or correct it in the image’s details menu. Source page opens that link from the viewer. Links stay in offline saves and backups, but opening the source website requires internet."],
      ["Captions", "Below Manage in Settings and backups are Caption switches for the entire caption, filenames, and URLs. Save to apply. Missing URLs have no placeholder text. Images with a source page also have a link icon on their hover controls and in their details menu, even if captions are hidden."],
      ["Organize", "Grid and List always show selection checkboxes while editing. On desktop, quickly drag from an image, checkbox, or empty space to select a rectangle; hold Ctrl/Command/Shift to add to the selection. All selects the current tab; the section icon expands selection to every represented section. Hold an image to rearrange it instead; on phones use its dotted grip. Move provides an accessible alternative."],
      ["Crop without losing originals", "Use an image's crop icon. The editor always shows the full original: draw a crop, move its frame, or resize its corners. Keyboard users can focus the frame: arrows move it and Shift+arrows resize in one-percent steps. Reset crop, Cancel, and Save share the bottom bar. Crops only affect the board, never original downloads or the full-image viewer, and are included in backups and portable copies."],
      ["Tabs & sections", "Use the reorder button after the tab plus to drag tabs into order, then Save. Tab and section details have a collapsed Rearrange control below Position, with the edited entry bold. Drag a section's dotted header grip to reorder sections directly; Escape cancels. Handles support Up/Down and Home/End. The collapse-all icon collapses the current tab. Double-click a tab, press F2, or touch and hold it to edit. Long section titles truncate visually; full names stay available in tooltips and editors."],
      ["Save to computer or USB", "Save portable copy downloads a single HTML file containing the app, every original image, and your organization. Open it on a computer without internet. It is a snapshot: after editing, save a NEW portable copy. The app cannot silently rewrite files on your USB."],
      ["On your phone", "For reliable phone use, open the hosted HTTPS site while online, then use your browser’s Add to Home Screen / Install option and import a JSON backup. Open it once to finish caching before going offline. Mobile Files apps may only preview local HTML rather than run it; portable HTML is not a guaranteed phone installation method."],
      ["GitHub autosave", "The published board is publicly viewable. To upload changes, use Settings and backups → Enable auto-sync with a fine-grained token restricted to the moodboard repository and Contents: Read and write. The token lives only in this open tab and is sent only to GitHub; enable it again after a reload. Changes upload automatically, including removal of an original file when its last placement is deleted. Earlier copies remain in Git history. Conflicts keep your local changes until you resolve them in Settings."],
      ["Offline & storage", "Original bytes are never resized or compressed. The shared site caches full originals and queues offline changes in this browser. Private browsing may discard storage, so keep backups. Save portable copy embeds ALL originals from ALL tabs and sections, including collapsed sections and the uncropped originals, plus organization and metadata. It needs no internet, GitHub login, or companion files. Portable copies contain no token and do not automatically publish; import their JSON backup on the hosted site to bring edits back. Large collections require substantial memory during export."],
      ["Selection & editing", "Editing is on by default each time the app opens. Use the pencil beside Masonry/Grid/List to toggle editing. Turning it off protects against accidental changes. Click an image to open the original-resolution viewer. Use arrows or swipe to browse; Actual size allows panning. Copy to… duplicates images between sections/tabs; Ctrl+C / ⌘C and paste also work within the open app."],
      ["Before your flight", "Import or paste your images, save a portable copy AND a JSON backup, then test the app in airplane mode on the device you’ll use. An offline installation is ready only when the status says “Offline ready”."]
    ];
    for (const [title, text] of paragraphs) {
      $("#editor-fields").append(el("h3", "guide-heading", title)); hint(text);
    }
  }
  function settings() {
    openEditor("Settings", async (form) => {
      await enqueue(() => commit((next) => {
        next.settings.accent = form.get("accent");
        for (const key of ["showCaptions", "showFilenames", "showUrls", "showAddImages"]) next.settings[key] = form.has(key);
      }));
    });
    editor.classList.add("settings-editor");
    $("#editor-title").hidden = true;
    const manage = el("section", "settings-manage"), actions = el("div", "dialog-extra manage-actions");
    const heading = el("div", "manage-heading"), descriptions = [];
    const info = button("", () => {
      showManageHelp = !showManageHelp;
      for (const description of $$(".button-description", editor)) description.hidden = !showManageHelp;
      info.setAttribute("aria-pressed", String(showManageHelp));
      info.setAttribute("aria-expanded", String(showManageHelp));
    }, "icon-button manage-info");
    info.setAttribute("aria-label", "About management buttons"); info.title = "About management buttons";
    info.setAttribute("aria-pressed", String(showManageHelp)); info.setAttribute("aria-expanded", String(showManageHelp));
    setIcon(info, '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>');
    heading.append(el("h3", "guide-heading", "Manage"), info);
    const conflict = el("p", "error", "A newer shared version conflicts with this device. Export a backup, then choose how to resolve it.");
    conflict.id = "manage-conflict"; conflict.setAttribute("role", "alert"); conflict.hidden = true;
    const lastSync = el("p", "hint"); lastSync.id = "last-sync";
    lastSync.title = "Last successful GitHub read or upload on this device, shown in local time.";
    manage.append(heading, conflict, lastSync, actions); $("#editor-fields").append(manage);
    const action = (label, handler, description, className = "button") => {
      const control = button(label, handler, className);
      descriptions.push({ control, description }); return control;
    };
    {
      const connection = el("div", "manage-row");
      if (!github?.connected) {
        const login = el("a", "button github-login", "Login");
        descriptions.push({ control: login, description: "Opens GitHub sign-in in another tab. Signing in there does not enable auto-sync by itself." });
        login.addEventListener("click", (event) => { if (!navigator.onLine) event.preventDefault(); });
        login.href = "https://github.com/login"; login.target = "_blank"; login.rel = "noopener noreferrer"; connection.append(login);
      }
      const enable = action("Enable auto-sync", connectGitHub, "Authorize this tab to upload edits automatically using a repository-scoped token. The token stays only in this open tab; enable again after reloading.", "button github-action enable-auto-sync");
      if (github?.connected) {
        const check = el("span", "sync-check", "✓"); check.setAttribute("aria-hidden", "true"); enable.append(check);
        enable.title = "Auto-sync is enabled for this tab";
      }
      connection.append(enable);
      if (github?.connected) {
        const disconnect = button("Disconnect GitHub", () => { github.disconnect(); editor.close(); setSaveStatus(); }, "button");
        disconnect.hidden = true; connection.append(disconnect);
      }
      actions.append(connection,
        action("Force re-sync", () => { editor.close(); scheduleCloud(0); }, "Recheck GitHub and retry queued uploads. Uploading requires enabled auto-sync; failed uploads stay saved on this device.", "button github-action"));
    }
    const backups = el("div", "manage-row");
    backups.append(action("Export JSON backup", exportJSON, "Download a complete backup with every original image, tab, section, source URL, and crop. Keep it somewhere outside browser storage."),
      action("Import JSON backup", () => $("#backup-file").click(), "Restore a backup after confirming replacement of this open collection. On the hosted site, the imported version also queues a replacement of the shared board; export your current board first."));
    actions.append(backups);
    if (!isolatedPortable && navigator.storage?.persist) actions.append(action("Protect browser storage", async () => {
      try {
        const granted = await navigator.storage.persist();
        notify(granted ? "Persistent storage granted. Still keep a portable backup." : "Your browser did not grant persistent storage. Export backups regularly.");
      } catch (error) { report(error); }
    }, "Ask the browser not to automatically evict this app's storage. This is not a backup and does not prevent manual deletion or device loss."));
    actions.append(
      action("Merge local with Github version", () => resolveShared("merge"), "Combine this device's board with GitHub without discarding either version. It may create duplicate placements to organize. Uploading the result requires enabled auto-sync.", "button github-action"),
      action("Offline & portability guide", guide, "Open instructions for offline browsing, portable HTML, phone use, backups, and bringing offline changes back."));
    {
      const destructive = el("div", "destructive-actions");
      destructive.append(el("h4", "guide-heading", "Destructive actions"),
        action("Replace Github with local version", () => resolveShared("replace"), "Queue this device's board to replace the public GitHub board, potentially removing other people's edits. Confirmation and enabled auto-sync are required to publish; export a backup first.", "button danger github-action"),
        action("Replace local with Github version", () => resolveShared("load"), "Replace this device's board with the GitHub version. Pending local edits are discarded after confirmation; export a backup first.", "button danger github-action"));
      manage.append(destructive);
      const sharing = el("p", "hint");
      syncText(sharing, cloudEnabled ? "Anyone can view. Enable auto-sync with repository write access to upload edits automatically. Originals and organization are saved to the board branch; deletions remain in Git history. Offline edits wait on this device. No separate server or tunnel is required."
        : isolatedPortable ? "This file never saves images or edits to browser storage and never syncs with GitHub. Save a new portable copy to keep changes."
          : "GitHub sync is available on the published website. Local and portable copies save only on this device; import their JSON backup on the hosted site to bring edits back.");
      manage.append(sharing);
      const status = el("p", "hint");
      syncText(status, $("#save-status").textContent);
      manage.append(status);
    }
    const total = [...assets.values()].reduce((sum, asset) => sum + (asset.blob?.size || 0), 0);
    manage.append(el("p", "hint", `${allItems().length} image placements · ${assets.size} original files · ${sizeText(total)} ${isolatedPortable ? "in memory only. No local autosave; save a new portable copy to keep edits." : "cached on this device. Local autosave is not a backup; export a copy regularly."}`));
    const couponSection = el("div", "coupon-code");
    const couponInput = field("Coupon code", "coupon", state.settings.couponCode ?? couponCode);
    couponInput.id = "coupon-code"; couponInput.removeAttribute("name"); couponInput.maxLength = 500;
    couponInput.addEventListener("input", updateGitHubControls);
    const copyCoupon = action("Copy coupon", async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard writing is unavailable in this browser.");
        await navigator.clipboard.writeText(couponInput.value);
        notify("Coupon copied.");
      } catch (error) { report(new Error("Could not copy the coupon. Allow clipboard access in this browser and try again.", { cause: error })); }
    }, "Copy the public coupon code to your clipboard, including offline. This is not a GitHub credential and does not enable auto-sync.", "button icon-button");
    copyCoupon.id = "copy-coupon";
    copyCoupon.setAttribute("aria-label", "Copy coupon"); copyCoupon.title = "Copy coupon";
    setIcon(copyCoupon, '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>');
    const saveCoupon = action("Save coupon", async () => {
      try {
        if (!MoodboardFormat.validCoupon(couponInput.value)) throw new Error("Coupon codes must be at most 500 characters and cannot contain GitHub access tokens.");
        const value = couponInput.value;
        saveCoupon.disabled = true;
        await enqueue(() => commit((next) => { next.settings.couponCode = value; }));
        editor.close();
        notify(memoryOnly ? "Coupon is only in memory. Export a backup to keep it." : cloudEnabled ? "Coupon saved on this device and queued for GitHub sync." : "Coupon saved on this device. Include it in a backup to sync on the published site.");
      } catch (error) { report(error); }
      finally { saveCoupon.disabled = false; }
    }, "Save this public coupon with the board and close settings. With auto-sync enabled it uploads to GitHub and appears on other devices; offline saves wait to sync. JSON backups and portable copies include the saved value. Never enter a GitHub access token here.", "button icon-button");
    saveCoupon.id = "save-coupon";
    saveCoupon.setAttribute("aria-label", "Save coupon"); saveCoupon.title = "Save coupon";
    setIcon(saveCoupon, '<path d="M4 3h13l4 4v14H3V3h1Z"/><path d="M7 3v6h10V3M7 21v-8h10v8M14 4v3"/>');
    couponSection.append(couponInput.closest(".field"), copyCoupon, saveCoupon); $("#editor-extra").append(couponSection);
    descriptions.forEach(({ control, description }, index) => {
      const wrapper = el("div", "manage-action"), text = el("p", "button-description", description);
      text.id = `manage-help-${index}`; text.hidden = !showManageHelp;
      control.setAttribute("aria-describedby", text.id); control.before(wrapper); wrapper.append(control, text);
    });
    info.setAttribute("aria-controls", descriptions.map((_, index) => `manage-help-${index}`).join(" "));
    for (const [key, label, fallback] of [["showCaptions", "Caption", false], ["showFilenames", "Show filenames", false], ["showUrls", "Show URLs", true], ["showAddImages", "Show Add image buttons", false]]) {
      const input = field(label, key, "on", "checkbox");
      input.checked = state.settings[key] ?? fallback; input.setAttribute("role", "switch"); input.closest(".field").classList.add("caption-toggle");
      if (key === "showCaptions") {
        input.setAttribute("aria-label", "Show captions");
        input.closest(".field").classList.add("caption-heading");
        const heading = input.previousElementSibling;
        heading.setAttribute("role", "heading"); heading.setAttribute("aria-level", "3");
      }
    }
    $("#editor-fields").append($(".dialog-footer"));
    const accent = field("Accent color", "accent", state.settings.accent, "color");
    $("#editor-extra").append(accent.closest(".field"));
    $("#editor-extra").append(couponSection);
    updateGitHubControls();
  }
  $("#backup-file").addEventListener("change", async (event) => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file) return;
    let imported;
    try {
      imported = await readBackup(file);
      if (!confirm(`Replace this open collection with the backup? ${cloudEnabled ? "This will also replace the public GitHub board. " : ""}Export your current board first if you want to keep a copy.`)) return;
      await enqueue(async () => {
        const next = clone(imported.state); next.id = uid(); next.revision = 0;
        await persist(next, imported.assets, -1, cloudEnabled ? { ...cloudInfo, dirty: true } : undefined);
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear(); state = next; assets = imported.assets;
        selection.clear(); sectionSelection.clear(); cursor = null; internalClipboard = []; dirty = true;
        if (cloudEnabled) { cloudInfo.dirty = true; scheduleCloud(); }
        render();
      });
      editor.close(); notify("Backup imported. All images are available offline.");
    } catch (error) { report(new Error(`Import failed: ${errorMessage(error)}`, { cause: error })); }
    finally { await imported?.cleanup?.(); }
  });
  $("#editor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editorAction) return;
    const data = new FormData(event.currentTarget), action = editorAction;
    const controls = $$("button", editor);
    controls.forEach((control) => { control.disabled = true; });
    $("#editor-error").hidden = true;
    try { await action(data); editor.close(); notify(editorSuccess); }
    catch (error) { showEditorError(error); }
    finally { controls.forEach((control) => { control.disabled = false; }); updateGitHubControls(); }
  });
  $("#editor-delete").addEventListener("click", async () => {
    const controls = $$("button", editor); controls.forEach((control) => { control.disabled = true; });
    try { if (await editorDelete() !== false) { editor.close(); notify("Deleted."); } }
    catch (error) { showEditorError(error); }
    finally { controls.forEach((control) => { control.disabled = false; }); updateGitHubControls(); }
  });
  $("#close-editor").addEventListener("click", () => editor.close());
  addEventListener("online", updateGitHubControls);
  addEventListener("offline", updateGitHubControls);
  $("#cancel-editor").addEventListener("click", () => editor.close());
  $("#save-portable").addEventListener("click", () => exportPortable());
  $("#export-selected").addEventListener("click", openExport);
  $("#download-selected").addEventListener("click", downloadSelectedOriginals);
  $("#more").addEventListener("click", () => { if (state) settings(); });
  $("#help").addEventListener("click", guide);
  $("#new-tab").addEventListener("click", () => openTab());
  $("#reorder-tabs").addEventListener("click", openTabOrder);
  $("#collapse-sections").addEventListener("click", () => mutate(next => {
    for (const section of activeTab(next).sections) section.collapsed = true;
  }));
  $("#new-section").addEventListener("click", () => openSection());
  $("#bottom-add").addEventListener("click", () => openSection());
  $("#add-images").addEventListener("click", () => $("#image-files").click());
  $("#image-files").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  $("#paste-button").addEventListener("click", pasteFromButton);
  function appendAtBottom() { cursor = null; renderCursor(); notify("New images will be appended at the bottom of this tab."); }
  $("#paste-bottom").addEventListener("click", appendAtBottom);
  $("#edit-toggle").addEventListener("click", () => {
    editable = !editable; endGesture(true); selection.clear(); sectionSelection.clear(); render();
  });
  for (const control of $$("button[data-layout]")) control.addEventListener("click", () => mutate((next) => { next.settings.layout = control.dataset.layout; }));
  $("#zoom").addEventListener("input", (event) => {
    document.documentElement.style.setProperty("--tile-size", `${event.target.value}px`);
    scheduleMasonry();
  });
  $("#zoom").addEventListener("change", (event) => {
    const zoom = Number(event.target.value); mutate((next) => { next.settings.zoom = zoom; });
  });
  $("#spacing").addEventListener("input", event => event.target.setCustomValidity(""));
  $("#spacing").addEventListener("change", event => {
    const input = event.target, spacing = input.valueAsNumber;
    if (!Number.isInteger(spacing) || spacing < 0 || spacing > 40) {
      input.setCustomValidity("Enter a whole pixel value from 0 to 40."); input.reportValidity(); return;
    }
    if (spacing !== cardGap()) mutate(next => { next.settings.spacing = spacing; });
  });
  $("#spacing").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); event.target.blur(); } });
  const boardHeader = $("#board-header"), appHeader = $(".app-header");
  let headerScrollY = scrollY;
  const revealHeader = () => { boardHeader.classList.remove("shy-hidden"); appHeader.classList.remove("shy-hidden"); headerScrollY = Math.max(0, scrollY); };
  boardHeader.addEventListener("focusin", revealHeader);
  appHeader.addEventListener("focusin", revealHeader);
  document.addEventListener("scroll", () => {
    const y = Math.max(0, scrollY), delta = y - headerScrollY;
    if (y === 0 || boardHeader.getBoundingClientRect().top > 50 || editor.open || viewer.open || gesture || document.body.classList.contains("section-sorting") || boardHeader.querySelector(":focus-visible") || appHeader.querySelector(":focus-visible")) {
      revealHeader(); return;
    }
    if (Math.abs(delta) < 8) return;
    boardHeader.classList.toggle("shy-hidden", delta > 0); appHeader.classList.toggle("shy-hidden", delta > 0); headerScrollY = y;
  }, { passive: true });
  function selectAll() {
    if (sectionSelection.size) sectionSelection = new Set(activeTab().sections.map((section) => section.id));
    else selection = new Set(tabItems().map((item) => item.id));
    renderSelection();
  }
  $("#select-all").addEventListener("click", selectAll);
  $("#select-section").addEventListener("click", () => {
    const selectedSections = activeTab().sections.filter((section) => section.items.some((item) => selection.has(item.id)));
    selection = new Set(selectedSections.flatMap((section) => section.items.map((item) => item.id)));
    renderSelection();
  });
  $("#clear-selection").addEventListener("click", () => { selection.clear(); sectionSelection.clear(); renderSelection(); });
  $("#copy-selected").addEventListener("click", () => openTransfer(true));
  $("#move-selected").addEventListener("click", () => openTransfer(false));
  function deleteSelected() {
    removeItems(sectionSelection.size ? [...sectionSelection] : [...selection], sectionSelection.size > 0).catch(report);
  }
  $("#delete-selected").addEventListener("click", deleteSelected);
  document.addEventListener("keydown", (event) => {
    if (!state || textTarget(event.target)) return;
    if (viewer.open) {
      if (event.key === "ArrowLeft") { event.preventDefault(); stepViewer(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); stepViewer(1); }
      return;
    }
    if (editor.open || deleteWarning.open) return;
    if (event.key === "Escape") {
      if (gesture) endGesture(true);
      else { selection.clear(); sectionSelection.clear(); renderSelection(); }
    }
    if (!editable) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); selectAll();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && (selection.size || sectionSelection.size)) {
      event.preventDefault(); deleteSelected();
    }
  });
  document.addEventListener("touchmove", (event) => { if (gesture?.dragging) event.preventDefault(); }, { passive: false });
  window.addEventListener("beforeunload", (event) => {
    if (pending || exporting || (memoryOnly && dirty)) { event.preventDefault(); event.returnValue = ""; }
  });
  async function setupOffline() {
    if (isolatedPortable) { $("#connection-status").textContent = "Memory-only portable · no browser image cache · save a new copy after editing"; return; }
    const hosted = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
    if (!hosted || !("serviceWorker" in navigator)) {
      $("#connection-status").textContent = location.protocol === "file:" ? "Portable · no network needed" : "Use portable export for offline access";
      return;
    }
    try {
      const manifest = el("link"); manifest.rel = "manifest"; manifest.href = "./manifest.webmanifest"; document.head.append(manifest);
      await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      shellReady = true; updateOfflineStatus();
    } catch (error) {
      console.error(error); $("#connection-status").textContent = "Offline cache unavailable · save a portable copy";
    }
  }
  async function initialize() {
    $("#save-portable").disabled = true;
    $("#export-selected").disabled = true;
    let cleanupEmbedded;
    try {
      if (isolatedPortable) {
        memoryOnly = true;
        warning("This separate file does not use browser autosave or GitHub sync. Images and edits stay in memory. Save a new portable copy before closing to keep changes.");
      } else {
        try { await storageDB(); }
        catch (error) {
          memoryOnly = true; console.error(error);
          warning("Local autosave is unavailable in this browser/file location. You can still work, but MUST Save portable copy before closing.");
        }
      }
      let embedded = null;
      const payload = JSON.parse($("#portable-data").textContent);
      if (payload) {
        const chunks = $$("script[data-portable-asset]");
        if (payload.embeddedAssetCount !== undefined) {
          if (payload.embeddedAssetCount !== chunks.length) throw new Error("The portable copy is incomplete. Your saved board has not been replaced.");
          const originals = new Map(), staging = originalStaging(originals);
          cleanupEmbedded = staging.cleanup;
          for (const chunk of chunks) {
            const entry = JSON.parse(chunk.textContent); chunk.textContent = ""; chunk.remove();
            const bytes = await unpackAsset(entry, originals); await stagePortable(staging, false, bytes);
          }
          await stagePortable(staging, true);
          validate(payload.state, originals); embedded = { state: payload.state, assets: originals };
        } else { embedded = await unpackBoard(payload, false, true); cleanupEmbedded = embedded.cleanup; }
        $("#portable-data").textContent = "null";
      }
      try {
        let saved = null;
        if (!memoryOnly) {
          const savedId = embedded?.state.id || await readDB("meta", "active");
          if (savedId) saved = await readDB("boards", savedId);
        }
        if (saved && (!embedded || saved.state.revision >= embedded.state.revision)) {
          state = saved.state; assets = new Map(saved.assets);
          validate(state, assets);
        } else if (embedded) {
          state = embedded.state; assets = embedded.assets;
          await persist(state, assets, saved?.state.revision ?? -1);
        } else {
          state = initialState(); await persist(state, assets, -1);
        }
      } catch (error) {
        if (!embedded) throw error;
        recoverPortable(error);
        state = embedded.state; assets = embedded.assets;
      }
      if (!isolatedPortable && "BroadcastChannel" in window) {
        channel = new BroadcastChannel("moodboard-changes");
        channel.onmessage = (event) => {
          if (event.data.id === state.id && event.data.revision > state.revision) warning("This collection was updated in another window. Export a backup if needed, then reload before editing.");
        };
      }
      if (cloudEnabled && !memoryOnly) {
        const stored = await readDB("meta", `cloud:${state.id}`);
        if (stored?.collection === cloudConfig.collection) cloudInfo = stored;
      }
      render(); setupOffline(); if (cloudEnabled) cacheOriginals();
      if (cloudEnabled) {
        scheduleCloud(0);
        addEventListener("online", () => scheduleCloud(0));
        addEventListener("offline", () => { cloudError = "Offline. Changes are queued on this device."; setSaveStatus(); });
        document.addEventListener("visibilitychange", () => { if (!document.hidden && (github.connected || Date.now() - lastCloudRead > 60000)) scheduleCloud(0); });
        setInterval(() => { if (!document.hidden && (github.connected || Date.now() - lastCloudRead > 300000)) scheduleCloud(0); }, 30000);
      }
    } catch (error) {
      console.error(error);
      warning(`Could not open this moodboard: ${errorMessage(error)}. Your stored board was not overwritten.`);
      for (const control of $$("button,input", document.querySelector("main"))) control.disabled = true;
      $("#save-status").textContent = "Could not open storage";
    } finally { await cleanupEmbedded?.(); }
  }
  initialize();
})();
