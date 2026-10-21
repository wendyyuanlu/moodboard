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
    for (const key of ["showCaptions", "showFilenames", "showUrls"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") fail();
    if (settings.spacing !== undefined && (!Number.isInteger(settings.spacing) || settings.spacing < 0 || settings.spacing > 40)) fail();
    if (settings.couponCode !== undefined && !validCoupon(settings.couponCode)) fail();
    for (const [key, asset] of assetMap) {
      if (!text(key, 150, true) || !asset || !(asset.blob instanceof Blob) || !supportedImage.test(asset.blob.type) || !text(asset.name, 500, true) || !Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0) fail();
    }
    return data;
  }
  return Object.freeze({ supportedImage, sourcePageURL, validCrop, validCoupon, validate });
})();
if (typeof module !== "undefined") module.exports = MoodboardFormat;
