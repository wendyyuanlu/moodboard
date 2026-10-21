const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeStates, validateState } = require("../board-format.js");
function state() {
  return { schema: 1, id: "board", revision: 1, activeTab: "photos", settings: { layout: "masonry", zoom: 150, theme: "light", accent: "#637554" },
    tabs: [{ id: "empty", name: "Empty", sections: [] }, { id: "photos", name: "Photos", sections: [{ id: "section", name: "Makeup", collapsed: false,
      items: [{ id: "item", assetId: "original", title: "Image", notes: "" }] }] }] };
}
const items = data => data.tabs.find(tab => tab.id === "photos").sections[0].items;
test("layout changes and empty-tab deletion merge with new shared images without duplication", () => {
  const base = state(), local = structuredClone(base), remote = structuredClone(base);
  local.settings.layout = "grid"; local.settings.zoom = 240; local.tabs.shift(); local.settings.showAddImages = true;
  remote.revision++; items(remote).push({ id: "import", assetId: "new", title: "Imported", notes: "" });
  const merged = mergeStates(base, local, remote);
  assert.equal(merged.settings.layout, "grid"); assert.equal(merged.settings.zoom, 240);
  assert.equal(merged.settings.showAddImages, true); assert.equal(merged.tabs.length, 1);
  assert.deepEqual(items(merged).map(item => item.id), ["item", "import"]);
  validateState(merged, new Set(["original", "new"]));
  assert.equal(base.tabs.length, 2); assert.equal(items(base).length, 1);
});
test("independent content edits and additions merge by stable IDs", () => {
  const base = state(), local = structuredClone(base), remote = structuredClone(base);
  items(local)[0].notes = "Local notes"; items(remote)[0].title = "Remote title";
  items(local).push({ id: "local", assetId: "original", title: "Local", notes: "" });
  items(remote).push({ id: "remote", assetId: "original", title: "Remote", notes: "" });
  const merged = mergeStates(base, local, remote);
  assert.equal(items(merged).length, 3); assert.equal(items(merged)[0].notes, "Local notes"); assert.equal(items(merged)[0].title, "Remote title");
});
test("concurrent content edits and deletion against new images remain real conflicts", () => {
  const base = state(), local = structuredClone(base), remote = structuredClone(base);
  items(local)[0].notes = "A"; items(remote)[0].notes = "B";
  assert.equal(mergeStates(base, local, remote), null);
  const deletion = structuredClone(base), addition = structuredClone(base);
  deletion.tabs.shift(); addition.tabs[0].sections.push({ id: "new-section", name: "New", collapsed: false, items: [items(base)[0]] });
  assert.equal(mergeStates(base, deletion, addition), null);
  const unrelated = structuredClone(base); unrelated.id = "different-board";
  assert.equal(mergeStates(base, local, unrelated), null);
});
test("one-sided reordering keeps remote additions and a valid local active tab", () => {
  const base = state(), local = structuredClone(base), remote = structuredClone(base);
  local.tabs.reverse(); local.activeTab = "empty";
  remote.tabs.push({ id: "added", name: "Added", sections: [] });
  const merged = mergeStates(base, local, remote);
  assert.deepEqual(merged.tabs.map(tab => tab.id), ["photos", "empty", "added"]); assert.equal(merged.activeTab, "empty");
});
test("both-side incompatible reordering and moving one item to two destinations conflict", () => {
  const base = state(); base.tabs.push({ id: "third", name: "Third", sections: [] });
  const local = structuredClone(base), remote = structuredClone(base);
  local.tabs.reverse(); remote.tabs = [remote.tabs[1], remote.tabs[0], remote.tabs[2]];
  assert.equal(mergeStates(base, local, remote), null);
  const a = structuredClone(base), b = structuredClone(base);
  a.tabs[0].sections.push({ id: "a", name: "A", collapsed: false, items: items(a).splice(0) });
  b.tabs[2].sections.push({ id: "b", name: "B", collapsed: false, items: items(b).splice(0) });
  assert.equal(mergeStates(base, a, b), null);
});
test("concurrent display settings prefer this device; coupons remain shared content", () => {
  const base = state(), local = structuredClone(base), remote = structuredClone(base);
  local.settings.layout = "grid"; remote.settings.layout = "list";
  assert.equal(mergeStates(base, local, remote).settings.layout, "grid");
  local.settings.couponCode = "A"; remote.settings.couponCode = "B";
  assert.equal(mergeStates(base, local, remote), null);
});
