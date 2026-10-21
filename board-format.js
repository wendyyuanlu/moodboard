const MoodboardFormat = (() => {
  "use strict";
  const supportedImage = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;
  function sourcePageURL(value) {
    if (typeof value !== "string" || value.length > 8192) return "";
    try {
      const url = new URL(value.trim());
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function validCrop(crop) {
    return crop && ["x", "y", "width", "height"].every((key) => Number.isFinite(crop[key]))
      && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
      && crop.x + crop.width <= 1 + 1e-10 && crop.y + crop.height <= 1 + 1e-10;
  }
  function validCoupon(value) {
    return typeof value === "string" && value.length <= 500 && !/github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/.test(value);
  }
  function validRemote(asset) {
    return asset && typeof asset.url === "string" &&
      /^https:\/\/raw\.githubusercontent\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-f0-9]{40}\/images\/[a-f0-9]{64}-[a-zA-Z0-9._-]+$/.test(asset.url) &&
      /^[a-f0-9]{40}$/.test(asset.sha) && supportedImage.test(asset.mime);
  }
  const fail = () => { throw new Error("This moodboard file is invalid or incomplete. Your current board has not been replaced."); };
  const text = (value, max, required = false) => typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
  function validateState(data, assetMap) {
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
          for (const key of ["sourceUrl", "sourceImageUrl"]) {
            if (item[key] !== undefined && (!text(item[key], 8192) || (item[key] !== "" && !sourcePageURL(item[key])))) fail();
          }
          if (item.crop !== undefined && !validCrop(item.crop)) fail();
          unique(item.id);
        }
      }
    }
    if (!data.tabs.some((tab) => tab.id === data.activeTab)) fail();
    const settings = data.settings;
    if (!settings || !["masonry", "grid", "list"].includes(settings.layout) || !["light", "dark"].includes(settings.theme) || !/^#[a-f0-9]{6}$/i.test(settings.accent) || !Number.isFinite(settings.zoom) || settings.zoom < 100 || settings.zoom > 420) fail();
    for (const key of ["showCaptions", "showFilenames", "showUrls", "showAddImages"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") fail();
    if (settings.spacing !== undefined && (!Number.isInteger(settings.spacing) || settings.spacing < 0 || settings.spacing > 40)) fail();
    if (settings.couponCode !== undefined && !validCoupon(settings.couponCode)) fail();
    return data;
  }
  function validate(data, assetMap) {
    validateState(data, assetMap);
    for (const [key, asset] of assetMap) {
      if (!text(key, 150, true) || !asset || (asset.blob instanceof Blob ? !supportedImage.test(asset.blob.type) : !validRemote(asset.remote)) || !text(asset.name, 500, true) || !Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0) fail();
    }
    return data;
  }
  function mergeStates(base, local, remote) {
    if (!base || base.id !== local.id || base.id !== remote.id) return null;
    const missing = Symbol("missing"), conflict = Symbol("conflict");
    const equal = (a, b) => a === b || (a !== missing && b !== missing && JSON.stringify(a) === JSON.stringify(b));
    const copy = value => value === missing ? missing : structuredClone(value);
    const object = value => value && typeof value === "object" && !Array.isArray(value);
    const viewSettings = new Set(["layout", "zoom", "spacing", "theme", "accent", "showCaptions", "showFilenames", "showUrls", "showAddImages"]);
    const emptyTab = tab => object(tab) && Array.isArray(tab.sections) && tab.sections.every(section => !section.items.length);
    const merge = (before, ours, theirs, path) => {
      if (equal(ours, before)) return copy(theirs);
      if (equal(theirs, before) || equal(ours, theirs)) return copy(ours);
      if ((path.length === 2 && path[0] === "settings" && viewSettings.has(path[1])) || path.at(-1) === "collapsed") return copy(ours);
      if (ours === missing || theirs === missing || path.at(-1) === "crop") return conflict;
      if (Array.isArray(before) && Array.isArray(ours) && Array.isArray(theirs)) {
        if (![...before, ...ours, ...theirs].every(entry => object(entry) && typeof entry.id === "string")) return conflict;
        const old = new Map(before.map(entry => [entry.id, entry])), left = new Map(ours.map(entry => [entry.id, entry])), right = new Map(theirs.map(entry => [entry.id, entry]));
        const merged = new Map();
        for (const id of new Set([...old.keys(), ...left.keys(), ...right.keys()])) {
          if (path.at(-1) === "tabs" && old.has(id) && emptyTab(old.get(id)) &&
            ((!left.has(id) && right.has(id) && emptyTab(right.get(id))) || (!right.has(id) && left.has(id) && emptyTab(left.get(id))))) continue;
          const entry = merge(old.get(id) ?? missing, left.get(id) ?? missing, right.get(id) ?? missing, [...path, id]);
          if (entry === conflict) return conflict;
          if (entry !== missing) merged.set(id, entry);
        }
        const common = new Set(before.filter(entry => merged.has(entry.id) && left.has(entry.id) && right.has(entry.id)).map(entry => entry.id));
        const order = entries => entries.filter(entry => common.has(entry.id)).map(entry => entry.id);
        const baseOrder = order(before), localOrder = order(ours), remoteOrder = order(theirs);
        const localMoved = !equal(baseOrder, localOrder), remoteMoved = !equal(baseOrder, remoteOrder);
        if (localMoved && remoteMoved && !equal(localOrder, remoteOrder)) return conflict;
        const primary = localMoved ? ours : theirs, secondary = localMoved ? theirs : ours;
        const ids = primary.filter(entry => merged.has(entry.id)).map(entry => entry.id);
        for (const [index, entry] of secondary.entries()) {
          if (!merged.has(entry.id) || ids.includes(entry.id)) continue;
          const following = secondary.slice(index + 1).find(next => ids.includes(next.id));
          ids.splice(following ? ids.indexOf(following.id) : ids.length, 0, entry.id);
        }
        return ids.map(id => merged.get(id));
      }
      if (object(ours) && object(theirs) && (object(before) || before === missing)) {
        const result = {}, old = before === missing ? {} : before;
        for (const key of new Set([...Object.keys(old), ...Object.keys(ours), ...Object.keys(theirs)])) {
          const value = merge(Object.hasOwn(old, key) ? old[key] : missing, Object.hasOwn(ours, key) ? ours[key] : missing, Object.hasOwn(theirs, key) ? theirs[key] : missing, [...path, key]);
          if (value === conflict) return conflict;
          if (value !== missing) result[key] = value;
        }
        return result;
      }
      return conflict;
    };
    const normalized = value => ({ ...value, revision: 0, activeTab: base.activeTab });
    const result = merge(normalized(base), normalized(local), normalized(remote), []);
    if (result === conflict || !result.tabs.length) return null;
    const ids = result.tabs.flatMap(tab => [tab.id, ...tab.sections.flatMap(section => [section.id, ...section.items.map(item => item.id)])]);
    if (new Set(ids).size !== ids.length) return null;
    result.activeTab = result.tabs.some(tab => tab.id === local.activeTab) ? local.activeTab
      : result.tabs.some(tab => tab.id === remote.activeTab) ? remote.activeTab : result.tabs[0].id;
    result.revision = Math.max(local.revision, remote.revision) + 1;
    return result;
  }
  return Object.freeze({ supportedImage, sourcePageURL, validCrop, validCoupon, validRemote, validateState, validate, mergeStates });
})();
if (typeof module !== "undefined") module.exports = MoodboardFormat;
