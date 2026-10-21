const test = require("node:test");
const assert = require("node:assert/strict");
const { createGitHubStore, prepareBoard } = require("../github-store.js");
const { mockGitHub } = require("./helpers/mock-github.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
function board() {
  return { format: "moodboard", version: 1, state: { schema: 1, id: "collection", revision: 0, activeTab: "tab",
    settings: { layout: "masonry", zoom: 220, theme: "light", accent: "#637554" },
    tabs: [{ id: "tab", name: "Makeup", sections: [{ id: "section", name: "unsorted", collapsed: false,
      items: [{ id: "item", assetId: "asset", title: "original.png", notes: "", sourceUrl: "https://example.com/article" }] }] }] },
    assets: [["asset", { name: "original.png", width: 1, height: 1, data: `data:image/png;base64,${png.toString("base64")}` }]] };
}
function storeFor(remote, authenticated = true) {
  return createGitHubStore({ owner: "example", repo: "moodboard" }, { initialToken: authenticated ? "test-only-token" : "", fetchImpl: remote.fetchImpl });
}
test("originals are ordinary Git files; crops reuse bytes; last deletion removes the file but preserves history", async () => {
  const remote = mockGitHub(), store = storeFor(remote), data = board();
  assert.deepEqual(await store.read(), { revision: null, board: null });
  const first = await store.write(null, data);
  const imagePath = [...remote.files.keys()].find((path) => path.startsWith("images/"));
  assert.ok(imagePath.endsWith("-original.png"));
  const imageSha = remote.files.get(imagePath);
  assert.deepEqual(remote.blobs.get(imageSha), png); assert.equal(remote.files.size, 2);
  data.state.revision++; data.state.tabs[0].sections[0].items[0].crop = { x: 0, y: 0, width: .5, height: 1 };
  const second = await store.write(first.revision, data);
  assert.equal(remote.files.get(imagePath), imageSha);
  assert.equal(remote.calls.filter((call) => call.path === "/git/blobs" && call.data.content === png.toString("base64")).length, 1);
  const loaded = await storeFor(remote).read();
  assert.equal(loaded.revision, second.revision); assert.deepEqual(loaded.board, data);
  data.state.revision++; data.state.tabs[0].sections[0].items = []; data.assets = [];
  await store.write(second.revision, data);
  assert.equal(remote.files.has(imagePath), false); assert.equal(remote.files.size, 1);
  assert.deepEqual(remote.blobs.get(imageSha), png);
  assert.equal(remote.calls.filter((call) => call.path === "/git/commits").length, 3);
  assert.ok(remote.calls.filter((call) => call.path === "/git/commits").every((call) => call.data.message.includes("Co-authored-by: Copilot")));
});
test("copies share original files until the last placement is deleted", async () => {
  const remote = mockGitHub(), store = storeFor(remote), data = board();
  data.state.tabs[0].sections[0].items.push({ ...data.state.tabs[0].sections[0].items[0], id: "copy" });
  const first = await store.write(null, data), imagePath = [...remote.files.keys()].find((path) => path.startsWith("images/"));
  data.state.tabs[0].sections[0].items.shift();
  await store.write(first.revision, data);
  assert.ok(remote.files.has(imagePath));
});
test("whole-section deletion keeps a shared original until its last section in another tab is removed", async () => {
  const remote = mockGitHub(), store = storeFor(remote), data = board();
  const copy = structuredClone(data.state.tabs[0]);
  copy.id = "other-tab"; copy.sections[0].id = "other-section"; copy.sections[0].items[0].id = "other-placement";
  data.state.tabs.push(copy);
  const first = await store.write(null, data), imagePath = [...remote.files.keys()].find(path => path.startsWith("images/"));
  data.state.tabs[0].sections = []; data.state.revision++;
  const second = await store.write(first.revision, data);
  assert.ok(remote.files.has(imagePath));
  data.state.tabs[1].sections = []; data.state.revision++; data.assets = [];
  await store.write(second.revision, data);
  assert.equal(remote.files.has(imagePath), false);
  assert.equal(remote.files.size, 1);
});
test("concurrent saves use compare-and-swap, and a repeated acknowledged save is idempotent", async () => {
  const remote = mockGitHub(), store = storeFor(remote), first = board(), saved = await store.write(null, first);
  const a = structuredClone(first), b = structuredClone(first);
  a.state.tabs[0].name = "A"; b.state.tabs[0].name = "B";
  const results = await Promise.allSettled([store.write(saved.revision, a), store.write(saved.revision, b)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  const writes = remote.history.length;
  await store.write(saved.revision, a); assert.equal(remote.history.length, writes);
});
test("invalid packages and unsafe metadata are rejected before any GitHub call", async () => {
  const remote = mockGitHub(), store = storeFor(remote);
  for (const change of [
    (data) => { data.state.tabs[0].sections[0].items[0].sourceUrl = "javascript:alert(1)"; },
    (data) => { data.state.tabs[0].sections[0].items[0].sourceImageUrl = "javascript:alert(1)"; },
    (data) => { data.state.tabs[0].sections[0].items[0].sourceImageUrl = 42; },
    (data) => { data.assets[0][1].data = "data:image/png;base64,SGVsbG8="; },
    (data) => { data.state.tabs[0].sections[0].items[0].crop = { x: .8, y: 0, width: .5, height: 1 }; },
    (data) => { data.assets.push(data.assets[0]); },
    (data) => { data.state.settings.showFilenames = "yes"; },
    (data) => { data.state.settings.spacing = -1; },
    (data) => { data.state.settings.spacing = 41; },
    (data) => { data.state.settings.spacing = 1.5; },
    (data) => { data.state.settings.spacing = "10"; },
    (data) => { data.state.settings.couponCode = 42; },
    (data) => { data.state.settings.couponCode = "x".repeat(501); },
    (data) => { data.state.settings.couponCode = "github_pat_" + "x".repeat(30); },
    (data) => { data.state.tabs[0].sections[0].items = []; }
  ]) {
    const data = board(); change(data);
    await assert.rejects(store.write(null, data), (error) => error.status === 400);
  }
  assert.equal(remote.calls.length, 0);
  const traversal = board(); traversal.assets[0][1].name = "../../app.js";
  assert.ok([...(await prepareBoard(traversal)).files.keys()].every((path) => /^images\/[a-f0-9]{64}-[a-zA-Z0-9._-]+$/.test(path)));
});
test("public reading needs no credential, but writes require GitHub authentication", async () => {
  const remote = mockGitHub(), writer = storeFor(remote);
  await writer.write(null, board());
  const reader = storeFor(remote, false), record = await reader.read();
  assert.deepEqual(record.board, board());
  assert.equal(await reader.read(record.revision), null);
  await assert.rejects(reader.write(record.revision, board()), (error) => error.authentication);
  await assert.rejects(reader.connect("invalid-token"), (error) => error.authentication);
  assert.equal(reader.connected, false);
  await reader.connect("test-only-token"); assert.equal(reader.connected, true);
  reader.disconnect(); assert.equal(reader.connected, false);
});
test("an incomplete or corrupt shared original fails the whole read instead of producing a partial backup", async () => {
  const remote = mockGitHub(); await storeFor(remote).write(null, board());
  const imagePath = [...remote.files.keys()].find((path) => path.startsWith("images/"));
  remote.blobs.set(remote.files.get(imagePath), Buffer.from("not the original"));
  await assert.rejects(storeFor(remote, false).read(), /integrity check/);
});
test("public reads bypass stale branch caches and pin every original even if the branch changes mid-read", async () => {
  const remote = mockGitHub(), writer = storeFor(remote), data = board();
  const first = await writer.write(null, data);
  remote.rawBranchHead = remote.head;
  data.state.revision++;
  data.state.tabs[0].sections[0].items.push({ ...data.state.tabs[0].sections[0].items[0], id: "second-item", assetId: "second-asset", title: "second.png" });
  data.assets.push(["second-asset", { ...data.assets[0][1], name: "second.png" }]);
  const second = await writer.write(first.revision, data), snapshot = remote.head;
  const reader = createGitHubStore({ owner: "example", repo: "moodboard" }, {
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith("/git/ref/heads/board")) assert.ok(new URL(url).searchParams.has("fresh"));
      const response = await remote.fetchImpl(url, options);
      if (new URL(url).pathname.endsWith("/board.json")) {
        const empty = structuredClone(data);
        empty.state.revision++; empty.state.tabs[0].sections[0].items = []; empty.assets = [];
        await writer.write(second.revision, empty);
      }
      return response;
    }
  });
  const record = await reader.read();
  assert.equal(record.revision, second.revision);
  assert.deepEqual(record.board, data);
  assert.notEqual(remote.head, snapshot);
  assert.equal(remote.files.size, 1);
  assert.ok(remote.calls.filter((call) => call.path.startsWith("/raw/")).every((call) => call.commit === snapshot));
});
