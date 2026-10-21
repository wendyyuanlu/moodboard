(() => {
  "use strict";
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const uid = () => globalThis.crypto?.randomUUID?.() || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const clone = (value) => structuredClone(value);
  const editor = $("#editor");
  const viewer = $("#viewer");
  let state, db, assets = new Map(), urls = new Map();
  let editable = true, selection = new Set(), cursor = null, editorAction, editorDelete;
  let queue = Promise.resolve(), pending = 0, memoryOnly = false, dirty = false;
  let noticeTimer, viewItems = [], viewIndex = 0, internalClipboard = [];
  let suppressClickUntil = 0, gesture = null, dragFrame = 0, selectedTarget = null;
  let channel;
  const supportedImage = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

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
  function notify(message) {
    clearTimeout(noticeTimer);
    $("#notice").textContent = message;
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
    if (!urls.has(assetId)) urls.set(assetId, URL.createObjectURL(assets.get(assetId).blob));
    return urls.get(assetId);
  }
  function sizeText(size) {
    return size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  function initialState() {
    const tabId = uid();
    return { schema: 1, id: uid(), revision: 0, activeTab: tabId, settings: { layout: "masonry", zoom: matchMedia("(max-width: 600px)").matches ? 150 : 220, theme: "light", accent: "#637554" },
      tabs: [{ id: tabId, name: "My inspiration", sections: [{ id: uid(), name: "The little things", collapsed: false, items: [] }] }] };
  }
  function validate(data, assetMap) {
    const fail = () => { throw new Error("This moodboard file is invalid or incomplete. Your current board has not been replaced."); };
    const text = (value, max, required = false) => typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
    if (!data || data.schema !== 1 || !text(data.id, 150, true) || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.tabs) || !data.tabs.length) fail();
    const ids = new Set();
    const unique = (id) => { if (!text(id, 150, true) || ids.has(id)) fail(); ids.add(id); };
    for (const tab of data.tabs) {
      if (!tab || !text(tab.name, 150, true) || !Array.isArray(tab.sections)) fail();
      unique(tab.id);
      for (const section of tab.sections) {
        if (!section || !text(section.name, 150, true) || typeof section.collapsed !== "boolean" || !Array.isArray(section.items)) fail();
        unique(section.id);
        for (const item of section.items) {
          if (!item || !text(item.title, 300, true) || !text(item.notes, 10000) || !assetMap.has(item.assetId)) fail();
          unique(item.id);
        }
      }
    }
    if (!data.tabs.some((tab) => tab.id === data.activeTab)) fail();
    const settings = data.settings;
    if (!settings || !["masonry", "grid", "list"].includes(settings.layout) || !["light", "dark"].includes(settings.theme) || !/^#[a-f0-9]{6}$/i.test(settings.accent) || !Number.isFinite(settings.zoom) || settings.zoom < 100 || settings.zoom > 420) fail();
    for (const [key, asset] of assetMap) {
      if (!text(key, 150, true) || !asset || !(asset.blob instanceof Blob) || !supportedImage.test(asset.blob.type) || !text(asset.name, 500, true) || !Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0) fail();
    }
    return data;
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("moodboard-portable", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("boards");
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Browser storage is unavailable."));
      request.onblocked = () => warning("Close other moodboard windows so local storage can open.");
    });
  }
  function readDB(store, key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Could not read your saved moodboard. Export before clearing browser storage."));
    });
  }
  function persist(next, nextAssets, expectedRevision) {
    if (!db || memoryOnly) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["boards", "meta"], "readwrite");
      const store = tx.objectStore("boards");
      const request = store.get(next.id);
      let conflict = false;
      request.onsuccess = () => {
        if (request.result && request.result.state.revision !== expectedRevision) {
          conflict = true; tx.abort(); return;
        }
        store.put({ state: next, assets: [...nextAssets] }, next.id);
        tx.objectStore("meta").put(next.id, "active");
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(new Error(conflict
        ? "This collection changed in another window. Reload before editing to avoid overwriting it."
        : "Could not save: browser storage may be full. Nothing from this action was changed. Export a portable copy of your saved board, or free space and try again."));
      tx.onerror = () => { /* onabort reports the transaction failure. */ };
    });
  }
  function setSaveStatus() {
    $("#save-status").textContent = pending ? "Saving…" : memoryOnly ? "Export to keep changes" : "Saved on this device";
    $("#save-portable").disabled = pending > 0 || !state;
  }
  function enqueue(action) {
    pending++; setSaveStatus();
    const result = queue.then(action);
    queue = result.catch(report).finally(() => { pending--; setSaveStatus(); });
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
    await persist(next, nextAssets, state.revision);
    state = next; assets = nextAssets; dirty = true;
    for (const [key, url] of urls) if (!assets.has(key)) { URL.revokeObjectURL(url); urls.delete(key); }
    selection = new Set([...selection].filter((id) => tabItems().some((item) => item.id === id)));
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
    $("#selection-bar").hidden = !editable || !selection.size;
    $("#selection-count").textContent = `${selection.size} selected`;
  }
  function render() {
    const current = activeTab();
    document.body.dataset.theme = state.settings.theme;
    document.body.classList.toggle("edit-off", !editable);
    document.documentElement.style.setProperty("--accent", state.settings.accent);
    document.documentElement.style.setProperty("--tile-size", `${state.settings.zoom}px`);
    $("#zoom").value = state.settings.zoom;
    $("#edit-toggle").textContent = editable ? "Edit on" : "Edit off";
    $("#edit-toggle").setAttribute("aria-pressed", String(editable));
    $("#add-images").disabled = !editable;
    for (const control of $$("[data-layout]")) {
      if (control.tagName === "BUTTON") control.setAttribute("aria-pressed", String(control.dataset.layout === state.settings.layout));
    }
    $("#tabs").replaceChildren(...state.tabs.map((tab) => {
      const control = button(tab.name, () => switchTab(tab.id), "tab");
      control.dataset.tabId = tab.id;
      control.setAttribute("aria-current", String(tab.id === state.activeTab));
      control.append(el("small", "", String(tab.sections.reduce((count, section) => count + section.items.length, 0))));
      return control;
    }));
    $("#board-title").textContent = current.name;
    const count = tabItems().length;
    $("#image-count").textContent = `${count} ${count === 1 ? "image" : "images"}`;
    $("#sections").replaceChildren(...current.sections.map(renderSection));
    if (!current.sections.length) {
      const empty = el("div", "empty-section");
      empty.append(el("strong", "", "A little room for possibility."), el("p", "", "Add a section, or paste an image to start collecting."));
      $("#sections").append(empty);
    }
    renderCursor(); renderSelection(); setSaveStatus();
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
    toggle.append(el("span", "chevron", "▾"), el("strong", "", section.name), el("small", "", String(section.items.length)));
    const actions = el("div", "section-actions edit-control");
    const add = button("+ Add", () => { setCursor(section.id); $("#image-files").click(); });
    const edit = button("···", () => openSection(section), "icon-button");
    edit.setAttribute("aria-label", `Edit section ${section.name}`);
    actions.append(add, edit);
    header.append(toggle, actions); node.append(header);
    const body = el("div", "section-body");
    body.hidden = section.collapsed;
    const images = el("div", "images"); images.dataset.layout = state.settings.layout;
    for (const item of section.items) images.append(renderItem(item, section.id));
    body.append(images);
    if (!section.items.length) {
      const empty = el("div", "empty-section");
      empty.append(el("strong", "", "Good things start here."), el("p", "", "Paste an image anywhere, or add photos from your device."));
      body.append(empty);
    }
    body.append(slot(section.id, null, `Paste at end of ${section.name}`, "section-end"));
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
        if (event.shiftKey && selection.size) {
          const items = tabItems(); const start = items.findIndex((entry) => entry.id === [...selection].at(-1));
          const end = items.findIndex((entry) => entry.id === item.id);
          for (let index = Math.min(start, end); index <= Math.max(start, end); index++) if (items[index]) selection.add(items[index].id);
        } else if (selection.has(item.id)) selection.delete(item.id); else selection.add(item.id);
        renderSelection();
      } else openViewer(item.id);
    }, "image-hit");
    hit.setAttribute("aria-label", `Open original image: ${item.title}`);
    const img = el("img"); img.src = imageURL(item.assetId); img.alt = item.title; img.loading = "lazy"; img.decoding = "async"; img.draggable = false;
    img.width = asset.width; img.height = asset.height;
    img.addEventListener("error", () => notify(`Could not display “${item.title}”. The original is still available in your backup.`), { once: true });
    const caption = el("div", "card-caption"); caption.append(el("h3", "", item.title));
    if (item.notes) caption.append(el("p", "", item.notes));
    caption.append(el("small", "card-meta", `${asset.width} × ${asset.height} · ${sizeText(asset.blob.size)}`));
    hit.append(img, caption);
    const check = el("input", "select-image"); check.type = "checkbox";
    check.setAttribute("aria-label", `Select ${item.title}`);
    check.addEventListener("change", () => { if (check.checked) selection.add(item.id); else selection.delete(item.id); renderSelection(); });
    const tools = el("div", "card-tools");
    const drag = button("⠿", () => {
      if (performance.now() >= suppressClickUntil) { selection.add(item.id); renderSelection(); notify("Hold and drag to rearrange, or use Move to… below."); }
    }, "card-tool drag-handle");
    drag.setAttribute("aria-label", `Drag ${item.title}`);
    const edit = button("···", () => openImage(item.id), "card-tool");
    edit.setAttribute("aria-label", `Edit image ${item.title}`);
    tools.append(drag, edit); card.append(hit, check, tools); tile.append(card);
    return tile;
  }
  function switchTab(tabId) {
    if (state.activeTab === tabId) return;
    cursor = null; selection.clear();
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
  function hint(text) { $("#editor-fields").append(el("p", "hint", text)); }
  function openEditor(title, save, remove) {
    editorAction = save; editorDelete = remove;
    $("#editor-form").reset(); $("#editor-fields").replaceChildren(); $("#editor-extra").replaceChildren();
    $("#editor-title").textContent = title; $("#editor-error").hidden = true;
    $("#editor-delete").hidden = !remove;
    $("#editor-submit").hidden = !save;
    $("#cancel-editor").textContent = save ? "Cancel" : "Done";
    if (!editor.open) editor.showModal();
  }
  function nameField(label, value) {
    const input = field(label, "name", value); input.required = true; input.maxLength = 150; return input;
  }
  function positionField(position, maximum) {
    const input = field("Position", "position", String(position), "number");
    input.min = 1; input.max = maximum; input.step = 1; input.required = true;
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
  function openTab(tab) {
    openEditor(tab ? "Your tab, your way" : "A new space for inspiration", async (form) => {
      const name = requireName(form);
      await enqueue(() => commit((next) => {
        const item = tab ? next.tabs.find((entry) => entry.id === tab.id) : { id: uid(), sections: [] };
        item.name = name; reorder(next.tabs, item, form.get("position")); next.activeTab = item.id;
      }));
      cursor = null; selection.clear(); render();
    }, tab ? async () => {
      if (state.tabs.length === 1) throw new Error("Keep at least one tab. You can rename or empty this one.");
      if (!confirm(`Delete “${tab.name}” and everything inside it? Export a backup first if you want to keep a copy.`)) return false;
      await enqueue(() => commit((next) => {
        next.tabs = next.tabs.filter((entry) => entry.id !== tab.id);
        if (next.activeTab === tab.id) next.activeTab = next.tabs[0].id;
      }));
    } : null);
    nameField("Tab name", tab?.name || "");
    positionField(tab ? state.tabs.findIndex((entry) => entry.id === tab.id) + 1 : state.tabs.length + 1, state.tabs.length + (tab ? 0 : 1));
    hint("Change Position to move this tab. Duplicates include every section and image, with independent organization.");
    if (tab) $("#editor-extra").append(button("Duplicate tab", async () => {
      try {
        await enqueue(() => commit((next) => {
          const source = next.tabs.find((entry) => entry.id === tab.id);
          const copy = { ...clone(source), id: uid(), name: `${source.name.slice(0, 140)} (copy)`, sections: source.sections.map(duplicateSection) };
          next.tabs.splice(next.tabs.findIndex((entry) => entry.id === tab.id) + 1, 0, copy);
          next.activeTab = copy.id;
        }));
        cursor = null; selection.clear(); editor.close(); render(); notify("Tab duplicated.");
      } catch (error) { showEditorError(error); }
    }, "button"));
  }
  function openSection(section) {
    const tabId = state.activeTab;
    const current = activeTab();
    openEditor(section ? "A collection of your own" : "A new collection", async (form) => {
      const name = requireName(form);
      await enqueue(() => commit((next) => {
        const item = section ? findSection(section.id, next) : { id: uid(), items: [], collapsed: false };
        if (section) for (const tab of next.tabs) tab.sections = tab.sections.filter((entry) => entry.id !== item.id);
        item.name = name;
        const target = next.tabs.find((tab) => tab.id === form.get("tab")).sections;
        reorder(target, item, form.get("position"));
        next.activeTab = form.get("tab");
      }));
    }, section ? async () => {
      if (!confirm(`Delete section “${section.name}” and its ${section.items.length} images? This cannot be undone.`)) return false;
      await enqueue(() => commit((next) => {
        for (const tab of next.tabs) tab.sections = tab.sections.filter((entry) => entry.id !== section.id);
      }));
    } : null);
    nameField("Section name", section?.name || "");
    const tabSelect = field("Tab", "tab", tabId, "text", state.tabs.map((tab) => [tab.id, tab.name]));
    positionField(section ? current.sections.findIndex((entry) => entry.id === section.id) + 1 : current.sections.length + 1, current.sections.length + (section ? 0 : 1));
    tabSelect.addEventListener("change", () => {
      const max = state.tabs.find((tab) => tab.id === tabSelect.value).sections.filter((entry) => entry.id !== section?.id).length + 1;
      $("[name=position]", editor).max = $("[name=position]", editor).value = max;
    });
    hint("Position changes the section order. You can also move this entire collection to another tab.");
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
  function openImage(itemId) {
    const source = sections().find((section) => section.items.some((item) => item.id === itemId));
    const item = source.items.find((entry) => entry.id === itemId);
    openEditor("The details", async (form) => {
      const title = form.get("title").trim();
      if (!title) throw new Error("Please enter an image title.");
      await enqueue(() => commit((next) => {
        const updated = { ...allItems(next).find((entry) => entry.id === itemId), title, notes: form.get("notes") };
        transfer(next, [itemId], { sectionId: form.get("section"), index: Number(form.get("position")) - 1 }, false, [updated]);
      }));
    }, () => removeItems([itemId]));
    const title = field("Title / filename", "title", item.title); title.required = true; title.maxLength = 300;
    const notes = field("Notes", "notes", item.notes, "textarea"); notes.maxLength = 10000;
    const section = field("Section", "section", source.id, "text", sectionOptions());
    positionField(source.items.findIndex((entry) => entry.id === itemId) + 1, source.items.length);
    section.addEventListener("change", () => {
      const count = findSection(section.value).items.filter((entry) => entry.id !== itemId).length + 1;
      $("[name=position]", editor).max = $("[name=position]", editor).value = count;
    });
    const asset = assets.get(item.assetId);
    hint(`Original: ${asset.width} × ${asset.height} pixels · ${sizeText(asset.blob.size)} · ${asset.blob.type}. Never resized or recompressed.`);
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
  async function removeItems(ids) {
    if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? "image" : "images"}? This cannot be undone.`)) return false;
    const wanted = new Set(ids);
    await enqueue(() => commit((next) => {
      for (const section of sections(next)) section.items = section.items.filter((item) => !wanted.has(item.id));
    }));
    selection.clear(); renderSelection();
  }
  function showEditorError(error) {
    console.error(error); $("#editor-error").textContent = errorMessage(error); $("#editor-error").hidden = false;
  }

  async function readImage(file) {
    if (!supportedImage.test(file.type)) throw new Error(`“${file.name || "Image"}” is not a supported raster image. Use PNG, JPEG, GIF, WebP, AVIF, or BMP.`);
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("The image has no readable dimensions.");
      return { blob: file, name: (file.name || `pasted-${Date.now()}.${file.type.split("/")[1]}`).slice(0, 500), width: image.naturalWidth, height: image.naturalHeight };
    } catch (error) {
      throw new Error(`Could not read “${file.name || "pasted image"}”. Choose an image supported by this browser.`, { cause: error });
    } finally { URL.revokeObjectURL(url); }
  }
  function addFiles(files, target = cursor && { ...cursor }) {
    if (!editable) { notify("Turn Edit on to add images."); return; }
    const list = [...files];
    if (!list.length) { notify("No image files found. Copy an image or use Add images."); return; }
    enqueue(async () => {
      const additions = new Map(), items = [];
      for (const file of list) {
        const asset = await readImage(file), assetId = uid();
        additions.set(assetId, asset);
        items.push({ id: uid(), assetId, title: asset.name.slice(0, 300), notes: "" });
      }
      await commit((next) => insertItems(next, items, target), additions);
      notify(`${items.length} ${items.length === 1 ? "image" : "images"} added · original bytes preserved.`);
    }).catch(() => {});
  }
  function textTarget(target) {
    return target instanceof Element && Boolean(target.closest("input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable=true]"));
  }
  document.addEventListener("paste", (event) => {
    if (!state || textTarget(event.target) || editor.open || viewer.open) return;
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) {
      event.preventDefault(); addFiles(files); return;
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
      const files = [];
      for (const entry of entries) {
        const type = entry.types.find((type) => supportedImage.test(type));
        if (type) files.push(await entry.getType(type));
      }
      if (files.length) addFiles(files, target);
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
    if (!state || !editable || !selection.size || textTarget(event.target) || editor.open || viewer.open) return;
    internalClipboard = clone(tabItems().filter((item) => selection.has(item.id)));
    event.preventDefault(); event.clipboardData.setData("text/plain", "moodboard image selection");
    notify(`${internalClipboard.length} images copied inside moodboard. Choose a location or tab and paste.`);
  });

  function openViewer(itemId) {
    viewItems = tabItems().map((item) => item.id);
    viewIndex = Math.max(0, viewItems.indexOf(itemId));
    $("#viewer-stage").classList.remove("actual");
    $("#viewer-zoom").setAttribute("aria-pressed", "false");
    $("#viewer-zoom").textContent = "Actual size";
    showViewer();
    viewer.showModal();
  }
  function showViewer() {
    const item = allItems().find((item) => item.id === viewItems[viewIndex]);
    if (!item) return;
    const asset = assets.get(item.assetId), url = imageURL(item.assetId);
    $("#viewer-title").textContent = item.title;
    $("#viewer-details").textContent = `${asset.width} × ${asset.height} · ${sizeText(asset.blob.size)} · original`;
    const image = $("#viewer-image"); image.src = url; image.alt = item.title;
    image.width = asset.width; image.height = asset.height;
    $("#viewer-original").href = url;
    $("#viewer-download").href = url; $("#viewer-download").download = asset.name;
    $("#viewer-position").textContent = `${viewIndex + 1} / ${viewItems.length}`;
    $("#viewer-prev").disabled = viewIndex === 0;
    $("#viewer-next").disabled = viewIndex === viewItems.length - 1;
    $("#viewer-stage").scrollTo(0, 0);
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
  $("#viewer-zoom").addEventListener("click", () => {
    const actual = $("#viewer-stage").classList.toggle("actual");
    $("#viewer-zoom").setAttribute("aria-pressed", String(actual));
    $("#viewer-zoom").textContent = actual ? "Fit image" : "Actual size";
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
    gesture.dragging = true;
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
    const edge = 70, speed = gesture.y < edge ? -16 : gesture.y > innerHeight - edge ? 16 : 0;
    if (speed) window.scrollBy(0, speed);
    dragFrame = requestAnimationFrame(moveDrag);
  }
  function endGesture(cancelled = false) {
    if (!gesture) return;
    clearTimeout(gesture.timer); cancelAnimationFrame(dragFrame);
    const old = gesture, target = selectedTarget;
    gesture = null; selectedTarget = null;
    old.capture?.releasePointerCapture?.(old.pointerId);
    document.body.classList.remove("dragging");
    for (const node of $$(".drag-source,.drop-target")) node.classList.remove("drag-source", "drop-target");
    $("#drag-preview").hidden = true; $("#rubber-band").hidden = true;
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
  $("#sections").addEventListener("pointerdown", (event) => {
    if (!editable || event.button !== 0 || editor.open || viewer.open || pending) return;
    const card = event.target.closest(".image-card");
    if (card && (event.target.closest(".image-hit") || event.target.closest(".drag-handle"))) {
      const handle = event.target.closest(".drag-handle");
      gesture = { itemId: card.dataset.itemId, pointerId: event.pointerId, capture: handle || $(".image-hit", card), x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragging: false };
      gesture.timer = setTimeout(startDrag, handle ? 120 : 420);
      return;
    }
    if (event.pointerType !== "mouse" || event.target.closest("button,input,a,.image-card")) return;
    event.preventDefault();
    gesture = { box: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, initial: event.ctrlKey || event.metaKey || event.shiftKey ? new Set(selection) : new Set() };
  });
  document.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (gesture.box) {
      const x = Math.min(gesture.startX, gesture.x), y = Math.min(gesture.startY, gesture.y);
      const w = Math.abs(gesture.x - gesture.startX), h = Math.abs(gesture.y - gesture.startY);
      const box = $("#rubber-band"); box.hidden = false;
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      selection = new Set(gesture.initial);
      for (const card of $$(".image-card")) {
        const rect = card.getBoundingClientRect();
        if (rect.right >= x && rect.left <= x + w && rect.bottom >= y && rect.top <= y + h) selection.add(card.dataset.itemId);
      }
      renderSelection(); return;
    }
    if (!gesture.dragging && Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > 10) {
      clearTimeout(gesture.timer); gesture = null;
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
    if (editor.open || viewer.open) return;
    const location = dropLocation(event.clientX, event.clientY);
    addFiles(event.dataTransfer.files, location || cursor);
  });

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read an original image for export."));
      reader.readAsDataURL(blob);
    });
  }
  async function packageBoard() {
    const data = { format: "moodboard", version: 1, state: clone(state), assets: [] };
    const snapshot = new Map(assets);
    for (const [id, asset] of snapshot) {
      data.assets.push([id, { name: asset.name, width: asset.width, height: asset.height, data: await blobToDataURL(asset.blob) }]);
    }
    return data;
  }
  async function unpackBoard(data) {
    if (!data || data.format !== "moodboard" || data.version !== 1 || !Array.isArray(data.assets)) throw new Error("Choose a valid moodboard JSON backup.");
    const result = new Map();
    for (const entry of data.assets) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || result.has(entry[0])) throw new Error("The backup contains invalid or duplicate image records.");
      const [key, asset] = entry;
      if (!asset || typeof asset.data !== "string" || !/^data:image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\r\n]+$/i.test(asset.data)) throw new Error("The backup contains an unsupported image.");
      const comma = asset.data.indexOf(","), mime = asset.data.slice(5, asset.data.indexOf(";"));
      const binary = atob(asset.data.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: mime });
      const decoded = await readImage(blob);
      result.set(key, { ...decoded, name: asset.name });
    }
    validate(data.state, result);
    return { state: data.state, assets: result };
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = el("a");
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function exportPortable() {
    if (!state) return;
    const control = $("#save-portable");
    control.disabled = true; control.textContent = "Preparing copy…";
    try {
      await queue;
      const data = await packageBoard();
      const html = document.documentElement.cloneNode(true);
      const find = (selector) => html.querySelector(selector);
      for (const manifest of html.querySelectorAll("link[rel=manifest]")) manifest.remove();
      find("#portable-data").textContent = JSON.stringify(data).replace(/</g, "\\u003c");
      for (const selector of ["#sections", "#tabs", "#editor-fields", "#editor-extra"]) find(selector).replaceChildren();
      for (const node of html.querySelectorAll("dialog")) node.removeAttribute("open");
      for (const selector of ["#notice", "#selection-bar", "#drag-preview", "#rubber-band", "#storage-warning", "#editor-error"]) find(selector).hidden = true;
      find("#viewer-image").removeAttribute("src");
      find("#viewer-original").removeAttribute("href"); find("#viewer-download").removeAttribute("href");
      find("#save-portable").removeAttribute("disabled"); find("#save-portable").textContent = "↓ Save portable copy";
      find("#save-status").textContent = "Opening your space…";
      html.querySelector("body").classList.remove("edit-off", "dragging");
      for (const node of html.querySelectorAll("[disabled]")) node.removeAttribute("disabled");
      download(new Blob(["<!doctype html>\n", html.outerHTML], { type: "text/html;charset=utf-8" }), `moodboard-${new Date().toISOString().slice(0, 10)}.html`);
      dirty = false;
      notify("Portable HTML saved with all original images. Copy it to your USB. Save a new copy after making more changes.");
    } catch (error) { report(error); }
    finally { control.textContent = "↓ Save portable copy"; setSaveStatus(); }
  }
  async function exportJSON() {
    try {
      await queue;
      const data = await packageBoard();
      download(new Blob([JSON.stringify(data)], { type: "application/json" }), `moodboard-backup-${new Date().toISOString().slice(0, 10)}.json`);
      dirty = false; notify("Backup exported with all original images.");
    } catch (error) { report(error); }
  }
  function guide() {
    openEditor("Take your inspiration anywhere", null);
    const paragraphs = [
      ["Add quickly", "Press Ctrl+V / ⌘V anywhere outside a text field. Choose a “Paste here” gap first, or append at the bottom. Consecutive pastes keep their order. On mobile, try Paste or use Add images for your photo library."],
      ["Organize", "Use checkboxes to select, Shift-click for a range, or drag a rectangle from empty space on desktop. Hold an image to drag it; on phones the dotted grip is the most reliable drag target. Drop above/below another image or into a section. Hover a tab while dragging to switch tabs. Move to… provides an accessible alternative."],
      ["Save to computer or USB", "Save portable copy downloads a single HTML file containing the app, every original image, and your organization. Open it on a computer without internet. It is a snapshot: after editing, save a NEW portable copy. The app cannot silently rewrite files on your USB."],
      ["On your phone", "For reliable phone use, open the hosted HTTPS site while online, then use your browser’s Add to Home Screen / Install option and import a JSON backup. Open it once to finish caching before going offline. Mobile Files apps may only preview local HTML rather than run it; portable HTML is not a guaranteed phone installation method."],
      ["Offline & storage", "There are no external fonts, images, or runtime libraries. Uploaded/pasted image bytes are never resized or compressed. Browser storage stays on this device and can be cleared by the browser, so keep backups. Copies do not synchronize automatically. Private browsing may discard storage. Very large collections require substantial device memory during export."],
      ["Selection & editing", "Edit on is the default each time you open the app. Edit off protects against accidental changes. Click an image to open the original-resolution viewer. Use arrows or swipe to browse; Actual size allows panning. Copy to… duplicates images between sections/tabs; Ctrl+C / ⌘C and paste also work within the open app."],
      ["Before your flight", "Import or paste your images, save a portable copy AND a JSON backup, then test the app in airplane mode on the device you’ll use. An offline installation is ready only when the status says “Offline ready”."]
    ];
    for (const [title, text] of paragraphs) {
      $("#editor-fields").append(el("h3", "guide-heading", title)); hint(text);
    }
  }
  function settings() {
    openEditor("Make yourself at home", async (form) => {
      await enqueue(() => commit((next) => {
        next.settings.accent = form.get("accent"); next.settings.theme = form.get("theme");
      }));
    });
    field("Accent color", "accent", state.settings.accent, "color");
    field("Appearance", "theme", state.settings.theme, "text", [["light", "Warm & light"], ["dark", "After hours"]]);
    const total = [...assets.values()].reduce((sum, asset) => sum + asset.blob.size, 0);
    hint(`${allItems().length} image placements · ${assets.size} original files · ${sizeText(total)}. Local autosave is not a backup; export a copy regularly.`);
    $("#editor-extra").append(button("Export JSON backup", exportJSON, "button"), button("Import JSON backup", () => $("#backup-file").click(), "button"), button("Offline & portability guide", guide, "button"));
    if (navigator.storage?.persist) $("#editor-extra").append(button("Protect browser storage", async () => {
      try {
        const granted = await navigator.storage.persist();
        notify(granted ? "Persistent storage granted. Still keep a portable backup." : "Your browser did not grant persistent storage. Export backups regularly.");
      } catch (error) { report(error); }
    }, "button"));
  }
  $("#backup-file").addEventListener("change", async (event) => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const imported = await unpackBoard(raw);
      if (!confirm("Replace this open collection with the backup? Export your current board first if you want to keep a copy.")) return;
      await enqueue(async () => {
        const next = clone(imported.state); next.id = uid(); next.revision = 0;
        await persist(next, imported.assets, -1);
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear(); state = next; assets = imported.assets;
        selection.clear(); cursor = null; internalClipboard = []; dirty = true;
        render();
      });
      editor.close(); notify("Backup imported. All images are available offline.");
    } catch (error) { report(new Error(`Import failed: ${errorMessage(error)}`, { cause: error })); }
  });
  $("#editor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editorAction) return;
    const data = new FormData(event.currentTarget), action = editorAction;
    const controls = $$("button", editor);
    controls.forEach((control) => { control.disabled = true; });
    $("#editor-error").hidden = true;
    try { await action(data); editor.close(); notify("Saved to your space."); }
    catch (error) { showEditorError(error); }
    finally { controls.forEach((control) => { control.disabled = false; }); }
  });
  $("#editor-delete").addEventListener("click", async () => {
    const controls = $$("button", editor); controls.forEach((control) => { control.disabled = true; });
    try { if (await editorDelete() !== false) { editor.close(); notify("Deleted."); } }
    catch (error) { showEditorError(error); }
    finally { controls.forEach((control) => { control.disabled = false; }); }
  });
  $("#close-editor").addEventListener("click", () => editor.close());
  $("#cancel-editor").addEventListener("click", () => editor.close());
  $("#save-portable").addEventListener("click", exportPortable);
  $("#more").addEventListener("click", () => { if (state) settings(); });
  $("#help").addEventListener("click", guide);
  $("#new-tab").addEventListener("click", () => openTab());
  $("#tab-options").addEventListener("click", () => openTab(activeTab()));
  $("#new-section").addEventListener("click", () => openSection());
  $("#bottom-add").addEventListener("click", () => openSection());
  $("#add-images").addEventListener("click", () => $("#image-files").click());
  $("#image-files").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  $("#paste-button").addEventListener("click", pasteFromButton);
  $("#paste-bottom").addEventListener("click", () => { cursor = null; renderCursor(); notify("New images will be appended at the bottom of this tab."); });
  $("#edit-toggle").addEventListener("click", () => {
    editable = !editable; selection.clear(); endGesture(true); render();
  });
  for (const control of $$("button[data-layout]")) control.addEventListener("click", () => mutate((next) => { next.settings.layout = control.dataset.layout; }));
  $("#zoom").addEventListener("input", (event) => {
    document.documentElement.style.setProperty("--tile-size", `${event.target.value}px`);
  });
  $("#zoom").addEventListener("change", (event) => {
    const zoom = Number(event.target.value); mutate((next) => { next.settings.zoom = zoom; });
  });
  $("#select-all").addEventListener("click", () => { selection = new Set(tabItems().map((item) => item.id)); renderSelection(); });
  $("#clear-selection").addEventListener("click", () => { selection.clear(); renderSelection(); });
  $("#copy-selected").addEventListener("click", () => openTransfer(true));
  $("#move-selected").addEventListener("click", () => openTransfer(false));
  $("#delete-selected").addEventListener("click", () => { removeItems([...selection]).catch(report); });
  document.addEventListener("keydown", (event) => {
    if (!state || textTarget(event.target)) return;
    if (viewer.open) {
      if (event.key === "ArrowLeft") { event.preventDefault(); stepViewer(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); stepViewer(1); }
      return;
    }
    if (editor.open) return;
    if (event.key === "Escape") { endGesture(true); selection.clear(); renderSelection(); }
    if (!editable) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); selection = new Set(tabItems().map((item) => item.id)); renderSelection();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selection.size) {
      event.preventDefault(); removeItems([...selection]).catch(report);
    }
  });
  document.addEventListener("touchmove", (event) => { if (gesture?.dragging) event.preventDefault(); }, { passive: false });
  window.addEventListener("beforeunload", (event) => {
    if (pending || (memoryOnly && dirty)) { event.preventDefault(); event.returnValue = ""; }
  });
  async function setupOffline() {
    const hosted = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
    if (!hosted || !("serviceWorker" in navigator)) {
      $("#connection-status").textContent = location.protocol === "file:" ? "Portable · no network needed" : "Use portable export for offline access";
      return;
    }
    try {
      const manifest = el("link"); manifest.rel = "manifest"; manifest.href = "./manifest.webmanifest"; document.head.append(manifest);
      await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      $("#connection-status").textContent = "Offline ready";
    } catch (error) {
      console.error(error); $("#connection-status").textContent = "Offline cache unavailable · save a portable copy";
    }
  }
  async function initialize() {
    $("#save-portable").disabled = true;
    try {
      let embedded = null;
      const payload = JSON.parse($("#portable-data").textContent);
      if (payload) embedded = await unpackBoard(payload);
      try { db = await openDB(); }
      catch (error) {
        memoryOnly = true; console.error(error);
        warning("Local autosave is unavailable in this browser/file location. You can still work, but MUST Save portable copy before closing.");
      }
      let saved = null;
      if (db) {
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
      if ("BroadcastChannel" in window) {
        channel = new BroadcastChannel("moodboard-changes");
        channel.onmessage = (event) => {
          if (event.data.id === state.id && event.data.revision > state.revision) warning("This collection was updated in another window. Export a backup if needed, then reload before editing.");
        };
      }
      render(); setupOffline();
    } catch (error) {
      console.error(error);
      warning(`Could not open this moodboard: ${errorMessage(error)}. Your stored board was not overwritten.`);
      for (const control of $$("button,input", document.querySelector("main"))) control.disabled = true;
      $("#save-status").textContent = "Could not open storage";
    }
  }
  initialize();
})();
