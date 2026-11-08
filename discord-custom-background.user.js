// ==UserScript==
// @name         Discord Custom Background
// @namespace    http://tampermonkey.net/
// @version      5.0.1
// @author       GameHunt7062
// @license      MIT
// @homepageURL  https://github.com/GameHunt7062/Discord-Custom-Background
// @supportURL   https://github.com/GameHunt7062/Discord-Custom-Background/issues
// @downloadURL  https://raw.githubusercontent.com/GameHunt7062/Discord-Custom-Background/main/discord-custom-background.user.js
// @updateURL    https://raw.githubusercontent.com/GameHunt7062/Discord-Custom-Background/main/discord-custom-background.user.js
// @description  Image/GIF/video backgrounds for Discord with uniform panel opacity, a saved library, drag & drop, zoom and rotation. Performance-tuned.
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*!
 * Discord Custom Background
 * Copyright (c) 2026 GameHunt7062
 * Released under the MIT License.
 * https://github.com/GameHunt7062/Discord-Custom-Background
 *
 * Not affiliated with or endorsed by Discord Inc.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Config
   * ------------------------------------------------------------------ */
  const APP_NAME = "Discord Custom Background";
  const VERSION = "5.0.1";
  const AUTHOR = "GameHunt7062";
  const REPO_URL = "https://github.com/GameHunt7062/Discord-Custom-Background";

  const NS = "cbg";
  const STYLE_ID = `${NS}-style`;
  const UI_STYLE_ID = `${NS}-ui-style`;
  const LAYER_ID = `${NS}-layer`;
  const UI_ID = `${NS}-ui`;
  const CLEAR_ATTR = "data-cbg-clear";
  const DB_NAME = `${NS}-db`;
  const DB_VERSION = 3;
  const KV = "kv"; // legacy single-file storage (v1)
  const LIB = "library"; // small metadata records only
  const BLOBS = "blobs"; // the actual files, kept apart so metadata edits never rewrite them
  const LEGACY_KEY = "media";
  const SETTINGS_KEY = `${NS}-settings`;
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file
  const HOTKEY = { ctrl: true, shift: true, key: "B" }; // Ctrl+Shift+B toggles the panel

  const DEFAULTS = {
    opacity: 0.45, // darkness of the single overlay shared by ALL panels
    blur: 0,
    dim: 0.1,
    rotate: 0,
    zoom: 1,
    uniform: true, // same opacity on every panel
    freeze: false, // stop GIF/video animation (big CPU/GPU saver)
    activeId: null,
    tab: "library",
  };

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  let settings = loadSettings();
  let objectUrl = null;
  let currentBlob = null; // original file currently shown
  let hasMedia = false;
  let library = []; // metadata only, newest first
  let ui = {};
  let mountToken = 0;
  let activateToken = 0;

  /* ------------------------------------------------------------------ *
   *  Helpers
   * ------------------------------------------------------------------ */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function fmtSize(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  function h(tag, props = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    children.flat().forEach((c) => c && n.append(c));
    return n;
  }

  const idle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 1500 })
    : (fn) => setTimeout(fn, 0);

  const isLight = () => document.documentElement.classList.contains("theme-light");

  /* ------------------------------------------------------------------ *
   *  Settings (small -> localStorage)
   * ------------------------------------------------------------------ */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn("[CustomBG] could not save settings", e);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Storage (IndexedDB). Metadata and file data live in separate stores,
   *  so renaming / zoom / rotation only write a few bytes instead of
   *  re-saving a whole 50 MB file.
   * ------------------------------------------------------------------ */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(LIB)) db.createObjectStore(LIB, { keyPath: "id" });
        const blobs = db.objectStoreNames.contains(BLOBS) ? tx.objectStore(BLOBS) : db.createObjectStore(BLOBS);
        if (ev.oldVersion === 2) {
          // v2 stored the file inside each library record -> move it to its own store
          tx.objectStore(LIB).openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            if (rec.blob) {
              blobs.put(rec.blob, rec.id);
              delete rec.blob;
              cursor.update(rec);
            }
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbOp(store, mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const kvGet = (k) => dbOp(KV, "readonly", (s) => s.get(k));
  const kvDel = (k) => dbOp(KV, "readwrite", (s) => s.delete(k));
  const libAll = () => dbOp(LIB, "readonly", (s) => s.getAll());
  const libPut = (meta) => dbOp(LIB, "readwrite", (s) => s.put(meta));
  const libDel = (id) => dbOp(LIB, "readwrite", (s) => s.delete(id));
  const blobGet = (id) => dbOp(BLOBS, "readonly", (s) => s.get(id));
  const blobPut = (id, blob) => dbOp(BLOBS, "readwrite", (s) => s.put(blob, id));
  const blobDel = (id) => dbOp(BLOBS, "readwrite", (s) => s.delete(id));

  /* ------------------------------------------------------------------ *
   *  Thumbnails / frozen frames
   * ------------------------------------------------------------------ */
  async function makeThumb(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const isVideo = blob.type.startsWith("video/");
      const media = await Promise.race([
        new Promise((resolve, reject) => {
          const m = document.createElement(isVideo ? "video" : "img");
          m.onerror = () => reject(new Error("thumbnail load failed"));
          if (isVideo) {
            m.muted = true;
            m.preload = "auto";
            m.onloadeddata = () => {
              m.currentTime = Math.min(0.1, m.duration || 0);
            };
            m.onseeked = () => resolve(m);
          } else {
            m.onload = () => resolve(m);
          }
          m.src = url;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("thumbnail timeout")), 6000)),
      ]);
      const w = isVideo ? media.videoWidth : media.naturalWidth;
      const hgt = isVideo ? media.videoHeight : media.naturalHeight;
      if (!w || !hgt) return null;
      const k = 220 / Math.max(w, hgt);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(hgt * k));
      canvas.getContext("2d").drawImage(media, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.75);
    } catch (e) {
      console.warn("[CustomBG] no thumbnail:", e.message);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // First frame of an image/GIF as a static JPEG (used by "Freeze animation")
  async function snapshotBlob(blob) {
    const bmp = await createImageBitmap(blob);
    try {
      const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * k));
      canvas.height = Math.max(1, Math.round(bmp.height * k));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("snapshot failed"))), "image/jpeg", 0.92)
      );
    } finally {
      bmp.close();
    }
  }

  /* ------------------------------------------------------------------ *
   *  Discord CSS
   *
   *  Uniform opacity: every Discord panel background is made transparent
   *  and ONE tint overlay sits on the image, so all panels look identical.
   *
   *  Performance notes:
   *   - per-frame/per-slider values live on the layer element, not :root,
   *     so changing them never restyles Discord's whole DOM
   *   - no CSS filter unless blur is on (filters on animated content are
   *     very expensive); "dim" is just part of the overlay gradient
   *   - no substring attribute selectors across Discord's DOM
   * ------------------------------------------------------------------ */
  function buildCSS() {
    return `
      html, body { background: transparent !important; }

      #${LAYER_ID} {
        position: fixed; inset: 0; z-index: 0; pointer-events: none;
        overflow: hidden; background: #000; contain: strict;
      }
      #${LAYER_ID} > img, #${LAYER_ID} > video {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; display: block;
        filter: var(--${NS}-filter, none);
        transform: var(--${NS}-transform, none);
        will-change: transform;
      }
      #${LAYER_ID}::after {
        content: ""; position: absolute; inset: 0;
        background:
          linear-gradient(rgb(0 0 0 / var(--${NS}-dim, 0)), rgb(0 0 0 / var(--${NS}-dim, 0))),
          rgb(var(--${NS}-tint, 0 0 0) / var(--${NS}-overlay, 0));
      }

      #app-mount { position: relative; z-index: 1; background: transparent !important; }

      /* Containers cleared by the panel scanner */
      [${CLEAR_ATTR}] { background: transparent !important; background-image: none !important; }

      :root, .theme-dark, .theme-light, .theme-darker, .theme-midnight,
      .visual-refresh, .visual-refresh .theme-dark {
        /* the four main panels + their wrappers */
        --background-primary: var(--${NS}-p) !important;
        --background-secondary: var(--${NS}-p) !important;
        --background-secondary-alt: var(--${NS}-p) !important;
        --background-tertiary: var(--${NS}-p) !important;
        --chat-background: transparent !important;
        --chat-background-default: transparent !important;
        --background-base-lowest: var(--${NS}-p) !important;
        --background-base-lower: var(--${NS}-p) !important;
        --background-base-low: var(--${NS}-p) !important;
        --bg-base-primary: var(--${NS}-p) !important;
        --bg-base-secondary: var(--${NS}-p) !important;
        --bg-base-tertiary: var(--${NS}-p) !important;
        --bg-overlay-1: var(--${NS}-p) !important;
        --bg-overlay-2: var(--${NS}-p) !important;
        --bg-overlay-3: var(--${NS}-p) !important;
        --bg-overlay-chat: transparent !important;
        --bg-overlay-app-frame: transparent !important;

        /* small surfaces that must stay readable (inputs, cards) */
        --background-accent: var(--${NS}-card) !important;
        --channeltextarea-background: var(--${NS}-card) !important;
        --background-surface-high: var(--${NS}-card) !important;
        --background-surface-higher: var(--${NS}-card) !important;
        --background-surface-highest: var(--${NS}-card) !important;
        --bg-surface-overlay: var(--${NS}-card) !important;

        /* popouts / modals stay opaque */
        --background-floating: rgb(20 20 20 / 0.95) !important;
        --background-nested-floating: rgb(20 20 20 / 0.95) !important;
      }
    `;
  }

  // Root vars: only change on theme / uniform toggle, so they restyle rarely.
  function applyRootVars() {
    const s = document.documentElement.style;
    const tint = isLight() ? "255 255 255" : "0 0 0";
    const p = settings.uniform ? "transparent" : `rgb(${tint} / ${settings.opacity})`;
    const card = `rgb(${tint} / 0.55)`;
    if (s.getPropertyValue(`--${NS}-p`) !== p) s.setProperty(`--${NS}-p`, p);
    if (s.getPropertyValue(`--${NS}-card`) !== card) s.setProperty(`--${NS}-card`, card);
  }

  // Layer vars: live on the layer element only (cheap to change, e.g. while dragging sliders).
  function applyLayerVars() {
    const layer = document.getElementById(LAYER_ID);
    if (!layer) return;
    const s = layer.style;
    s.setProperty(`--${NS}-tint`, isLight() ? "255 255 255" : "0 0 0");
    s.setProperty(`--${NS}-overlay`, String(settings.uniform ? settings.opacity : 0));
    s.setProperty(`--${NS}-dim`, String(settings.dim));
    s.setProperty(`--${NS}-filter`, settings.blur > 0 ? `blur(${settings.blur}px)` : "none");

    // Rotation: scale up just enough that the rotated image still covers the screen
    const rad = ((settings.rotate % 180) * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    const W = window.innerWidth || 1;
    const H = window.innerHeight || 1;
    const cover = Math.max(c + (H / W) * sn, c + (W / H) * sn);
    const scale = cover * settings.zoom * (settings.blur > 0 ? 1.05 : 1); // 1.05 hides blur edge bleed
    const needsTransform = settings.rotate !== 0 || settings.zoom !== 1 || settings.blur > 0;
    s.setProperty(`--${NS}-transform`, needsTransform ? `rotate(${settings.rotate}deg) scale(${scale.toFixed(4)})` : "none");
  }

  // Coalesces bursts (slider drags, resize) into one update per frame
  let applyQueued = false;
  function scheduleApply({ root = false } = {}) {
    if (root) applyRootVars();
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      applyLayerVars();
    });
  }

  function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = buildCSS();
      (document.head || document.documentElement).appendChild(st);
    }
    applyRootVars();
  }

  /* ------------------------------------------------------------------ *
   *  Panel scanner: finds tall containers that still paint their own
   *  background and clears them, so every panel ends up identical.
   *
   *  Cheap by design: runs only on clicks / route changes / resize
   *  (never on every DOM mutation), reads layout in one pass, then writes
   *  all attributes in one batch (no layout thrashing), skips huge lists.
   * ------------------------------------------------------------------ */
  const SKIP_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "SVG", "INPUT", "TEXTAREA", "BUTTON", "SCRIPT", "STYLE", "IFRAME"]);
  const SKIP_SEL =
    '[role="dialog"],[role="menu"],[role="tooltip"],[role="listbox"],' +
    '[class*="layerContainer_"],[class*="popout_"],[class*="modal_"],[class*="tooltip_"]';
  const MAX_DEPTH = 14;
  const MAX_CHILDREN = 60; // message lists / member lists: don't walk their rows
  const MAX_VISITS = 1500;

  function hasPaint(cs) {
    const bg = cs.backgroundColor;
    const none = bg === "transparent" || bg === "rgba(0, 0, 0, 0)";
    return !none || cs.backgroundImage !== "none";
  }

  function scanPanels() {
    if (!hasMedia || !settings.uniform || document.hidden) return;
    const root = document.getElementById("app-mount");
    if (!root) return;

    const minH = window.innerHeight * 0.4;
    const found = [];
    const stack = [[root, 0]];
    let visits = 0;

    while (stack.length && visits < MAX_VISITS) {
      const [node, depth] = stack.pop();
      const kids = node.children;
      if (kids.length > MAX_CHILDREN) continue;
      for (const child of kids) {
        visits++;
        if (SKIP_TAGS.has(child.tagName.toUpperCase())) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          if (depth < MAX_DEPTH && getComputedStyle(child).display === "contents") stack.push([child, depth + 1]);
          continue;
        }
        if (rect.height < minH || rect.width < 40) continue; // only tall containers are panels
        if (child.matches(SKIP_SEL)) continue;
        if (!child.hasAttribute(CLEAR_ATTR) && hasPaint(getComputedStyle(child))) found.push(child);
        if (depth < MAX_DEPTH) stack.push([child, depth + 1]);
      }
    }
    for (const n of found) n.setAttribute(CLEAR_ATTR, ""); // one batched write
  }

  function unmarkAll() {
    document.querySelectorAll(`[${CLEAR_ATTR}]`).forEach((n) => n.removeAttribute(CLEAR_ATTR));
  }

  let scanTimer = null;
  let lastScan = 0;
  function scheduleScan(delay = 600) {
    if (scanTimer || !hasMedia || !settings.uniform) return;
    const wait = Math.max(delay, lastScan + 1500 - Date.now()); // at most one scan per 1.5 s
    scanTimer = setTimeout(() => {
      scanTimer = null;
      idle(() => {
        lastScan = Date.now();
        scanPanels();
      });
    }, wait);
  }

  /* ------------------------------------------------------------------ *
   *  Background layer
   * ------------------------------------------------------------------ */
  function clearLayer() {
    document.getElementById(LAYER_ID)?.remove();
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  async function mountMedia(blob) {
    const token = ++mountToken;
    clearLayer();
    currentBlob = blob;

    const isVideo = blob.type.startsWith("video/");
    let display = blob;
    if (!isVideo && settings.freeze) {
      try {
        display = await snapshotBlob(blob);
      } catch (e) {
        console.warn("[CustomBG] could not freeze image, showing animated", e);
      }
    }
    if (token !== mountToken) return; // a newer mount/disable superseded this one

    objectUrl = URL.createObjectURL(display);
    const m = document.createElement(isVideo ? "video" : "img");
    if (isVideo) {
      m.muted = true;
      m.loop = true;
      m.playsInline = true;
      m.disablePictureInPicture = true;
      m.disableRemotePlayback = true;
      m.setAttribute("muted", "");
      if (settings.freeze) {
        m.addEventListener("loadeddata", () => {
          m.pause();
          m.currentTime = Math.min(0.1, m.duration || 0);
        }, { once: true });
      } else {
        m.autoplay = true;
      }
    } else {
      m.alt = "";
      m.decoding = "async";
    }
    m.onerror = () => {
      // blob: may be blocked by CSP on some builds -> fall back to a data: URL
      if (m.dataset.fallback) return console.error("[CustomBG] media failed to load");
      m.dataset.fallback = "1";
      const fr = new FileReader();
      fr.onload = () => (m.src = fr.result);
      fr.readAsDataURL(display);
    };
    m.src = objectUrl;

    document.body.insertBefore(h("div", { id: LAYER_ID }, m), document.body.firstChild);
    applyLayerVars();
    if (isVideo && !settings.freeze) m.play().catch(() => {});
  }

  async function showBlob(blob) {
    hasMedia = true;
    ensureStyle();
    await mountMedia(blob);
    updateUI();
    scheduleScan(100);
    setTimeout(() => scheduleScan(0), 2500); // catch panels that render late
  }

  // Don't burn CPU/GPU on a video nobody can see
  function syncPlayback() {
    const v = document.querySelector(`#${LAYER_ID} video`);
    if (!v || settings.freeze) return;
    if (document.hidden) v.pause();
    else v.play().catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   *  Library actions
   * ------------------------------------------------------------------ */
  async function refreshLibrary() {
    try {
      library = (await libAll()).sort((a, b) => b.added - a.added);
    } catch (e) {
      console.warn("[CustomBG] could not read library", e);
      library = [];
    }
    renderLibrary();
  }

  // Per-item zoom/rotation: writes a tiny metadata record, never the file
  let adjustTimer;
  function persistAdjust() {
    clearTimeout(adjustTimer);
    adjustTimer = setTimeout(async () => {
      const item = library.find((i) => i.id === settings.activeId);
      if (!item) return;
      item.zoom = settings.zoom;
      item.rotate = settings.rotate;
      try {
        await libPut(item);
      } catch (e) {
        console.warn("[CustomBG] could not save adjustments", e);
      }
    }, 400);
  }

  async function activate(item, { fresh = false, blob = null } = {}) {
    const token = ++activateToken;
    let data = blob;
    if (!data) {
      try {
        data = await blobGet(item.id);
      } catch (e) {
        console.warn("[CustomBG] could not read file", e);
      }
    }
    if (token !== activateToken) return; // user clicked something else meanwhile

    if (!(data instanceof Blob)) {
      notify("That file's data is missing, removing it from the library.", true);
      library = library.filter((i) => i.id !== item.id);
      libDel(item.id).catch(() => {});
      if (settings.activeId === item.id) settings.activeId = null;
      saveSettings();
      renderLibrary();
      return;
    }

    settings.activeId = item.id;
    ui.zoomRow?.set(fresh ? 1 : item.zoom ?? 1, true);
    ui.rotRow?.set(fresh ? 0 : item.rotate ?? 0, true);
    await showBlob(data);
    saveSettings();
    renderLibrary();
  }

  function disableBackground(silent = false) {
    activateToken++;
    mountToken++;
    hasMedia = false;
    currentBlob = null;
    settings.activeId = null;
    clearLayer();
    unmarkAll();
    document.getElementById(STYLE_ID)?.remove();
    saveSettings();
    updateUI();
    renderLibrary();
    if (!silent) notify("Background turned off. Your files are still in the library.");
  }

  async function addToLibrary(file) {
    const dup = library.find((i) => i.name === file.name && i.size === file.size && i.type === file.type);
    if (dup) return { item: dup, isNew: false };
    const meta = {
      id: uid(),
      name: file.name || "Untitled",
      type: file.type,
      size: file.size,
      added: Date.now(),
      zoom: 1,
      rotate: 0,
      thumb: await makeThumb(file),
    };
    await blobPut(meta.id, file);
    try {
      await libPut(meta);
    } catch (e) {
      blobDel(meta.id).catch(() => {});
      throw e;
    }
    library.unshift(meta);
    return { item: meta, isNew: true };
  }

  async function setBackground(file) {
    if (!file) return;
    if (!/^(image|video)\//.test(file.type)) return notify("Unsupported file type.", true);
    if (file.size > MAX_BYTES) return notify("File too large (max 100 MB).", true);

    let added;
    try {
      added = await addToLibrary(file);
    } catch (e) {
      console.error("[CustomBG] save failed", e);
      settings.activeId = null; // apply for this session only
      ui.zoomRow?.set(1, true);
      ui.rotRow?.set(0, true);
      await showBlob(file);
      renderLibrary();
      return notify("Applied, but could not save to library (storage blocked or full).", true);
    }

    await activate(added.item, { fresh: added.isNew, blob: file });
    openPanel();
    if (added.isNew) {
      showTab("adjust");
      notify("Saved and applied. Adjust zoom and rotation here.");
    } else {
      notify("Already in your library, applied.");
    }
  }

  async function deleteItem(id) {
    const item = library.find((i) => i.id === id);
    if (!item || !confirm(`Delete "${item.name}" from your library?`)) return;
    if (settings.activeId === id) disableBackground(true);
    try {
      await Promise.all([libDel(id), blobDel(id)]);
    } catch (e) {
      console.warn("[CustomBG] delete failed", e);
      return notify("Could not delete that file.", true);
    }
    library = library.filter((i) => i.id !== id);
    renderLibrary();
    notify("Deleted from library.");
  }

  async function renameItem(id) {
    const item = library.find((i) => i.id === id);
    if (!item) return;
    const name = (prompt("Rename file:", item.name) || "").trim();
    if (!name || name === item.name) return;
    item.name = name.slice(0, 120);
    try {
      await libPut(item);
    } catch (e) {
      console.warn("[CustomBG] rename failed", e);
    }
    renderLibrary();
  }

  async function clearAll() {
    if (!library.length || !confirm(`Delete all ${library.length} saved backgrounds? This cannot be undone.`)) return;
    disableBackground(true);
    try {
      await Promise.all([dbOp(LIB, "readwrite", (s) => s.clear()), dbOp(BLOBS, "readwrite", (s) => s.clear())]);
    } catch (e) {
      console.warn("[CustomBG] clear failed", e);
    }
    library = [];
    renderLibrary();
    notify("Library cleared.");
  }

  // v1 kept a single file under kv/"media"
  async function migrateLegacy() {
    try {
      const legacy = await kvGet(LEGACY_KEY);
      if (!(legacy instanceof Blob)) return;
      const meta = {
        id: uid(),
        name: legacy.name || "Imported background",
        type: legacy.type,
        size: legacy.size,
        added: Date.now(),
        zoom: settings.zoom,
        rotate: settings.rotate,
        thumb: await makeThumb(legacy),
      };
      await blobPut(meta.id, legacy);
      await libPut(meta);
      await kvDel(LEGACY_KEY);
      settings.activeId = meta.id;
      saveSettings();
    } catch (e) {
      console.warn("[CustomBG] legacy migration failed", e);
    }
  }

  /* ------------------------------------------------------------------ *
   *  UI styles
   * ------------------------------------------------------------------ */
  const UI_CSS = `
    #${UI_ID}{position:fixed;right:20px;bottom:20px;z-index:2147483647;display:flex;flex-direction:column;
      align-items:flex-end;gap:10px;font:13px/1.4 "gg sans","Segoe UI",system-ui,sans-serif;color:#f2f3f5}
    #${UI_ID} *{box-sizing:border-box}
    #${UI_ID} [hidden]{display:none!important}

    #${UI_ID} .cbg-fab{width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;background:#5865f2;
      color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.45);transition:transform .15s,background .15s}
    #${UI_ID} .cbg-fab:hover{transform:scale(1.08);background:#4752c4}

    #${UI_ID} .cbg-panel{width:316px;max-height:min(78vh,660px);display:flex;flex-direction:column;
      background:rgba(30,31,34,.97);border:1px solid rgba(255,255,255,.08);border-radius:14px;
      box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden}
    #${UI_ID} .cbg-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 8px}
    #${UI_ID} .cbg-title{font-weight:700;font-size:14px}
    #${UI_ID} .cbg-x{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:#b5bac1;
      cursor:pointer;font-size:14px}
    #${UI_ID} .cbg-x:hover{background:rgba(255,255,255,.08);color:#fff}

    #${UI_ID} .cbg-tabs{display:flex;gap:4px;padding:0 10px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
    #${UI_ID} .cbg-tab{flex:1;padding:7px 0;border:0;border-radius:8px;background:transparent;color:#b5bac1;
      cursor:pointer;font:inherit;font-weight:600}
    #${UI_ID} .cbg-tab:hover{background:rgba(255,255,255,.06)}
    #${UI_ID} .cbg-tab.on{background:#5865f2;color:#fff}

    #${UI_ID} .cbg-body{padding:12px 14px 14px;overflow-y:auto}
    #${UI_ID} .cbg-muted{color:#b5bac1;font-size:12px}
    #${UI_ID} .cbg-sub{font-size:11px;color:#949ba4;margin-top:6px;line-height:1.45}

    #${UI_ID} .cbg-drop{border:2px dashed rgba(255,255,255,.25);border-radius:10px;padding:14px 8px;
      text-align:center;color:#b5bac1;cursor:pointer;margin-bottom:12px;transition:all .15s}
    #${UI_ID} .cbg-drop:hover,#${UI_ID} .cbg-drop.over{border-color:#5865f2;background:rgba(88,101,242,.18);color:#fff}
    #${UI_ID} .cbg-drop b{display:block;color:#f2f3f5;font-size:13px}

    #${UI_ID} .cbg-libhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    #${UI_ID} .cbg-link{border:0;background:none;color:#f23f43;cursor:pointer;font:inherit;font-size:11px;padding:0}
    #${UI_ID} .cbg-link:hover{text-decoration:underline}

    #${UI_ID} .cbg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    #${UI_ID} .cbg-card{position:relative;aspect-ratio:16/11;border-radius:8px;overflow:hidden;background:#2b2d31;
      cursor:pointer;border:2px solid transparent;transition:transform .12s,border-color .12s}
    #${UI_ID} .cbg-card:hover{transform:translateY(-1px);border-color:rgba(255,255,255,.25)}
    #${UI_ID} .cbg-card.on{border-color:#5865f2}
    #${UI_ID} .cbg-card img{width:100%;height:100%;object-fit:cover;display:block}
    #${UI_ID} .cbg-ph{height:100%;display:flex;align-items:center;justify-content:center;font-size:20px}
    #${UI_ID} .cbg-name{position:absolute;left:0;right:0;bottom:0;padding:12px 5px 3px;font-size:10px;color:#fff;
      background:linear-gradient(transparent,rgba(0,0,0,.85));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${UI_ID} .cbg-mini{position:absolute;top:3px;width:20px;height:20px;border-radius:50%;border:0;padding:0;
      background:rgba(0,0,0,.75);color:#fff;font-size:10px;cursor:pointer;opacity:0;transition:opacity .12s}
    #${UI_ID} .cbg-mini:hover{background:#5865f2}
    #${UI_ID} .cbg-mini.r:hover{background:#da373c}
    #${UI_ID} .cbg-card:hover .cbg-mini{opacity:1}
    #${UI_ID} .cbg-mini.l{left:3px}
    #${UI_ID} .cbg-mini.r{right:3px}
    #${UI_ID} .cbg-badge{position:absolute;left:4px;top:4px;padding:0 5px;border-radius:8px;background:#5865f2;
      color:#fff;font-size:10px;font-weight:700}
    #${UI_ID} .cbg-vid{position:absolute;right:5px;bottom:14px;font-size:10px;color:#fff;text-shadow:0 1px 3px #000}

    #${UI_ID} .cbg-row{display:block;margin-bottom:14px}
    #${UI_ID} .cbg-row-top{display:flex;justify-content:space-between;margin-bottom:4px;color:#dbdee1;font-size:12px}
    #${UI_ID} .cbg-row-top span:last-child{color:#949ba4}
    #${UI_ID} .cbg-row input[type=range]{width:100%;accent-color:#5865f2;margin:0}

    #${UI_ID} .cbg-switch{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;
      padding:10px 0;border-top:1px solid rgba(255,255,255,.08)}
    #${UI_ID} .cbg-switch input{width:18px;height:18px;accent-color:#5865f2;cursor:pointer;flex:none}
    #${UI_ID} .cbg-switch small{display:block;color:#949ba4;font-size:11px}

    #${UI_ID} .cbg-btns{display:flex;gap:8px;margin:8px 0 10px}
    #${UI_ID} .cbg-btn{flex:1;padding:8px 12px;border:0;border-radius:8px;background:#4e5058;color:#fff;cursor:pointer;
      font:inherit;font-weight:600;transition:filter .12s}
    #${UI_ID} .cbg-btn:hover{filter:brightness(1.18)}
    #${UI_ID} .cbg-btn.danger{background:#da373c}
    #${UI_ID} .cbg-empty{text-align:center;color:#b5bac1;padding:18px 6px}

    #${UI_ID} .cbg-credit{padding:8px 14px;border-top:1px solid rgba(255,255,255,.08);text-align:center;
      font-size:11px;color:#6d6f78}
    #${UI_ID} .cbg-credit a{color:#8b95f5;text-decoration:none;font-weight:600}
    #${UI_ID} .cbg-credit a:hover{text-decoration:underline}

    #${UI_ID} .cbg-toast{max-width:316px;padding:9px 12px;border-radius:8px;background:#111214;color:#fff;
      font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.5)}
    #${UI_ID} .cbg-toast.err{background:#da373c}

    .cbg-dropall{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
      background:rgba(88,101,242,.38);color:#fff;font:600 24px "Segoe UI",system-ui,sans-serif;
      text-shadow:0 2px 8px rgba(0,0,0,.6);border:4px dashed #fff;box-sizing:border-box}
  `;

  function ensureUIStyle() {
    if (document.getElementById(UI_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = UI_STYLE_ID;
    st.textContent = UI_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   *  UI
   * ------------------------------------------------------------------ */
  function slider({ label, key, min, max, step, fmt, onChange, root = false }) {
    const out = h("span");
    const input = h("input", { type: "range", min, max, step });
    const sync = (v) => {
      settings[key] = Number(v);
      input.value = String(settings[key]);
      out.textContent = fmt(settings[key]);
      scheduleApply({ root });
    };
    sync(settings[key]);

    let t;
    input.addEventListener("input", () => {
      sync(input.value);
      clearTimeout(t);
      t = setTimeout(saveSettings, 250);
      if (onChange) onChange();
    });

    const row = h("label", { class: "cbg-row" }, h("div", { class: "cbg-row-top" }, h("span", { text: label }), out), input);
    // silent = true -> update the control without saving per-item adjustments
    row.set = (v, silent) => {
      sync(v);
      if (!silent) {
        saveSettings();
        if (onChange) onChange();
      }
    };
    return row;
  }

  function switchRow(title, hint, key, onToggle) {
    const input = h("input", { type: "checkbox" });
    input.checked = !!settings[key];
    input.addEventListener("change", () => {
      settings[key] = input.checked;
      saveSettings();
      onToggle(input.checked);
    });
    return h("label", { class: "cbg-switch" }, h("span", {}, title, h("small", { text: hint })), input);
  }

  function buildUI() {
    if (document.getElementById(UI_ID) || !document.body) return;
    ensureUIStyle();

    const fileInput = h("input", { type: "file", accept: "image/*,video/mp4,video/webm", hidden: true });
    fileInput.addEventListener("change", () => {
      setBackground(fileInput.files && fileInput.files[0]);
      fileInput.value = "";
    });

    /* ---- Library tab ---- */
    const drop = h(
      "div",
      { class: "cbg-drop", title: "Click to choose a file, or drop one here" },
      h("b", { text: "⬇ Drop a file here, or click" }),
      h("span", { class: "cbg-muted", text: "Image · GIF · video (max 100 MB)" })
    );
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("dragenter", (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        drop.classList.add("over");
      }
    });
    drop.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("over");
      handleDrop(e.dataTransfer);
    });

    const libCount = h("span", { class: "cbg-muted" });
    const clearAllBtn = h("button", { class: "cbg-link", text: "Delete all", title: "Delete every saved file", onclick: clearAll });
    const libGrid = h("div", { class: "cbg-grid" });
    const paneLib = h("div", {}, drop, h("div", { class: "cbg-libhead" }, libCount, clearAllBtn), libGrid);

    /* ---- Adjust tab ---- */
    const zoomRow = slider({
      label: "Zoom", key: "zoom", min: 1, max: 3, step: 0.01,
      fmt: (v) => `${Number(v).toFixed(2)}×`, onChange: persistAdjust,
    });
    const rotRow = slider({
      label: "Rotation", key: "rotate", min: 0, max: 359, step: 1,
      fmt: (v) => `${v}°`, onChange: persistAdjust,
    });
    const adjustEmpty = h("div", { class: "cbg-empty", text: "Pick or upload a background in the Library tab first." });
    const adjustBody = h(
      "div",
      {},
      zoomRow,
      rotRow,
      h(
        "div",
        { class: "cbg-btns" },
        h("button", { class: "cbg-btn", text: "⟳ Rotate 90°", onclick: () => rotRow.set((settings.rotate + 90) % 360) }),
        h("button", { class: "cbg-btn", text: "Reset", onclick: () => { zoomRow.set(1); rotRow.set(0); } })
      ),
      h("div", { class: "cbg-sub", text: "Zoom and rotation are remembered separately for each file." })
    );
    const paneAdjust = h("div", {}, adjustEmpty, adjustBody);

    /* ---- Look tab ---- */
    const offBtn = h("button", {
      class: "cbg-btn danger", text: "Turn off background",
      title: "Your files stay in the library", onclick: () => disableBackground(),
    });
    const paneLook = h(
      "div",
      {},
      slider({ label: "Overlay darkness (all panels)", key: "opacity", min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, root: true }),
      slider({ label: "Image dim", key: "dim", min: 0, max: 0.9, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` }),
      slider({ label: "Image blur (uses more GPU)", key: "blur", min: 0, max: 30, step: 1, fmt: (v) => `${v}px` }),
      switchRow("Same opacity on every panel", "Server list, channels, chat and members", "uniform", (on) => {
        applyRootVars();
        scheduleApply();
        if (on) scheduleScan(0);
        else unmarkAll();
      }),
      switchRow("Freeze animation", "Stops GIF/video motion. Biggest lag saver.", "freeze", () => {
        if (currentBlob) mountMedia(currentBlob);
      }),
      h(
        "div",
        { class: "cbg-btns" },
        h("button", {
          class: "cbg-btn", text: "Re-scan panels",
          title: "Use this if some panel still looks different",
          onclick: () => { unmarkAll(); scanPanels(); notify("Panels re-scanned."); },
        })
      ),
      offBtn,
      h("div", {
        class: "cbg-sub",
        text: "Less lag: use a short .mp4/.webm instead of a big GIF, keep it around 1080p, avoid blur, or freeze the animation. Ctrl+Shift+B shows/hides this panel; hold Shift while dragging a file over Discord to drop it.",
      })
    );

    /* ---- Shell ---- */
    const tabDefs = [["library", "Library"], ["adjust", "Adjust"], ["look", "Look"]];
    const panes = { library: paneLib, adjust: paneAdjust, look: paneLook };
    const tabs = {};
    const tabBar = h("div", { class: "cbg-tabs" });
    tabDefs.forEach(([key, label]) => {
      tabs[key] = h("button", { class: "cbg-tab", text: label, onclick: () => showTab(key) });
      tabBar.append(tabs[key]);
    });

    const panel = h(
      "div",
      { class: "cbg-panel", hidden: true },
      h("div", { class: "cbg-head" }, h("span", { class: "cbg-title", text: "🎨 Custom Background" }), h("button", { class: "cbg-x", text: "✕", title: "Close", onclick: closePanel })),
      tabBar,
      h("div", { class: "cbg-body" }, paneLib, paneAdjust, paneLook),
      h(
        "div",
        { class: "cbg-credit" },
        h("span", { text: `v${VERSION} · Made by ` }),
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener noreferrer", text: AUTHOR, title: "Open the GitHub repository" })
      )
    );
    const toast = h("div", { class: "cbg-toast", hidden: true });
    const fab = h("button", { class: "cbg-fab", text: "🎨", title: "Custom background (Ctrl+Shift+B)", onclick: togglePanel });

    const root = h("div", { id: UI_ID }, toast, panel, fab, fileInput);
    document.body.appendChild(root);

    ui = { root, panel, toast, tabs, panes, zoomRow, rotRow, libGrid, libCount, clearAllBtn, adjustEmpty, adjustBody, offBtn };
    showTab(settings.tab);
    updateUI();
    renderLibrary();
  }

  function showTab(name) {
    if (!ui.panes || !ui.panes[name]) name = "library";
    settings.tab = name;
    saveSettings();
    Object.entries(ui.panes).forEach(([k, pane]) => (pane.hidden = k !== name));
    Object.entries(ui.tabs).forEach(([k, tab]) => tab.classList.toggle("on", k === name));
  }

  function renderLibrary() {
    if (!ui.libGrid) return;
    const frag = document.createDocumentFragment();

    const total = library.reduce((n, i) => n + (i.size || 0), 0);
    ui.libCount.textContent = library.length
      ? `${library.length} file${library.length > 1 ? "s" : ""} · ${fmtSize(total)}`
      : "No saved files yet";
    ui.clearAllBtn.hidden = !library.length;

    library.forEach((item) => {
      const active = item.id === settings.activeId;
      const isVideo = (item.type || "").startsWith("video/");
      const mini = (txt, title, fn, side) =>
        h("button", {
          class: `cbg-mini ${side}`, text: txt, title,
          onclick: (e) => {
            e.stopPropagation();
            fn();
          },
        });

      frag.append(
        h(
          "div",
          {
            class: `cbg-card${active ? " on" : ""}`,
            title: `${item.name}\n${fmtSize(item.size || 0)}${isVideo ? " · video" : ""}`,
            onclick: () => {
              if (!active) activate(item);
            },
          },
          item.thumb
            ? h("img", { src: item.thumb, alt: "", draggable: "false", decoding: "async" })
            : h("div", { class: "cbg-ph", text: isVideo ? "🎞" : "🖼" }),
          active ? h("span", { class: "cbg-badge", text: "ACTIVE" }) : null,
          isVideo ? h("span", { class: "cbg-vid", text: "▶" }) : null,
          h("div", { class: "cbg-name", text: item.name }),
          mini("✎", "Rename", () => renameItem(item.id), "l"),
          mini("✖", "Delete", () => deleteItem(item.id), "r")
        )
      );
    });
    ui.libGrid.replaceChildren(frag);
  }

  function openPanel() {
    if (ui.panel) ui.panel.hidden = false;
  }
  function closePanel() {
    if (ui.panel) ui.panel.hidden = true;
  }
  function togglePanel() {
    if (ui.panel) ui.panel.hidden = !ui.panel.hidden;
  }

  function updateUI() {
    if (ui.offBtn) ui.offBtn.hidden = !hasMedia;
    if (ui.adjustEmpty) ui.adjustEmpty.hidden = hasMedia;
    if (ui.adjustBody) ui.adjustBody.hidden = !hasMedia;
  }

  let toastTimer;
  function notify(msg, isError = false) {
    console[isError ? "warn" : "log"](`[CustomBG] ${msg}`);
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.toggle("err", isError);
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), 3500);
  }

  /* ------------------------------------------------------------------ *
   *  Drag & drop
   *  - Drop onto the Library drop zone, or
   *  - Hold Shift while dragging a file anywhere over Discord to get a
   *    full-screen drop target (without Shift, Discord's own chat upload
   *    keeps working normally).
   * ------------------------------------------------------------------ */
  function hasFiles(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
  }

  function handleDrop(dt) {
    const file = dt && Array.from(dt.files || []).find((f) => /^(image|video)\//.test(f.type));
    if (!file) return notify("Please drop an image, GIF or video file.", true);
    setBackground(file);
  }

  function setupDragDrop() {
    let overlay = null;
    const hideOverlay = () => {
      overlay?.remove();
      overlay = null;
    };

    const showOverlay = () => {
      if (overlay && overlay.isConnected) return;
      overlay = h("div", { class: "cbg-dropall", text: "⬇ Drop image / GIF / video to set as background" });
      overlay.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      });
      overlay.addEventListener("dragleave", (e) => {
        if (e.target === overlay) hideOverlay();
      });
      overlay.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideOverlay();
        handleDrop(e.dataTransfer);
      });
      document.body.appendChild(overlay);
    };

    const onDrag = (e) => {
      if (!e.shiftKey || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // keep Discord from starting its own upload UI
      showOverlay();
    };

    window.addEventListener("dragenter", onDrag, true);
    window.addEventListener("dragover", onDrag, true);
    window.addEventListener("drop", hideOverlay, true);
    window.addEventListener("dragend", hideOverlay, true);
  }

  /* ------------------------------------------------------------------ *
   *  Resilience + event-driven triggers (no subtree mutation observers)
   * ------------------------------------------------------------------ */
  function watchDOM() {
    // Re-add our nodes if Discord drops them (shallow observers, throttled)
    let timer = null;
    const check = () => {
      timer = null;
      ensureUIStyle();
      if (!document.getElementById(UI_ID)) buildUI();
      if (hasMedia) {
        if (!document.getElementById(STYLE_ID)) ensureStyle();
        if (!document.getElementById(LAYER_ID) && currentBlob) mountMedia(currentBlob);
      }
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(check, 250);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true });
    if (document.head) new MutationObserver(schedule).observe(document.head, { childList: true });
    new MutationObserver(schedule).observe(document.body, { childList: true });

    // Theme switch (dark <-> light) -> update tint, only when it really changed
    let lastLight = isLight();
    new MutationObserver(() => {
      const now = isLight();
      if (now === lastLight) return;
      lastLight = now;
      applyRootVars();
      scheduleApply();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // Panels appear/disappear after clicks and navigation, not randomly:
    document.addEventListener("click", () => scheduleScan(500), { capture: true, passive: true });
    window.addEventListener("popstate", () => scheduleScan(500));
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function () {
        const result = original.apply(this, arguments);
        scheduleScan(500);
        return result;
      };
    }

    document.addEventListener("visibilitychange", syncPlayback);
  }

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  function whenReady(cb) {
    if (document.querySelector("#app-mount") && document.body) return cb();
    const mo = new MutationObserver(() => {
      if (document.querySelector("#app-mount") && document.body) {
        mo.disconnect();
        cb();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function boot() {
    console.log(
      `%c${APP_NAME}%c v${VERSION} · by ${AUTHOR} · ${REPO_URL}`,
      "background:#5865f2;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700",
      "color:#949ba4"
    );
    buildUI();
    await migrateLegacy();
    await refreshLibrary();

    const saved = library.find((i) => i.id === settings.activeId);
    if (saved) {
      await activate(saved);
    } else if (settings.activeId) {
      settings.activeId = null; // file was deleted elsewhere
      saveSettings();
    }

    watchDOM();
    setupDragDrop();

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        scheduleApply();
        scheduleScan(300);
      }, 150); // wait until the user stops resizing
    });

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey === HOTKEY.ctrl && e.shiftKey === HOTKEY.shift && e.key.toUpperCase() === HOTKEY.key) {
        e.preventDefault();
        togglePanel();
      } else if (e.key === "Escape" && ui.panel && !ui.panel.hidden) {
        closePanel();
      }
    });
  }

  whenReady(boot);
})();
