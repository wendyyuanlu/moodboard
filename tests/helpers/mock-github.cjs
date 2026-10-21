const crypto = require("node:crypto");
const gitHash = (bytes) => crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function mockGitHub() {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [], history = [];
  let head = null, rawBranchHead;
  const hash = (data) => crypto.createHash("sha1").update(JSON.stringify(data)).digest("hex");
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  function packageAt(commitId = head) {
    if (!commitId) return { revision: null, board: null };
    const files = trees.get(commits.get(commitId).tree.sha), revision = files.get("board.json");
    const manifest = JSON.parse(blobs.get(revision).toString("utf8"));
    return { revision, board: { format: "moodboard", version: 1, state: manifest.state,
      assets: manifest.assets.map(([id, asset]) => [id, { name: asset.name, width: asset.width, height: asset.height, data: `data:${asset.mime};base64,${blobs.get(asset.sha).toString("base64")}` }]) } };
  }
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.hostname === "raw.githubusercontent.com") {
      const path = parsed.pathname.split("/").slice(4).join("/");
      const commit = parsed.pathname.split("/")[3], target = commit === "board" ? rawBranchHead || head : commit;
      calls.push({ path: `/raw/${path}`, method: "GET", commit });
      const files = target ? trees.get(commits.get(target).tree.sha) : new Map();
      return files.has(path) ? new Response(blobs.get(files.get(path))) : reply({}, 404);
    }
    const path = parsed.pathname.replace("/repos/example/moodboard", "");
    const auth = options.headers?.Authorization;
    if (auth ? auth !== "Bearer test-only-token" : options.method !== "GET" || path !== "/git/ref/heads/board") return reply({}, 401);
    const data = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, data });
    if (options.method === "GET") {
      if (path === "") return reply({ permissions: { push: true } });
      if (path === "/git/ref/heads/board") return head ? reply({ object: { sha: head } }) : reply({}, 404);
      if (path.startsWith("/git/blobs/")) return reply({ content: blobs.get(path.split("/").at(-1)).toString("base64") });
      if (path.startsWith("/git/commits/")) return reply(commits.get(path.split("/").at(-1)));
      if (path.startsWith("/git/trees/")) return reply({ tree: [...trees.get(path.split("/").at(-1))].map(([path, sha]) => ({ path, sha, type: "blob" })) });
    }
    if (path === "/git/blobs") {
      const bytes = Buffer.from(data.content, "base64"), sha = gitHash(bytes);
      blobs.set(sha, bytes); return reply({ sha });
    }
    if (path === "/git/trees") {
      const tree = new Map(trees.get(data.base_tree) || []);
      for (const change of data.tree) {
        if (!(change.path === "board.json" || /^images\/[a-f0-9]{64}-[a-zA-Z0-9._-]+$/.test(change.path))) throw new Error("Unsafe file path.");
        if (change.sha === null) tree.delete(change.path); else tree.set(change.path, change.sha);
      }
      const sha = hash([...tree]); trees.set(sha, tree); return reply({ sha });
    }
    if (path === "/git/commits") {
      const sha = hash(data); commits.set(sha, { ...data, tree: { sha: data.tree } }); return reply({ sha });
    }
    if (path === "/git/refs" || path === "/git/refs/heads/board") {
      if (head && commits.get(data.sha).parents[0] !== head) return reply({}, 422);
      if (head && data.force !== false) throw new Error("Force push attempted.");
      head = data.sha; history.push(head); return reply({ object: { sha: head } });
    }
    throw new Error(`Unexpected GitHub operation: ${options.method} ${path}`);
  }
  return { fetchImpl, calls, blobs, trees, commits, history, packageAt,
    set rawBranchHead(value) { rawBranchHead = value; },
    get head() { return head; }, get files() { return head ? trees.get(commits.get(head).tree.sha) : new Map(); } };
}
module.exports = { mockGitHub, gitHash };
