const MoodboardGitHub = (() => {
  "use strict";
  const format = typeof module !== "undefined" ? require("./board-format.js") : MoodboardFormat;
  const encoder = new TextEncoder();
  class SaveError extends Error {
    constructor(status, message) {
      super(message); this.status = status;
      this.conflict = status === 409;
      this.authentication = status === 401 || status === 403;
    }
  }
  const bytesFromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }
  async function hash(algorithm, bytes) {
    return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  async function gitHash(bytes) {
    const header = encoder.encode(`blob ${bytes.length}\0`), data = new Uint8Array(header.length + bytes.length);
    data.set(header); data.set(bytes, header.length); return hash("SHA-1", data);
  }
  function imageSignature(bytes, mime) {
    const head = bytes.subarray(0, 64), text = new TextDecoder("ascii").decode(head);
    if (mime === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => head[index] === value);
    if (mime === "image/jpeg") return head[0] === 255 && head[1] === 216 && head[2] === 255;
    if (mime === "image/gif") return /^GIF8[79]a/.test(text);
    if (mime === "image/webp") return text.slice(0, 4) === "RIFF" && text.slice(8, 12) === "WEBP";
    if (mime === "image/avif") return text.slice(4, 8) === "ftyp" && /avif|avis/.test(text.slice(8));
    if (mime === "image/bmp") return text.startsWith("BM");
    return [0, 0, 1, 0].every((value, index) => head[index] === value);
  }
  async function prepareBoard(board) {
    if (!board || board.format !== "moodboard" || board.version !== 1 || !Array.isArray(board.assets)) throw new SaveError(400, "Invalid moodboard package.");
    const assets = new Map(), files = new Map(), records = [];
    for (const entry of board.assets) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new SaveError(400, "Invalid image entry.");
      const [id, asset] = entry;
      if (!asset || assets.has(id) || typeof asset.data !== "string") throw new SaveError(400, "Invalid or duplicate image.");
      const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.data);
      if (!match || !format.supportedImage.test(match[1])) throw new SaveError(400, "Use supported raster images only.");
      const mime = match[1].toLowerCase(), bytes = bytesFromBase64(match[2]);
      if (base64(bytes) !== match[2] || !imageSignature(bytes, mime)) throw new SaveError(400, "Image bytes do not match the declared format.");
      if (bytes.length > 100 * 1024 * 1024) throw new SaveError(413, "GitHub does not accept image files larger than 100 MiB. Your local original is unchanged.");
      assets.set(id, { ...asset, blob: new Blob([bytes], { type: mime }) });
      const filename = String(asset.name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "image";
      const path = `images/${await hash("SHA-256", bytes)}-${filename}`, sha = await gitHash(bytes);
      files.set(path, { bytes, sha });
      records.push([id, { name: asset.name, width: asset.width, height: asset.height, mime, path, sha }]);
    }
    try { format.validate(board.state, assets); } catch (error) { throw new SaveError(400, error.message); }
    const referenced = new Set(board.state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => item.assetId))));
    if (referenced.size !== assets.size) throw new SaveError(400, "Remove unreferenced images before uploading.");
    const manifest = { format: "moodboard-github", version: 1, state: board.state, assets: records };
    const bytes = encoder.encode(JSON.stringify(manifest));
    return { manifest, bytes, revision: await gitHash(bytes), files };
  }
  function createGitHubStore({ owner, repo, branch = "board" }, { fetchImpl = fetch, initialToken = "" } = {}) {
    if (![owner, repo, branch].every((value) => /^[a-zA-Z0-9._-]+$/.test(value))) throw new Error("Invalid GitHub repository configuration.");
    const root = `https://api.github.com/repos/${owner}/${repo}`;
    const raw = (commit) => `https://raw.githubusercontent.com/${owner}/${repo}/${commit}`;
    let token = initialToken, operations = Promise.resolve();
    async function api(path, method = "GET", body) {
      const fresh = path === `/git/ref/heads/${branch}` ? `?fresh=${Date.now()}` : "";
      const response = await fetchImpl(`${root}${path}${fresh}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000), cache: "no-store", credentials: "omit"
      });
      if (response.status === 404 && method === "GET") return null;
      if (!response.ok) {
        const limited = response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0";
        if (response.status === 401) token = "";
        throw new SaveError(limited ? 429 : response.status === 409 || response.status === 422 ? 409 : response.status,
          limited ? "GitHub's rate limit was reached. Your local changes are safe; retry later."
            : `GitHub did not accept this operation (${response.status}). Check your repository access or resolve a newer shared save in Settings.`);
      }
      return response.json();
    }
    function checkManifest(manifest) {
      if (!manifest || manifest.format !== "moodboard-github" || manifest.version !== 1 || !Array.isArray(manifest.assets)) throw new SaveError(502, "The shared board manifest is invalid.");
      for (const entry of manifest.assets) {
        const asset = Array.isArray(entry) && entry[1];
        if (!asset || !/^images\/[a-f0-9]{64}-[a-zA-Z0-9._-]+$/.test(asset.path) || !/^[a-f0-9]{40}$/.test(asset.sha) || !format.supportedImage.test(asset.mime)) throw new SaveError(502, "The shared board contains an invalid image record.");
      }
      const ids = new Set(manifest.assets.map(([id]) => id));
      if (ids.size !== manifest.assets.length) throw new SaveError(502, "The shared board contains duplicate original records.");
      format.validateState(manifest.state, ids);
    }
    async function loadMeta() {
      const ref = await api(`/git/ref/heads/${branch}`);
      if (!ref) return { revision: null, manifest: null, head: null, tree: null, paths: new Map() };
      const commit = await api(`/git/commits/${ref.object.sha}`);
      const tree = await api(`/git/trees/${commit.tree.sha}`);
      const entry = tree.tree.find((entry) => entry.path === "board.json" && entry.type === "blob");
      if (!entry) throw new SaveError(502, "The board branch has no board.json. Restore it from Git history before saving.");
      const blob = await api(`/git/blobs/${entry.sha}`);
      const manifest = JSON.parse(new TextDecoder().decode(bytesFromBase64(blob.content.replace(/\s/g, ""))));
      checkManifest(manifest);
      return { revision: entry.sha, manifest, head: ref.object.sha, tree: commit.tree.sha, paths: new Map(manifest.assets.map(([, asset]) => [asset.path, asset.sha])) };
    }
    async function read(knownRevision, cachedAssets) {
      let record;
      if (token) record = await loadMeta();
      else {
        const ref = await api(`/git/ref/heads/${branch}`);
        if (!ref) return { revision: null, board: null };
        const commit = ref.object.sha;
        const response = await fetchImpl(`${raw(commit)}/board.json`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new SaveError(response.status, `Could not read the shared GitHub board (${response.status}). Your cached images are unchanged.`);
        const bytes = new Uint8Array(await response.arrayBuffer()), manifest = JSON.parse(new TextDecoder().decode(bytes));
        checkManifest(manifest); record = { revision: await gitHash(bytes), manifest, head: commit };
      }
      if (!record.manifest) return { revision: null, board: null };
      if (record.revision === knownRevision) return null;
      if (cachedAssets) {
        const entries = [];
        for (const [id, asset] of record.manifest.assets) {
          const cached = cachedAssets.get(id);
          const reusable = cached?.blob instanceof Blob && (cached.remote?.sha === asset.sha || await gitHash(new Uint8Array(await cached.blob.arrayBuffer())) === asset.sha);
          entries.push([id, { name: asset.name, width: asset.width, height: asset.height,
            ...(reusable ? { blob: cached.blob } : {}), remote: { url: `${raw(record.head)}/${asset.path}`, sha: asset.sha, mime: asset.mime } }]);
        }
        format.validate(record.manifest.state, new Map(entries));
        return { revision: record.revision, board: { format: "moodboard", version: 1, state: record.manifest.state, assets: entries } };
      }
      const assets = [];
      for (const [id, asset] of record.manifest.assets) {
        let bytes;
        if (token) {
          const image = await api(`/git/blobs/${asset.sha}`);
          if (!image) throw new SaveError(502, "A shared original image is missing. Export your cached backup before reloading.");
          bytes = bytesFromBase64(image.content.replace(/\s/g, ""));
        } else {
          const response = await fetchImpl(`${raw(record.head)}/${asset.path}`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new SaveError(response.status, `Could not load the full original “${asset.name}”. The shared board has not been installed.`);
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (await gitHash(bytes) !== asset.sha) throw new SaveError(502, "A shared original failed its integrity check.");
        assets.push([id, { name: asset.name, width: asset.width, height: asset.height, data: `data:${asset.mime};base64,${base64(bytes)}` }]);
      }
      const board = { format: "moodboard", version: 1, state: record.manifest.state, assets };
      await prepareBoard(board);
      return { revision: record.revision, board };
    }
    async function write(expectedRevision, board) {
      if (!token) throw new SaveError(401, "Enable auto-sync in Settings to upload this device's pending edits.");
      const prepared = await prepareBoard(board), current = await loadMeta();
      if (prepared.revision === current.revision) return { revision: current.revision };
      if (expectedRevision !== current.revision) throw new SaveError(409, "Someone else saved a newer shared board. Your local changes are safe. Resolve the conflict in Settings.");
      const changes = [];
      for (const [path, file] of prepared.files) {
        if (current.paths.get(path) === file.sha) continue;
        const uploaded = await api("/git/blobs", "POST", { content: base64(file.bytes), encoding: "base64" });
        if (uploaded.sha !== file.sha) throw new SaveError(502, "GitHub returned an unexpected image checksum.");
        changes.push({ path, mode: "100644", type: "blob", sha: uploaded.sha });
      }
      for (const path of current.paths.keys()) if (!prepared.files.has(path)) changes.push({ path, mode: "100644", type: "blob", sha: null });
      const manifest = await api("/git/blobs", "POST", { content: base64(prepared.bytes), encoding: "base64" });
      if (manifest.sha !== prepared.revision) throw new SaveError(502, "GitHub returned an unexpected board checksum.");
      changes.push({ path: "board.json", mode: "100644", type: "blob", sha: manifest.sha });
      const tree = await api("/git/trees", "POST", { ...(current.tree ? { base_tree: current.tree } : {}), tree: changes });
      const count = board.state.tabs.reduce((sum, tab) => sum + tab.sections.reduce((sum, section) => sum + section.items.length, 0), 0);
      const commit = await api("/git/commits", "POST", { message: `Save shared moodboard (${count} images)\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
        tree: tree.sha, parents: current.head ? [current.head] : [] });
      if (current.head) await api(`/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: false });
      else await api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
      return { revision: manifest.sha };
    }
    async function readState(revision) {
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new SaveError(400, "Invalid shared board baseline revision.");
      const blob = await api(`/git/blobs/${revision}`);
      if (!blob) throw new SaveError(502, "The original shared revision is unavailable. Export a backup before resolving this conflict.");
      const manifest = JSON.parse(new TextDecoder().decode(bytesFromBase64(blob.content.replace(/\s/g, ""))));
      checkManifest(manifest);
      format.validateState(manifest.state, new Set(manifest.assets.map(([id]) => id)));
      return manifest.state;
    }
    async function readOriginal(remote) {
      if (!format.validRemote(remote) || !remote.url.startsWith(raw(""))) throw new SaveError(400, "Invalid original image location.");
      const response = await fetchImpl(remote.url, { cache: "force-cache", credentials: "omit", signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new SaveError(response.status, `Could not cache a full original (${response.status}). Stay online and retry before your flight.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await gitHash(bytes) !== remote.sha || !imageSignature(bytes, remote.mime)) throw new SaveError(502, "A shared original failed its integrity check.");
      return new Blob([bytes], { type: remote.mime });
    }
    const serialize = (action) => {
      const result = operations.then(action); operations = result.catch(() => {}); return result;
    };
    return {
      get connected() { return Boolean(token); },
      connect: async (nextToken) => {
        token = nextToken.trim();
        try {
          if (!token) throw new SaveError(401, "Enter a repository-scoped GitHub access token.");
          const repository = await api("");
          if (!repository?.permissions?.push) throw new SaveError(403, "This GitHub account/token does not have write access to the moodboard repository.");
        } catch (error) { token = ""; throw error; }
      },
      disconnect: () => { token = ""; },
      read: (knownRevision) => serialize(() => read(knownRevision)),
      readCached: (knownRevision, cachedAssets) => serialize(() => read(knownRevision, cachedAssets)),
      readOriginal,
      readState: (revision) => serialize(() => readState(revision)),
      write: (expectedRevision, board) => serialize(() => write(expectedRevision, board))
    };
  }
  return Object.freeze({ createGitHubStore, prepareBoard, gitHash, SaveError });
})();
if (typeof module !== "undefined") module.exports = MoodboardGitHub;
