/**
 * ComfyUI Data Manager — Frontend Widget  v1.2
 * =============================================
 * Fix coordinate widget + thumbnail inline nella cella image
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Costanti
// ─────────────────────────────────────────────────────────────────────────────

const COLUMN_TYPES = ["string", "int", "float", "boolean", "select", "image", "audio", "video"];
const TYPE_COLORS  = {
  string : "#4a9eff",
  int    : "#ff9f4a",
  float  : "#4aff9f",
  image  : "#c44aff",
  audio  : "#ff4a7a",
  boolean: "#4affd4",
  select : "#ffd44a",
  video  : "#ff7a1a",
};
const ROW_H     = 52;   // altezza riga — abbastanza per thumbnail
const HEADER_H  = 32;
const COL_DEF_W = 140;
const TOOLBAR_H = 34;
const PADDING   = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Utility payload
// ─────────────────────────────────────────────────────────────────────────────

function generateId() {
  return "col_" + Math.random().toString(36).slice(2, 9);
}

function syncPayload(node, payload) {
  const w = node.widgets?.find(w => w.name === "grid_data");
  if (!w) return;
  w.value = JSON.stringify(payload);
  // Notifica ComfyUI che il nodo è stato modificato — questo marca il
  // workflow come "unsaved" e garantisce che il valore venga incluso
  // nel prossimo salvataggio (Ctrl+S o auto-save).
  node.graph?.change?.();
}

function readPayload(node) {
  const w = node.widgets?.find(w => w.name === "grid_data");
  if (!w || !w.value) return emptyPayload();
  try { return JSON.parse(w.value); }
  catch { return emptyPayload(); }
}

function emptyPayload() {
  return { schema: [], rows: [], meta: { name: "Untitled", file_path: "", col_widths: {} } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility immagini
// ─────────────────────────────────────────────────────────────────────────────

function normalizeImageValue(val) {
  if (!val) return null;
  if (typeof val === "object" && val.filename) return val;
  if (typeof val === "string" && val.trim())
    return { filename: val.split(/[\\/]/).pop(), subfolder: "", type: "input" };
  return null;
}

function imageViewUrl(imgVal) {
  const v = normalizeImageValue(imgVal);
  if (!v) return null;
  return `/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder ?? "")}&type=${v.type ?? "input"}`;
}

// Audio file extensions
const AUDIO_EXTS = new Set(["mp3","wav","ogg","flac","m4a","aac","opus","weba"]);

// Same normalizer works for audio (same {filename,subfolder,type} format)
const normalizeAudioValue = normalizeImageValue;

// URL to stream an audio file through the ComfyUI server
function audioViewUrl(audioVal) {
  const v = normalizeAudioValue(audioVal);
  if (!v) return null;
  return `/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder ?? "")}&type=${v.type ?? "input"}`;
}

// ── Audio state: one shared Audio object so only one file plays at a time ─────
let _activeAudio   = null;  // current HTMLAudioElement
let _activeUrl     = null;  // url of currently playing file
let _dirtyCallback = null;  // function to call for canvas redraw

function audioIsPlaying(url) { return _activeUrl === url && _activeAudio && !_activeAudio.paused; }

function audioToggle(url, onStateChange) {
  if (_activeUrl === url && _activeAudio) {
    if (_activeAudio.paused) { _activeAudio.play(); }
    else                     { _activeAudio.pause(); }
    onStateChange();
    return;
  }
  // Stop previous
  if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  _activeUrl   = url;
  _activeAudio = new Audio(url);
  _activeAudio.onended  = () => { _activeUrl = null; onStateChange(); };
  _activeAudio.onpause  = () => onStateChange();
  _activeAudio.onplay   = () => onStateChange();
  _activeAudio.onerror  = () => { _activeUrl = null; onStateChange(); };
  _activeAudio.play().catch(() => {});
  onStateChange();
}

// Duration cache: url → "0:42" | "loading" | "error"
const _durationCache   = {};   // url → "M:SS" | "--:--"
const _durationPending = {};   // url → [callback, ...] waiting for load

function loadAudioDuration(url, onReady) {
  // Already resolved: call back immediately
  if (_durationCache[url] !== undefined) { onReady(); return; }

  // Already loading: queue this callback and wait
  if (_durationPending[url]) { _durationPending[url].push(onReady); return; }

  // First request: load only metadata via a hidden Audio element
  _durationPending[url] = [onReady];

  function _flush(val) {
    _durationCache[url] = val;
    const cbs = _durationPending[url] ?? [];
    delete _durationPending[url];
    cbs.forEach(cb => cb());
  }

  const a = new Audio();
  a.preload = "metadata";

  a.onloadedmetadata = () => {
    const secs = a.duration;
    if (isFinite(secs) && !isNaN(secs) && secs > 0) {
      const m  = Math.floor(secs / 60);
      const ss = String(Math.round(secs % 60)).padStart(2, "0");
      _flush(`${m}:${ss}`);
    } else {
      // duration not yet available — wait for durationchange
    }
  };

  // durationchange fires after the real duration is decoded,
  // useful when onloadedmetadata fires with duration=NaN or 0
  a.ondurationchange = () => {
    const secs = a.duration;
    if (isFinite(secs) && !isNaN(secs) && secs > 0 && !_durationCache[url]) {
      const m  = Math.floor(secs / 60);
      const ss = String(Math.round(secs % 60)).padStart(2, "0");
      _flush(`${m}:${ss}`);
    }
  };

  a.onerror = (e) => {
    console.warn("[DataManager] browser duration load failed for", url, "— trying server fallback");
    _fetchDurationFromServer(url, _flush);
  };

  // Set src last, then call load() explicitly to trigger metadata fetch
  a.src = url;
  a.load();

  // Safety timeout: if browser doesn't fire any event in 4s, try server
  setTimeout(() => {
    if (_durationPending[url]) {
      console.warn("[DataManager] duration timeout for", url, "— trying server fallback");
      _fetchDurationFromServer(url, _flush);
    }
  }, 4000);
}

// Fetch duration from the Python backend (uses mutagen, no browser decode needed)
async function _fetchDurationFromServer(url, onDone) {
  if (!onDone) return;  // already resolved
  try {
    // Extract filename and subfolder from the /view?filename=...&subfolder=... URL
    const u        = new URL(url, location.origin);
    const filename = u.searchParams.get("filename") ?? "";
    const subfolder= u.searchParams.get("subfolder") ?? "";
    const resp     = await api.fetchApi(`/dm/duration?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.duration !== null && isFinite(data.duration)) {
        const secs = Math.round(data.duration);
        const m    = Math.floor(secs / 60);
        const ss   = String(secs % 60).padStart(2, "0");
        onDone(`${m}:${ss}`);
        return;
      }
    }
  } catch (e) {
    console.warn("[DataManager] server duration fallback failed:", e);
  }
  onDone("--:--");
}

async function fetchInputImages() {
  // Tentativo 1: nostro endpoint dedicato /dm/list_inputs (registrato da __init__.py).
  // Usa folder_paths di ComfyUI internamente — affidabile su tutte le versioni.
  try {
    const resp = await api.fetchApi("/dm/list_inputs");
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {
    console.warn("[DataManager] /dm/list_inputs:", e);
  }

  // Tentativo 2: /object_info/LoadImage — struttura varia per versione ComfyUI.
  try {
    const resp = await api.fetchApi("/object_info/LoadImage");
    if (resp.ok) {
      const data = await resp.json();
      // Versione recente: { LoadImage: { input: { required: { image: [list] } } } }
      const v1 = data?.LoadImage?.input?.required?.image?.[0];
      if (Array.isArray(v1) && v1.length > 0) return v1;
      // Versione precedente: { input: { required: { image: [list] } } }
      const v2 = data?.input?.required?.image?.[0];
      if (Array.isArray(v2) && v2.length > 0) return v2;
    }
  } catch (e) {
    console.warn("[DataManager] /object_info/LoadImage:", e);
  }

  // Tentativo 3: scansiona tutti i nodi in /object_info cercando liste immagini
  try {
    const resp = await api.fetchApi("/object_info");
    if (resp.ok) {
      const data = await resp.json();
      for (const nodeInfo of Object.values(data)) {
        const imgParam = nodeInfo?.input?.required?.image?.[0]
                      ?? nodeInfo?.input?.optional?.image?.[0];
        if (Array.isArray(imgParam) && imgParam.length > 0
            && typeof imgParam[0] === "string"
            && imgParam[0].match(/[.](png|jpg|jpeg|webp|gif|bmp)$/i)) {
          return imgParam;
        }
      }
    }
  } catch (e) {
    console.warn("[DataManager] /object_info scan:", e);
  }

  console.warn("[DataManager] Impossibile recuperare la lista immagini.");
  return [];
}

async function fetchInputAudio() {
  // Use the dedicated backend endpoint that returns only audio files.
  // This avoids relying on fetchInputImages() fallbacks that filter by image extensions.
  try {
    const resp = await api.fetchApi("/dm/list_audio");
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {
    console.warn("[DataManager] /dm/list_audio:", e);
  }
  // Fallback: filter full list locally
  try {
    const resp = await api.fetchApi("/dm/list_inputs");
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) return data.filter(f => AUDIO_EXTS.has(f.split(".").pop().toLowerCase()));
    }
  } catch (e) {
    console.warn("[DataManager] /dm/list_inputs fallback:", e);
  }
  return [];
}

async function uploadImage(file) {
  const form = new FormData();
  form.append("image",     file);
  form.append("type",      "input");
  form.append("overwrite", "true");
  try {
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return { filename: data.name, subfolder: data.subfolder ?? "", type: "input" };
  } catch (e) {
    console.error("[DataManager] Upload:", e);
    return null;
  }
}

const VIDEO_EXTS = new Set(["mp4","mov","avi","mkv","webm","m4v","wmv"]);

// Same {filename,subfolder,type} format as image/audio
const normalizeVideoValue = normalizeImageValue;

// URL to stream a video file through the ComfyUI /view endpoint
function videoViewUrl(videoVal) {
  const v = normalizeVideoValue(videoVal);
  if (!v) return null;
  return `/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder ?? "")}&type=${v.type ?? "input"}`;
}

// URL for the server-generated thumbnail of the first video frame
function videoThumbUrl(videoVal) {
  const v = normalizeVideoValue(videoVal);
  if (!v) return null;
  return `/api/dm/thumbnail?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder ?? "")}`;
}

async function fetchInputVideo() {
  try {
    const resp = await api.fetchApi("/dm/list_video");
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) { console.warn("[DataManager] /dm/list_video:", e); }
  // Fallback: filter full list
  try {
    const resp = await api.fetchApi("/dm/list_inputs");
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) return data.filter(f => VIDEO_EXTS.has(f.split(".").pop().toLowerCase()));
    }
  } catch (e) { console.warn("[DataManager] /dm/list_inputs fallback (video):", e); }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal helpers
// ─────────────────────────────────────────────────────────────────────────────

function createOverlay() {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center;
    z-index:9999; font-family:sans-serif;
  `;
  return el;
}

function inputField(label, value = "", type = "text") {
  const wrap = document.createElement("div");
  wrap.style.cssText = "margin-bottom:12px;";
  wrap.innerHTML = `
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">${label}</label>
    <input type="${type}" value="${value}" style="
      width:100%; box-sizing:border-box; padding:7px 10px;
      border-radius:5px; border:1px solid #555; background:#2a2a3e;
      color:#eee; font-size:13px;"/>`;
  return wrap;
}

function selectField(label, options, selected) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "margin-bottom:12px;";
  const opts = options.map(o =>
    `<option value="${o}" ${o === selected ? "selected" : ""}>${o}</option>`).join("");
  wrap.innerHTML = `
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">${label}</label>
    <select style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:5px;
      border:1px solid #555;background:#2a2a3e;color:#eee;font-size:13px;">${opts}</select>`;
  return wrap;
}

function createModal(title, content, buttons) {
  const overlay = createOverlay();
  const box = document.createElement("div");
  box.style.cssText = `
    background:#1e1e2e; border:1px solid #444; border-radius:10px;
    padding:22px 26px; min-width:360px; max-width:580px; color:#eee;
    box-shadow:0 8px 32px rgba(0,0,0,.7); max-height:90vh; overflow-y:auto;`;
  box.innerHTML = `<h3 style="margin:0 0 14px;font-size:15px;color:#adf;">${title}</h3>`;
  box.appendChild(content);
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:10px;justify-content:flex-end;margin-top:16px;";
  buttons.forEach(({ label, primary, action }) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `padding:7px 18px;border-radius:6px;border:none;cursor:pointer;
      font-size:13px;font-weight:600;background:${primary?"#4a9eff":"#333"};color:#fff;`;
    b.onclick = () => action(overlay);
    btnRow.appendChild(b);
  });
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: selezione image (galleria + upload)
// ─────────────────────────────────────────────────────────────────────────────

function openImagePicker(currentValue, onConfirm) {
  const overlay = createOverlay();
  const box = document.createElement("div");
  box.style.cssText = `
    background:#1e1e2e; border:1px solid #444; border-radius:10px;
    padding:20px 24px; width:600px; max-width:96vw; color:#eee;
    box-shadow:0 8px 32px rgba(0,0,0,.7);
    max-height:92vh; display:flex; flex-direction:column; gap:12px;`;

  box.innerHTML = `<h3 style="margin:0;font-size:15px;color:#adf;">🖼️ Choose Image</h3>`;

  // Upload
  const uploadRow = document.createElement("div");
  uploadRow.style.cssText = "display:flex;align-items:center;gap:10px;flex-shrink:0;";
  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "⬆ Upload new file…";
  uploadBtn.style.cssText = `padding:7px 14px;border-radius:6px;border:1px solid #555;
    background:#2a2a3e;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;`;
  const uploadStatus = document.createElement("span");
  uploadStatus.style.cssText = "font-size:12px;color:#aaa;";
  uploadBtn.onclick = () => {
    const fi = document.createElement("input");
    fi.type = "file"; fi.accept = "image/*";
    fi.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      uploadBtn.disabled = true;
      uploadStatus.textContent = "⟳ Loading…";
      const result = await uploadImage(file);
      uploadBtn.disabled = false;
      if (result) {
        uploadStatus.textContent = `✅ ${result.filename}`;
        selected = result;
        loadGallery();
      } else {
        uploadStatus.textContent = "❌ Error";
      }
    };
    fi.click();
  };
  uploadRow.appendChild(uploadBtn);
  uploadRow.appendChild(uploadStatus);
  box.appendChild(uploadRow);

  // Gallery
  const galLabel = document.createElement("div");
  galLabel.style.cssText = "font-size:11px;color:#666;flex-shrink:0;";
  galLabel.textContent = "Images in the input folder (double-click to select and confirm):";
  box.appendChild(galLabel);

  const gallery = document.createElement("div");
  gallery.style.cssText = `
    display:grid; grid-template-columns:repeat(auto-fill,100px);
    gap:8px; overflow-y:auto; flex:1; min-height:180px; max-height:400px;
    background:#0e0e1a; border-radius:8px; padding:10px; border:1px solid #2a2a3e;`;
  box.appendChild(gallery);

  let selected = normalizeImageValue(currentValue);

  function refreshSelection() {
    gallery.querySelectorAll(".dm-gi").forEach(el => {
      const match = selected && el.dataset.fn === selected.filename
                    && el.dataset.sf === (selected.subfolder ?? "");
      el.style.outline    = match ? "2px solid #4a9eff" : "2px solid transparent";
      el.style.background = match ? "#1a2e4e" : "#1a1a2e";
    });
  }

  async function loadGallery() {
    gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:10px;grid-column:1/-1;">⟳ Loading…</div>`;
    const images = await fetchInputImages();
    gallery.innerHTML = "";
    if (!images.length) {
      gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:10px;grid-column:1/-1;">Input folder is empty.</div>`;
      return;
    }
    images.forEach(filename => {
      const parts = filename.split("/");
      const fname = parts.pop();
      const sf    = parts.join("/");
      const iv    = { filename: fname, subfolder: sf, type: "input" };

      const item = document.createElement("div");
      item.className = "dm-gi";
      item.dataset.fn = fname;
      item.dataset.sf = sf;
      item.style.cssText = `cursor:pointer;border-radius:6px;overflow:hidden;
        outline:2px solid transparent;background:#1a1a2e;
        display:flex;flex-direction:column;align-items:center;
        width:100px;height:100px;flex-shrink:0;`;

      const img = document.createElement("img");
      img.src = imageViewUrl(iv);
      img.style.cssText = "width:100px;height:80px;object-fit:cover;display:block;flex-shrink:0;";
      img.onerror = () => {
        img.style.display = "none";
        const ic = document.createElement("div");
        ic.style.cssText = "width:100px;height:80px;display:flex;align-items:center;justify-content:center;font-size:24px;background:#1a1a2e;flex-shrink:0;";
        ic.textContent = "🖼️";
        item.insertBefore(ic, item.firstChild);
      };

      const lbl = document.createElement("div");
      lbl.style.cssText = "font-size:9px;color:#888;padding:2px 3px;width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;";
      lbl.textContent = fname;
      lbl.title = filename;

      item.appendChild(img);
      item.appendChild(lbl);

      item.onclick    = () => { selected = iv; refreshSelection(); };
      item.ondblclick = () => { selected = iv; onConfirm(selected); overlay.remove(); };

      gallery.appendChild(item);
    });
    refreshSelection();
  }

  loadGallery();

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-shrink:0;";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "🗑 Remove";
  clearBtn.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #8f3333;background:transparent;color:#f66;cursor:pointer;font-size:12px;";
  clearBtn.onclick = () => { selected = null; refreshSelection(); };
  const right = document.createElement("div");
  right.style.cssText = "display:flex;gap:8px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#333;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  cancelBtn.onclick = () => overlay.remove();
  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "✓ Confirm";
  confirmBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#4a9eff;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  confirmBtn.onclick = () => { onConfirm(selected); overlay.remove(); };
  right.appendChild(cancelBtn);
  right.appendChild(confirmBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(right);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: audio picker (same UI as image picker, filtered for audio files)
// ─────────────────────────────────────────────────────────────────────────────

function openAudioPicker(currentValue, onConfirm) {
  const overlay = createOverlay();
  const box = document.createElement("div");
  box.style.cssText = `
    background:#1e1e2e; border:1px solid #444; border-radius:10px;
    padding:20px 24px; width:560px; max-width:96vw; color:#eee;
    box-shadow:0 8px 32px rgba(0,0,0,.7);
    max-height:92vh; display:flex; flex-direction:column; gap:12px;`;
  box.innerHTML = `<h3 style="margin:0;font-size:15px;color:#adf;">🎵 Choose Audio File</h3>`;

  // Upload
  const uploadRow = document.createElement("div");
  uploadRow.style.cssText = "display:flex;align-items:center;gap:10px;flex-shrink:0;";
  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "⬆ Upload new file…";
  uploadBtn.style.cssText = `padding:7px 14px;border-radius:6px;border:1px solid #555;
    background:#2a2a3e;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;`;
  const uploadStatus = document.createElement("span");
  uploadStatus.style.cssText = "font-size:12px;color:#aaa;";
  uploadBtn.onclick = () => {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus";
    fi.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      uploadBtn.disabled = true;
      uploadStatus.textContent = "⟳ Uploading…";
      const result = await uploadImage(file); // same endpoint accepts any file
      uploadBtn.disabled = false;
      if (result) {
        uploadStatus.textContent = `✅ ${result.filename}`;
        selected = result;
        loadGallery();
      } else {
        uploadStatus.textContent = "❌ Error";
      }
    };
    fi.click();
  };
  uploadRow.appendChild(uploadBtn);
  uploadRow.appendChild(uploadStatus);
  box.appendChild(uploadRow);

  // Gallery label
  const galLabel = document.createElement("div");
  galLabel.style.cssText = "font-size:11px;color:#666;flex-shrink:0;";
  galLabel.textContent = "Audio files in the input folder (double-click to select and confirm):";
  box.appendChild(galLabel);

  // Gallery list (audio files as rows, not thumbnails)
  const gallery = document.createElement("div");
  gallery.style.cssText = `
    display:flex; flex-direction:column; gap:4px;
    overflow-y:auto; flex:1; min-height:120px; max-height:360px;
    background:#0e0e1a; border-radius:8px; padding:8px; border:1px solid #2a2a3e;`;
  box.appendChild(gallery);

  let selected = normalizeAudioValue(currentValue);

  function refreshSelection() {
    gallery.querySelectorAll(".dm-ai").forEach(el => {
      const match = selected && el.dataset.fn === selected.filename
                    && el.dataset.sf === (selected.subfolder ?? "");
      el.style.outline    = match ? "2px solid #ff4a7a" : "2px solid transparent";
      el.style.background = match ? "#2e1a2e" : "#1a1a2e";
    });
  }

  async function loadGallery() {
    gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:8px;">⟳ Loading…</div>`;
    const files = await fetchInputAudio();
    gallery.innerHTML = "";
    if (!files.length) {
      gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:8px;">No audio files in the input folder.</div>`;
      return;
    }
    files.forEach(filename => {
      const parts = filename.split("/");
      const fname = parts.pop();
      const sf    = parts.join("/");
      const av    = { filename: fname, subfolder: sf, type: "input" };
      const url   = audioViewUrl(av);

      const item = document.createElement("div");
      item.className = "dm-ai";
      item.dataset.fn = fname;
      item.dataset.sf = sf;
      item.style.cssText = `cursor:pointer;border-radius:5px;padding:8px 10px;
        outline:2px solid transparent;background:#1a1a2e;
        display:flex;align-items:center;gap:10px;`;

      const icon = document.createElement("div");
      icon.style.cssText = "font-size:18px;flex-shrink:0;";
      icon.textContent = "🎵";

      const info = document.createElement("div");
      info.style.cssText = "flex:1;overflow:hidden;";
      const nameEl = document.createElement("div");
      nameEl.style.cssText = "font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      nameEl.textContent = fname;
      const durEl = document.createElement("div");
      durEl.style.cssText = "font-size:10px;color:#666;margin-top:2px;";
      durEl.textContent = "--:--";
      // Load duration
      loadAudioDuration(url, () => { durEl.textContent = _durationCache[url] ?? "--:--"; });
      info.appendChild(nameEl);
      info.appendChild(durEl);

      item.appendChild(icon);
      item.appendChild(info);

      item.onclick    = () => { selected = av; refreshSelection(); };
      item.ondblclick = () => { selected = av; onConfirm(selected); overlay.remove(); };
      gallery.appendChild(item);
    });
    refreshSelection();
  }

  loadGallery();

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-shrink:0;";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "🗑 Remove";
  clearBtn.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #8f3333;background:transparent;color:#f66;cursor:pointer;font-size:12px;";
  clearBtn.onclick = () => { selected = null; refreshSelection(); };
  const right = document.createElement("div");
  right.style.cssText = "display:flex;gap:8px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#333;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  cancelBtn.onclick = () => overlay.remove();
  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "✓ Confirm";
  confirmBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#ff4a7a;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  confirmBtn.onclick = () => { onConfirm(selected); overlay.remove(); };
  right.appendChild(cancelBtn);
  right.appendChild(confirmBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(right);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: colonna
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: video picker (gallery with server-generated thumbnails + upload)
// ─────────────────────────────────────────────────────────────────────────────

function openVideoPicker(currentValue, onConfirm) {
  const overlay = createOverlay();
  const box = document.createElement("div");
  box.style.cssText = `
    background:#1e1e2e; border:1px solid #444; border-radius:10px;
    padding:20px 24px; width:600px; max-width:96vw; color:#eee;
    box-shadow:0 8px 32px rgba(0,0,0,.7);
    max-height:92vh; display:flex; flex-direction:column; gap:12px;`;
  box.innerHTML = `<h3 style="margin:0;font-size:15px;color:#ff7a1a;">🎬 Choose Video</h3>`;

  // Upload
  const uploadRow = document.createElement("div");
  uploadRow.style.cssText = "display:flex;align-items:center;gap:10px;flex-shrink:0;";
  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "⬆ Upload new file…";
  uploadBtn.style.cssText = `padding:7px 14px;border-radius:6px;border:1px solid #555;
    background:#2a2a3e;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;`;
  const uploadStatus = document.createElement("span");
  uploadStatus.style.cssText = "font-size:12px;color:#aaa;";
  uploadBtn.onclick = () => {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v,.wmv";
    fi.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      uploadBtn.disabled = true;
      uploadStatus.textContent = "⟳ Uploading…";
      const result = await uploadImage(file); // same endpoint accepts any file
      uploadBtn.disabled = false;
      if (result) {
        uploadStatus.textContent = `✅ ${result.filename}`;
        selected = result;
        loadGallery();
      } else {
        uploadStatus.textContent = "❌ Error";
      }
    };
    fi.click();
  };
  uploadRow.appendChild(uploadBtn);
  uploadRow.appendChild(uploadStatus);
  box.appendChild(uploadRow);

  // Gallery label
  const galLabel = document.createElement("div");
  galLabel.style.cssText = "font-size:11px;color:#666;flex-shrink:0;";
  galLabel.textContent = "Video files in the input folder (double-click to select and confirm):";
  box.appendChild(galLabel);

  // Gallery grid — thumbnails like the image picker
  const gallery = document.createElement("div");
  gallery.style.cssText = `
    display:grid; grid-template-columns:repeat(auto-fill,120px);
    gap:8px; overflow-y:auto; flex:1; min-height:180px; max-height:400px;
    background:#0e0e1a; border-radius:8px; padding:10px; border:1px solid #2a2a3e;`;
  box.appendChild(gallery);

  let selected = normalizeVideoValue(currentValue);

  function refreshSelection() {
    gallery.querySelectorAll(".dm-vi").forEach(el => {
      const match = selected && el.dataset.fn === selected.filename
                    && el.dataset.sf === (selected.subfolder ?? "");
      el.style.outline    = match ? "2px solid #ff7a1a" : "2px solid transparent";
      el.style.background = match ? "#2e1a00" : "#1a1a2e";
    });
  }

  async function loadGallery() {
    gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:10px;grid-column:1/-1;">⟳ Loading…</div>`;
    const files = await fetchInputVideo();
    gallery.innerHTML = "";
    if (!files.length) {
      gallery.innerHTML = `<div style="color:#555;font-size:12px;padding:10px;grid-column:1/-1;">No video files in the input folder.</div>`;
      return;
    }
    files.forEach(filename => {
      const parts = filename.split("/");
      const fname = parts.pop();
      const sf    = parts.join("/");
      const vv    = { filename: fname, subfolder: sf, type: "input" };

      const item = document.createElement("div");
      item.className = "dm-vi";
      item.dataset.fn = fname;
      item.dataset.sf = sf;
      item.style.cssText = `cursor:pointer;border-radius:6px;overflow:hidden;
        outline:2px solid transparent;background:#1a1a2e;
        display:flex;flex-direction:column;align-items:center;
        width:120px;flex-shrink:0;`;

      // Thumbnail from server — fallback to 🎬 icon
      const thumb = document.createElement("img");
      thumb.src = videoThumbUrl(vv);
      thumb.style.cssText = "width:120px;height:68px;object-fit:cover;display:block;";
      thumb.onerror = () => {
        thumb.style.display = "none";
        const ic = document.createElement("div");
        ic.style.cssText = "width:120px;height:68px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#1a1a2e;";
        ic.textContent = "🎬";
        item.insertBefore(ic, item.firstChild);
      };

      const lbl = document.createElement("div");
      lbl.style.cssText = "font-size:9px;color:#888;padding:2px 4px;width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;";
      lbl.textContent = fname;
      lbl.title = filename;

      item.appendChild(thumb);
      item.appendChild(lbl);
      item.onclick    = () => { selected = vv; refreshSelection(); };
      item.ondblclick = () => { selected = vv; onConfirm(selected); overlay.remove(); };
      gallery.appendChild(item);
    });
    refreshSelection();
  }

  loadGallery();

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-shrink:0;";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "🗑 Remove";
  clearBtn.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #8f3333;background:transparent;color:#f66;cursor:pointer;font-size:12px;";
  clearBtn.onclick = () => { selected = null; refreshSelection(); };
  const right = document.createElement("div");
  right.style.cssText = "display:flex;gap:8px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#333;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  cancelBtn.onclick = () => overlay.remove();
  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "✓ Confirm";
  confirmBtn.style.cssText = "padding:7px 16px;border-radius:6px;border:none;background:#ff7a1a;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
  confirmBtn.onclick = () => { onConfirm(selected); overlay.remove(); };
  right.appendChild(cancelBtn);
  right.appendChild(confirmBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(right);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: select cell picker — shows the configured options as a clickable list
// ─────────────────────────────────────────────────────────────────────────────

function openSelectPicker(col, currentValue, onConfirm) {
  const options = col.options ?? [];
  if (options.length === 0) {
    alert(`Column "${col.label}" has no options defined. Edit the column to add some.`);
    return;
  }

  const overlay = createOverlay();
  const box = document.createElement("div");
  box.style.cssText = `
    background:#1e1e2e; border:1px solid #444; border-radius:10px;
    padding:20px 24px; width:340px; max-width:96vw; color:#eee;
    box-shadow:0 8px 32px rgba(0,0,0,.7);
    max-height:80vh; display:flex; flex-direction:column; gap:10px;`;

  const title = document.createElement("h3");
  title.style.cssText = "margin:0; font-size:14px; color:#ffd44a;";
  title.textContent = `▾ ${col.label}`;
  box.appendChild(title);

  const list = document.createElement("div");
  list.style.cssText = `
    display:flex; flex-direction:column; gap:4px;
    overflow-y:auto; max-height:360px;`;

  // "Clear" option at the top
  const clearItem = document.createElement("div");
  clearItem.style.cssText = `
    padding:8px 12px; border-radius:5px; cursor:pointer;
    font-size:12px; color:#555; font-style:italic;
    border:1px solid #2a2a3e;`;
  clearItem.textContent = "— clear selection —";
  clearItem.onmouseenter = () => clearItem.style.background = "#2a2a3e";
  clearItem.onmouseleave = () => clearItem.style.background = "transparent";
  clearItem.onclick = () => { onConfirm(null); overlay.remove(); };
  list.appendChild(clearItem);

  options.forEach(opt => {
    const item = document.createElement("div");
    const isSelected = opt === currentValue;
    item.style.cssText = `
      padding:9px 12px; border-radius:5px; cursor:pointer;
      font-size:13px; color:${isSelected ? "#ffd44a" : "#ddd"};
      background:${isSelected ? "#2a2200" : "transparent"};
      border:1px solid ${isSelected ? "#ffd44a44" : "#2a2a3e"};
      display:flex; align-items:center; gap:8px;`;

    const check = document.createElement("span");
    check.style.cssText = `font-size:11px; color:#ffd44a; width:12px; flex-shrink:0;`;
    check.textContent = isSelected ? "✓" : "";

    const label = document.createElement("span");
    label.textContent = opt;

    item.appendChild(check);
    item.appendChild(label);

    item.onmouseenter = () => {
      if (!isSelected) item.style.background = "#1e1e10";
    };
    item.onmouseleave = () => {
      if (!isSelected) item.style.background = "transparent";
    };
    item.onclick = () => { onConfirm(opt); overlay.remove(); };
    list.appendChild(item);
  });

  box.appendChild(list);

  // Cancel button
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex; justify-content:flex-end;";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding:6px 16px; border-radius:6px; border:none;
    background:#333; color:#fff; cursor:pointer; font-size:13px; font-weight:600;`;
  cancelBtn.onclick = () => overlay.remove();
  btnRow.appendChild(cancelBtn);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

function openColumnDialog(existingCol, onConfirm) {
  const form      = document.createElement("div");
  const labelWrap = inputField("Name / Label", existingCol?.label ?? "");
  const typeWrap  = selectField("Type", COLUMN_TYPES, existingCol?.type ?? "string");
  form.appendChild(labelWrap);
  form.appendChild(typeWrap);

  // Options field — shown only when type = "select"
  const optionsWrap = document.createElement("div");
  optionsWrap.style.cssText = "margin-bottom:12px;";
  optionsWrap.innerHTML = `
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">
      Options <span style="color:#666;font-weight:normal;">(one per line)</span>
    </label>
    <textarea rows="5" style="
      width:100%; box-sizing:border-box; padding:7px 10px;
      border-radius:5px; border:1px solid #555; background:#2a2a3e;
      color:#eee; font-size:13px; resize:vertical; font-family:sans-serif;
    ">${(existingCol?.options ?? []).join("\n")}</textarea>`;

  function syncOptionsVisibility() {
    const type = typeWrap.querySelector("select").value;
    optionsWrap.style.display = type === "select" ? "block" : "none";
  }
  typeWrap.querySelector("select").addEventListener("change", syncOptionsVisibility);
  syncOptionsVisibility();
  form.appendChild(optionsWrap);

  createModal(existingCol ? "✏️ Edit Column" : "➕ Add Column", form, [
    { label: "Cancel",  primary: false, action: o => o.remove() },
    { label: "Confirm", primary: true,  action: overlay => {
      const label = labelWrap.querySelector("input").value.trim();
      const type  = typeWrap.querySelector("select").value;
      if (!label) { alert("Please enter a name."); return; }
      let options = [];
      if (type === "select") {
        options = optionsWrap.querySelector("textarea").value
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean);
        if (options.length === 0) { alert("Add at least one option for a Select column."); return; }
      }
      onConfirm({ label, type, options });
      overlay.remove();
    }}
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: preset
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS = {
  "Storyboard":      [
    { label:"Scene",type:"string"},{label:"Prompt",type:"string"},
    { label:"Negative",type:"string"},{label:"Seed",type:"int"},
    { label:"Steps",type:"int"},{label:"CFG",type:"float"},
    { label:"Reference",type:"image"}],
  "Character Sheet": [
    { label:"Name",type:"string"},{label:"Description",type:"string"},
    { label:"Prompt",type:"string"},{label:"Age",type:"int"},
    { label:"Portrait",type:"image"}],
  "Dataset Builder": [
    { label:"Caption",type:"string"},{label:"Tags",type:"string"},
    { label:"Weight",type:"float"},{label:"Image",type:"image"}],
};

function openPresetDialog(onConfirm) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;";
  Object.entries(PRESETS).forEach(([name, cols]) => {
    const btn = document.createElement("button");
    btn.style.cssText = `padding:10px 16px;border-radius:7px;border:1px solid #555;
      background:#2a2a3e;color:#eee;cursor:pointer;text-align:left;font-size:13px;`;
    btn.innerHTML = `<strong>${name}</strong><br><span style="font-size:11px;color:#aaa">${cols.map(c=>c.label).join(" · ")}</span>`;
    btn.onmouseenter = () => btn.style.background = "#3a3a5e";
    btn.onmouseleave = () => btn.style.background = "#2a2a3e";
    btn.onclick = () => { onConfirm(name, cols); };
    wrap.appendChild(btn);
  });
  createModal("📋 Choose a Template", wrap, [
    { label:"Cancel", primary:false, action: o => o.remove() }
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog: cella testo/numero
// ─────────────────────────────────────────────────────────────────────────────

function openTextCellEditor(col, currentValue, onConfirm) {
  const wrap      = document.createElement("div");
  const inputType = col.type === "int" || col.type === "float" ? "number" : "text";
  const valWrap   = inputField(`Value (${col.type})`, currentValue ?? "", inputType);
  const input     = valWrap.querySelector("input");
  if (col.type === "float") input.step = "any";
  wrap.appendChild(valWrap);
  createModal(`✏️ ${col.label}`, wrap, [
    { label:"Cancel",  primary:false, action: o => o.remove() },
    { label:"Confirm", primary:true,  action: overlay => { onConfirm(input.value); overlay.remove(); } }
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// DataManagerWidget
// ─────────────────────────────────────────────────────────────────────────────

class DataManagerWidget {
  constructor(node) {
    this.node       = node;
    this.payload    = readPayload(node);
    this._colWidths = {};
    this._imgCache  = {};  // url → Image | "loading" | "error"

    // ── Hit areas: aggiornate ogni draw(), usate in mouse() ────────────────
    // Coordinates RELATIVE TO WIDGET (posY=0 at top of widget).
    this._areas = {
      toolbar   : [],   // { key, x, y, w, h }
      headers   : [],   // { colId, x, y, w, h }
      cells     : [],   // { rowIdx, colId, col, x, y, w, h }
      delBtns   : [],   // { rowIdx, x, y, w, h }
      rowHandles: [],   // { rowIdx, x, y, w, h }  — drag handle per le righe
    };

    // ── Drag & drop state ────────────────────────────────────────────────────
    this._drag = null;
    // _drag = {
    //   type      : "col" | "row" | "resize"
    //   fromIdx   : number        (schema index, for col/row reorder)
    //   colId     : string|null   (for col reorder and resize)
    //   startX    : number        (mouse x at drag start, for resize)
    //   startW    : number        (column width at drag start, for resize)
    //   currentX  : number        (current mouse x)
    //   currentY  : number        (current mouse y)
    //   targetIdx : number        (computed drop target, for reorder)
    // }
  }

  get schema() { return this.payload.schema; }
  get rows()   { return this.payload.rows;   }
  get meta()   { return this.payload.meta;   }

  colWidth(id) { return this._colWidths[id] ?? COL_DEF_W; }

  requiredHeight() {
    return TOOLBAR_H + 6 + HEADER_H + this.rows.length * ROW_H + PADDING * 2 + 4;
  }

  commit() {
    // Persist column widths inside meta so they survive workflow save/reload
    this.payload.meta.col_widths = { ...this._colWidths };
    syncPayload(this.node, this.payload);
    this.node.graph?.setDirtyCanvas(true, true);
  }

  // ── Operazioni dati ───────────────────────────────────────────────────────

  addColumn(label, type, options = []) {
    const id = generateId();
    this.schema.push({ id, label, type, options });
    this.rows.forEach(r => { r[id] = null; });
    this.commit();
  }

  editColumn(id, label, type, options = []) {
    const c = this.schema.find(c => c.id === id);
    if (c) { c.label = label; c.type = type; c.options = options; this.commit(); }
  }

  deleteColumn(id) {
    this.payload.schema = this.schema.filter(c => c.id !== id);
    this.rows.forEach(r => { delete r[id]; });
    delete this._colWidths[id];
    this.commit();
  }

  addRow() {
    const row = {};
    this.schema.forEach(c => { row[c.id] = null; });
    this.rows.push(row);
    this.commit();
  }

  deleteRow(idx) {
    this.rows.splice(idx, 1);
    this.commit();
  }

  duplicateRow(idx) {
    if (!this.rows[idx]) return;
    // Deep clone via JSON round-trip to avoid shared object references
    const clone = JSON.parse(JSON.stringify(this.rows[idx]));
    this.rows.splice(idx + 1, 0, clone);
    this.commit();
  }

  setCellValue(rowIdx, colId, value) {
    const col = this.schema.find(c => c.id === colId);
    if (!col || !this.rows[rowIdx]) return;
    let v = value;
    if (col.type === "int")   v = (value !== "" && value !== null) ? parseInt(value, 10) : null;
    if (col.type === "float") v = (value !== "" && value !== null) ? parseFloat(value)   : null;
    this.rows[rowIdx][colId] = v;
    this.commit();
  }

  reorderColumn(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    // Adjust toIdx if moving right (element removed from left shifts target)
    const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
    const col = this.schema.splice(fromIdx, 1)[0];
    this.schema.splice(adjustedTo, 0, col);
    this.commit();
  }

  reorderRow(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
    const row = this.rows.splice(fromIdx, 1)[0];
    this.rows.splice(adjustedTo, 0, row);
    this.commit();
  }

  applyPreset(name, cols) {
    this.payload.schema = cols.map(c => ({ id: generateId(), label: c.label, type: c.type }));
    this.payload.rows   = [];
    this.meta.name      = name;
    this._colWidths     = {};
    this.commit();
  }

  exportCSV() {
    if (!this.schema.length) { alert("No columns defined."); return; }
    const hdrs  = this.schema.map(c => c.label);
    const lines = [hdrs.join(",")];
    this.rows.forEach(row => {
      const cells = this.schema.map(c => {
        let v = row[c.id];
        if (c.type === "image") v = normalizeImageValue(v)?.filename ?? "";
        const s = v != null ? String(v) : "";
        return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s;
      });
      lines.push(cells.join(","));
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type:"text/csv" }));
    a.download = (this.meta.name || "data-manager") + ".csv";
    a.click(); URL.revokeObjectURL(a.href);
  }

  importCSV() {
    const fi = document.createElement("input");
    fi.type = "file"; fi.accept = ".csv";
    fi.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const lines = ev.target.result.trim().split(/\r?\n/);
        if (!lines.length) return;
        const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g,"").trim());
        if (!this.schema.length)
          this.payload.schema = headers.map(h => ({ id:generateId(), label:h, type:"string" }));
        const l2id = {};
        this.schema.forEach(c => { l2id[c.label] = c.id; });
        this.payload.rows = lines.slice(1).map(line => {
          const cells = line.split(",").map(v => v.replace(/^"|"$/g,""));
          const row = {};
          this.schema.forEach(c => { row[c.id] = null; });
          headers.forEach((h,i) => { const cid = l2id[h]; if(cid) row[cid] = cells[i] ?? null; });
          return row;
        });
        this.commit();
      };
      reader.readAsText(file);
    };
    fi.click();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  //
  // IMPORTANTE: `posY` è la coordinata Y assoluta nel canvas del nodo dove
  // inizia il widget. Noi disegniamo tutto con coordinate (x, posY + offset).
  // Il mouse handler riceve pos[] RELATIVO AL NODO — quindi dobbiamo
  // confrontare my con (posY + offset), non solo con offset.
  // Salviamo _widgetY per usarlo in mouse().

  draw(ctx, node, widgetWidth, posY, height) {
    this._widgetY = posY;   // ← salva per il mouse handler
    const x = PADDING;
    const w = widgetWidth - PADDING * 2;

    // Widget background
    ctx.fillStyle = "#0e0e1a";
    ctx.beginPath();
    ctx.roundRect(x - 2, posY - 2, w + 4, height + 4, 6);
    ctx.fill();

    // Toolbar (posY locale = 0, assoluto = posY)
    this._drawToolbar(ctx, x, posY, w);

    // Grid
    const gridY = posY + TOOLBAR_H + 6;
    if (!this.schema.length) {
      ctx.fillStyle = "#444";
      ctx.font      = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Nessuna colonna — usa + Col o scegli un Preset", x + w / 2, gridY + 28);
    } else {
      this._drawGrid(ctx, x, gridY, w);
    }
    ctx.textAlign = "left";
  }

  _drawToolbar(ctx, x, y, w) {
    ctx.fillStyle = "#1a1a30";
    ctx.beginPath(); ctx.roundRect(x, y, w, TOOLBAR_H, 5); ctx.fill();

    const btns = [
      { label:"+ Col",    color:"#2e6fd4", key:"addCol"    },
      { label:"+ Row",   color:"#2e8f4a", key:"addRow"    },
      { label:"📋 Preset", color:"#7a3ea8", key:"preset"    },
      { label:"⬆ CSV",    color:"#8f6a2e", key:"importCSV" },
      { label:"⬇ CSV",    color:"#3e8f8a", key:"exportCSV" },
    ];

    this._areas.toolbar = [];
    let bx = x + 6;
    const by = y + 5, bh = TOOLBAR_H - 10;

    btns.forEach(btn => {
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(btn.label).width + 14;
      ctx.fillStyle = btn.color;
      ctx.beginPath(); ctx.roundRect(bx, by, tw, bh, 4); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      ctx.fillText(btn.label, bx + tw / 2, by + bh / 2 + 4);
      this._areas.toolbar.push({ key:btn.key, x:bx, y:by, w:tw, h:bh });
      bx += tw + 5;
    });

    ctx.fillStyle = "#444"; ctx.font = "italic 10px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(this.meta.name || "Untitled", x + w - 6, y + TOOLBAR_H / 2 + 4);
  }

  _drawGrid(ctx, x, y, w) {
    const IDX_W = 32;
    this._areas.headers      = [];
    this._areas.resizeHandles = [];
    this._areas.cells         = [];
    this._areas.delBtns       = [];
    this._areas.dupBtns       = [];
    this._areas.audioBtns     = [];
    this._areas.rowHandles    = [];

    // ── Header ─────────────────────────────────────────────────────────────
    let cx = x + IDX_W;
    ctx.fillStyle = "#1e1e38"; ctx.fillRect(x, y, IDX_W, HEADER_H);
    ctx.fillStyle = "#666"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("#", x + IDX_W / 2, y + HEADER_H / 2 + 4);

    this.schema.forEach(col => {
      const cw = this.colWidth(col.id);
      const DRAG_W = 14;  // width of the drag handle zone on the left
      ctx.fillStyle = "#1e1e38"; ctx.fillRect(cx, y, cw, HEADER_H);
      ctx.fillStyle = TYPE_COLORS[col.type] ?? "#888"; ctx.fillRect(cx, y, cw, 3);
      // Drag handle ⠿ — left strip, same style as row handles
      ctx.fillStyle = "#3a3a5a";
      ctx.font = "11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⠿", cx + DRAG_W / 2, y + HEADER_H / 2 + 4);
      // Column label — starts after drag handle
      ctx.fillStyle = "#ddd"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
      ctx.save(); ctx.beginPath(); ctx.rect(cx + DRAG_W + 3, y + 3, cw - DRAG_W - 52, HEADER_H - 3); ctx.clip();
      ctx.fillText(col.label, cx + DRAG_W + 3, y + HEADER_H / 2 + 4); ctx.restore();
      // Type badge — shifted left to make room for resize handle (RESIZE_W = 8px)
      const RW = 8;  // same as RESIZE_W above
      ctx.fillStyle = (TYPE_COLORS[col.type] ?? "#888") + "44";
      ctx.beginPath(); ctx.roundRect(cx + cw - 48 - RW, y + 9, 23, 13, 3); ctx.fill();
      ctx.fillStyle = "#ddd"; ctx.font = "8px monospace"; ctx.textAlign = "center";
      ctx.fillText(col.type.slice(0,3), cx + cw - 36 - RW, y + 19);
      // × button to delete column — shifted left by RW
      ctx.fillStyle = "#6e1818";
      ctx.beginPath(); ctx.roundRect(cx + cw - 20 - RW, y + 8, 14, HEADER_H - 16, 3); ctx.fill();
      ctx.fillStyle = "#faa"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("×", cx + cw - 13 - RW, y + HEADER_H / 2 + 3);
      // Resize handle — 6px strip on right edge of header, highlighted
      // Layout (left → right): ⠿ drag | label | type badge | × delete | ↔ resize
      const BAND_H    = 3;    // colour band at top
      const RESIZE_W  = 8;    // resize handle width on the far right
      const RESIZE_PAD = 2;   // gap between × and resize handle
      const DEL_W     = 20;   // × button zone width (matches rendering below)

      // Resize handle — rightmost strip, below the colour band
      const rHandleX = cx + cw - RESIZE_W;
      const rHandleY = y + BAND_H + 2;
      const rHandleH = HEADER_H - BAND_H - 4;
      const isResizing = this._drag?.type === "resize" && this._drag?.colId === col.id;
      ctx.fillStyle = isResizing ? "#4a9eff" : "#2e2e50";
      ctx.beginPath(); ctx.roundRect(rHandleX + 1, rHandleY, RESIZE_W - 2, rHandleH, 2); ctx.fill();
      ctx.fillStyle = isResizing ? "#fff" : "#666";
      ctx.font = "7px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("↔", rHandleX + RESIZE_W / 2, rHandleY + rHandleH / 2 + 3);

      // Divider line (column boundary)
      ctx.strokeStyle = "#2a2a42"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx+cw, y); ctx.lineTo(cx+cw, y + HEADER_H + this.rows.length * ROW_H); ctx.stroke();

      // Hit areas
      this._areas.resizeHandles.push({ colId:col.id, x: rHandleX, y, w: RESIZE_W, h: HEADER_H });
      // Header click area excludes the resize strip on the right
      this._areas.headers.push({ colId:col.id, x:cx, y, w:cw - RESIZE_W, h:HEADER_H, dragW:DRAG_W });
      cx += cw;
    });

    // Line below header
    ctx.strokeStyle = "#3a3a5a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + HEADER_H); ctx.lineTo(cx + 26, y + HEADER_H); ctx.stroke();

    // ── Righe dati ─────────────────────────────────────────────────────────
    this.rows.forEach((row, ri) => {
      const ry = y + HEADER_H + ri * ROW_H;
      ctx.fillStyle = ri % 2 === 0 ? "#131320" : "#171728";
      ctx.fillRect(x, ry, cx - x + 26, ROW_H);

      // Row index cell background
      ctx.fillStyle = ri % 2 === 0 ? "#0e0e1c" : "#12121f";
      ctx.fillRect(x, ry, IDX_W, ROW_H);

      // Drag handle (top half) + row number (bottom half)
      const handleH = Math.floor(ROW_H / 2);
      ctx.fillStyle = "#3a3a5a";
      ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⠿", x + IDX_W / 2, ry + handleH / 2 + 4);
      ctx.fillStyle = "#555"; ctx.font = "9px monospace";
      ctx.fillText(ri + 1, x + IDX_W / 2, ry + handleH + handleH / 2 + 3);

      // Register row handle hit area (top half of index cell)
      this._areas.rowHandles.push({ rowIdx: ri, x, y: ry, w: IDX_W, h: handleH });

      let cellX = x + IDX_W;
      this.schema.forEach(col => {
        const cw  = this.colWidth(col.id);
        const val = row[col.id];

        if (col.type === "image") {
          this._drawImageCell(ctx, cellX, ry, cw, ROW_H, val);
        } else if (col.type === "audio") {
          this._drawAudioCell(ctx, cellX, ry, cw, ROW_H, val);
        } else if (col.type === "video") {
          this._drawVideoCell(ctx, cellX, ry, cw, ROW_H, val);
        } else if (col.type === "boolean") {
          this._drawBoolCell(ctx, cellX, ry, cw, ROW_H, val);
        } else if (col.type === "select") {
          this._drawSelectCell(ctx, cellX, ry, cw, ROW_H, val, col.options ?? []);
        } else {
          const txt = val != null ? String(val) : "";
          ctx.fillStyle = txt ? "#ccc" : "#383858";
          ctx.font = "11px sans-serif"; ctx.textAlign = "left";
          ctx.save(); ctx.beginPath(); ctx.rect(cellX+4, ry+1, cw-8, ROW_H-2); ctx.clip();
          ctx.fillText(txt || "—", cellX + 4, ry + ROW_H / 2 + 4); ctx.restore();
        }

        ctx.strokeStyle = "#1e1e38"; ctx.lineWidth = 0.5;
        ctx.strokeRect(cellX, ry, cw, ROW_H);
        this._areas.cells.push({ rowIdx:ri, colId:col.id, col, x:cellX, y:ry, w:cw, h:ROW_H });
        cellX += cw;
      });

      // Buttons stacked vertically: ⧉ (top) and × (bottom)
      const btnX   = cellX + 4;
      const gap    = 3;
      const btnH   = (ROW_H - gap) / 2 - 3;  // ~22px each
      const dupBy  = ry + 3;
      const delBy  = dupBy + btnH + gap;

      // ⧉ duplicate
      ctx.fillStyle = "#1e3a2e";
      ctx.beginPath(); ctx.roundRect(btnX, dupBy, 18, btnH, 3); ctx.fill();
      ctx.fillStyle = "#4affd4"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⧉", btnX + 9, dupBy + btnH / 2 + 4);
      this._areas.dupBtns.push({ rowIdx:ri, x:btnX, y:dupBy, w:18, h:btnH });

      // × delete
      ctx.fillStyle = "#6e1818";
      ctx.beginPath(); ctx.roundRect(btnX, delBy, 18, btnH, 3); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("×", btnX + 9, delBy + btnH / 2 + 4);
      this._areas.delBtns.push({ rowIdx:ri, x:btnX, y:delBy, w:18, h:btnH });
    });

    ctx.strokeStyle = "#3a3a5a"; ctx.lineWidth = 1;
    ctx.strokeRect(x, y, cx - x + 26, HEADER_H + this.rows.length * ROW_H);

    // ── Drag indicator ───────────────────────────────────────────────────────
    if (this._drag) {
      const d = this._drag;
      ctx.save();
      if (d.type === "col") {
        // Vertical drop line between columns
        let lineX = x + 32; // IDX_W
        let colX  = x + 32;
        let target = 0;
        for (let i = 0; i < this.schema.length; i++) {
          const cw = this.colWidth(this.schema[i].id);
          if (d.currentX > colX + cw / 2) { lineX = colX + cw; target = i + 1; }
          colX += cw;
        }
        d.targetIdx = target;
        ctx.strokeStyle = "#4a9eff";
        ctx.lineWidth   = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(lineX, y);
        ctx.lineTo(lineX, y + HEADER_H + this.rows.length * ROW_H);
        ctx.stroke();
        // Dragged header ghost
        const dragCol = this.schema[d.fromIdx];
        if (dragCol) {
          ctx.fillStyle = "rgba(74,158,255,0.25)";
          ctx.fillRect(d.currentX - this.colWidth(dragCol.id)/2, y,
                       this.colWidth(dragCol.id), HEADER_H);
        }
      } else {
        // Horizontal drop line between rows
        let lineY  = y + HEADER_H;
        let target = 0;
        for (let i = 0; i < this.rows.length; i++) {
          if (d.currentY > y + HEADER_H + i * ROW_H + ROW_H / 2) {
            lineY  = y + HEADER_H + (i + 1) * ROW_H;
            target = i + 1;
          }
        }
        d.targetIdx = target;
        ctx.strokeStyle = "#4aff9f";
        ctx.lineWidth   = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, lineY);
        ctx.lineTo(cx + 26, lineY);
        ctx.stroke();
        // Dragged row ghost
        const ghostY = y + HEADER_H + d.fromIdx * ROW_H;
        ctx.fillStyle = "rgba(74,255,159,0.15)";
        ctx.fillRect(x, ghostY, cx - x + 26, ROW_H);
      }
      ctx.restore();
    }
  }

  // ── Cella image: mostra thumbnail inline ───────────────────────────────

  _drawImageCell(ctx, x, y, w, h, val) {
    const imgVal = normalizeImageValue(val);
    const pad    = 3;
    const th     = h - pad * 2;   // thumbnail quadrata, altezza cella - padding

    if (!imgVal) {
      // Empty slot: centered icon
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      ctx.font = "18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("＋", x + w / 2, y + h / 2 + 6);
      ctx.fillStyle = "#383858"; ctx.font = "8px sans-serif";
      ctx.fillText("image", x + w / 2, y + h - 5);
      return;
    }

    const url = imageViewUrl(imgVal);

    if (!this._imgCache[url]) {
      this._imgCache[url] = "loading";
      const img = new Image();
      img.onload  = () => { this._imgCache[url] = img;     this.node.graph?.setDirtyCanvas(true); };
      img.onerror = () => { this._imgCache[url] = "error"; this.node.graph?.setDirtyCanvas(true); };
      img.src = url;
    }

    const cached = this._imgCache[url];

    if (cached === "loading") {
      ctx.fillStyle = "#1a1a2e"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.fillStyle = "#555"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⟳", x + w / 2, y + h / 2 + 5);
      return;
    }

    if (cached === "error") {
      ctx.fillStyle = "#2a1010"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.fillStyle = "#f55"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("✗ " + imgVal.filename, x + w / 2, y + h / 2 + 4);
      return;
    }

    // ── Thumbnail: crop centrato (object-fit:cover su canvas) ───────────────
    // The thumbnail is always a th×th square.
    // Calcoliamo src x/y/w/h per ritagliare la parte centrale dell'image
    // without distortion, exactly like CSS object-fit:cover.
    const iw = cached.naturalWidth  || cached.width;
    const ih = cached.naturalHeight || cached.height;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (iw > 0 && ih > 0) {
      const srcRatio = iw / ih;
      if (srcRatio > 1) {
        // image più larga che alta: ritaglia i lati
        sw = ih;
        sx = (iw - sw) / 2;
      } else {
        // image più alta che larga: ritaglia sopra e sotto
        sh = iw;
        sy = (ih - sh) / 2;
      }
    }

    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + pad, y + pad, th, th, 3); ctx.clip();
    ctx.drawImage(cached, sx, sy, sw, sh, x + pad, y + pad, th, th);
    ctx.restore();

    // Filename to the right of the thumbnail
    ctx.fillStyle = "#bbb"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    ctx.save(); ctx.beginPath(); ctx.rect(x + pad + th + 5, y, w - th - pad*2 - 5, h); ctx.clip();
    ctx.fillText(imgVal.filename, x + pad + th + 6, y + h / 2 + 4); ctx.restore();

    // Indicatore "click per cambiare"
    ctx.fillStyle = "#2a2a4a"; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("✎", x + w - 4, y + h - 4);
  }

  // ── Audio cell: play/stop button + duration ──────────────────────────────

  _drawAudioCell(ctx, x, y, w, h, val) {
    const audioVal = normalizeAudioValue(val);
    const pad     = 4;
    const btnSize = 28;   // fixed small square button — leaves room for duration

    if (!audioVal) {
      ctx.fillStyle = "#1a1a2e"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.font = "18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("🎵", x + w/2, y + h/2 + 6);
      ctx.fillStyle = "#383858"; ctx.font = "8px sans-serif";
      ctx.fillText("audio", x + w/2, y + h - 5);
      return;
    }

    const url     = audioViewUrl(audioVal);
    const playing = audioIsPlaying(url);

    // Background
    ctx.fillStyle = playing ? "#1a0e2e" : "#111120";
    ctx.fillRect(x+1, y+1, w-2, h-2);

    // Play/Stop button — vertically centered, fixed size
    const bx = x + pad;
    const by = y + (h - btnSize) / 2;
    ctx.fillStyle = playing ? "#ff4a7a" : "#3a2a4e";
    ctx.beginPath(); ctx.roundRect(bx, by, btnSize, btnSize, 5); ctx.fill();

    // Button icon
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(playing ? "⏹" : "▶", bx + btnSize / 2, by + btnSize / 2 + 5);

    // Duration — to the right of the button.
    // loadAudioDuration queues a redraw callback; once metadata loads
    // the cache is populated and the next draw() shows the real value.
    if (_durationCache[url] === undefined) {
      loadAudioDuration(url, () => this.node.graph?.setDirtyCanvas(true));
    }
    const dur = _durationCache[url] ?? "--:--";
    ctx.fillStyle = playing ? "#ff8aaa" : "#aaa";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(dur, bx + btnSize + 8, y + h / 2 + 4);

    // Register play button hit area
    if (!this._areas.audioBtns) this._areas.audioBtns = [];
    this._areas.audioBtns.push({ url, x: bx, y: by, w: btnSize, h: btnSize });
  }

  // ── Video cell: thumbnail + play icon overlay ───────────────────────────

  _drawVideoCell(ctx, x, y, w, h, val) {
    const videoVal = normalizeVideoValue(val);
    const pad      = 3;
    const th       = h - pad * 2;   // thumbnail square

    if (!videoVal) {
      ctx.fillStyle = "#1a1a1e"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.font = "18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("🎬", x + w/2, y + h/2 + 6);
      ctx.fillStyle = "#383838"; ctx.font = "8px sans-serif";
      ctx.fillText("video", x + w/2, y + h - 5);
      return;
    }

    const thumbUrl = videoThumbUrl(videoVal);

    // Reuse image cache infrastructure for thumbnails
    if (!this._imgCache[thumbUrl]) {
      this._imgCache[thumbUrl] = "loading";
      const img = new Image();
      img.onload  = () => { this._imgCache[thumbUrl] = img;     this.node.graph?.setDirtyCanvas(true); };
      img.onerror = () => { this._imgCache[thumbUrl] = "error"; this.node.graph?.setDirtyCanvas(true); };
      img.src = thumbUrl;
    }

    const cached = this._imgCache[thumbUrl];

    if (cached === "loading") {
      ctx.fillStyle = "#1a1a2e"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.fillStyle = "#555"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⟳", x + w/2, y + h/2 + 5);
      return;
    }

    if (cached === "error") {
      // No thumbnail available — show icon + filename
      ctx.fillStyle = "#1a1010"; ctx.fillRect(x+1, y+1, w-2, h-2);
      ctx.font = "18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("🎬", x + pad + th/2, y + h/2 + 6);
      ctx.fillStyle = "#aaa"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.save(); ctx.beginPath(); ctx.rect(x + pad + th + 5, y, w - th - pad*2 - 5, h); ctx.clip();
      ctx.fillText(videoVal.filename, x + pad + th + 6, y + h/2 + 4); ctx.restore();
      return;
    }

    // Draw thumbnail with centered crop (object-fit:cover)
    const iw = cached.naturalWidth  || cached.width;
    const ih = cached.naturalHeight || cached.height;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (iw > 0 && ih > 0) {
      if (iw / ih > 1) { sw = ih; sx = (iw - sw) / 2; }
      else             { sh = iw; sy = (ih - sh) / 2; }
    }
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + pad, y + pad, th, th, 3); ctx.clip();
    ctx.drawImage(cached, sx, sy, sw, sh, x + pad, y + pad, th, th);
    ctx.restore();

    // Play icon overlay on thumbnail
    const cx_ = x + pad + th / 2, cy_ = y + pad + th / 2, r = th * 0.22;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath(); ctx.arc(cx_, cy_, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(r)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("▶", cx_ + r * 0.1, cy_ + r * 0.38);

    // Filename to the right
    ctx.fillStyle = "#bbb"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    ctx.save(); ctx.beginPath(); ctx.rect(x + pad + th + 5, y, w - th - pad*2 - 5, h); ctx.clip();
    ctx.fillText(videoVal.filename, x + pad + th + 6, y + h/2 + 4); ctx.restore();

    // Edit hint
    ctx.fillStyle = "#2a2a4a"; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("✎", x + w - 4, y + h - 4);
  }

  // ── Boolean cell: checkbox rendering ────────────────────────────────────

  _drawBoolCell(ctx, x, y, w, h, val) {
    const checked = val === true || val === "true" || val === 1;
    const size    = Math.min(h - 10, 22);
    const bx      = x + (w - size) / 2;
    const by      = y + (h - size) / 2;

    // Cell background
    ctx.fillStyle = checked ? "#0e2a1e" : "#111120";
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

    // Checkbox border
    ctx.strokeStyle = checked ? "#4affd4" : "#3a3a5a";
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.roundRect(bx, by, size, size, 4); ctx.stroke();

    // Checkmark
    if (checked) {
      ctx.strokeStyle = "#4affd4";
      ctx.lineWidth   = 2.5;
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";
      ctx.beginPath();
      ctx.moveTo(bx + size * 0.2, by + size * 0.5);
      ctx.lineTo(bx + size * 0.42, by + size * 0.72);
      ctx.lineTo(bx + size * 0.8, by + size * 0.28);
      ctx.stroke();
    }
  }

  // ── Select cell: dropdown-style rendering ───────────────────────────────

  _drawSelectCell(ctx, x, y, w, h, val, options) {
    const hasVal = val !== null && val !== undefined && val !== "";
    const pad    = 6;

    // Background
    ctx.fillStyle = hasVal ? "#1a1a10" : "#111120";
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

    // Selected value text
    ctx.fillStyle = hasVal ? "#ffd44a" : "#3a3a30";
    ctx.font      = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + pad, y, w - pad * 2 - 16, h);
    ctx.clip();
    ctx.fillText(hasVal ? String(val) : "— select —", x + pad, y + h / 2 + 4);
    ctx.restore();

    // Dropdown arrow
    ctx.fillStyle = "#ffd44a";
    ctx.font      = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("▾", x + w - 10, y + h / 2 + 3);
  }

  // ── Mouse handler ─────────────────────────────────────────────────────────
  //
  // pos[] è RELATIVO AL NODO in LiteGraph.
  // _widgetY è la Y assoluta (nel nodo) dove inizia il widget, salvata in draw().
  // Quindi: coordinata locale nel widget = pos[1] - _widgetY
  // Le _areas sono salvate con coordinate assolute nel nodo (y = posY + offset).
  // Confrontiamo direttamente pos[] con le _areas (che usano y assoluta).

  mouse(event, pos, node) {
    const mx = pos[0];
    const my = pos[1];

    const hit = (area) =>
      mx >= area.x && mx <= area.x + area.w &&
      my >= area.y && my <= area.y + area.h;

    // ── Drag move ─────────────────────────────────────────────────────────────
    if (event.type === "pointermove" && this._drag) {
      this._drag.currentX = mx;
      this._drag.currentY = my;
      if (this._drag.type === "resize") {
        const delta = mx - this._drag.startX;
        const newW  = Math.max(60, this._drag.startW + delta);
        this._colWidths[this._drag.colId] = newW;
        // Write through to payload so the width is included in the next save
        this.payload.meta.col_widths = { ...this._colWidths };
        syncPayload(this.node, this.payload);
      }
      this.node.graph?.setDirtyCanvas(true);
      return true;
    }

    // ── Drag end ──────────────────────────────────────────────────────────────
    if (event.type === "pointerup" && this._drag) {
      const d = this._drag;
      this._drag = null;
      if (d.type === "col" && d.targetIdx !== undefined) {
        this.reorderColumn(d.fromIdx, d.targetIdx);
      } else if (d.type === "row" && d.targetIdx !== undefined) {
        this.reorderRow(d.fromIdx, d.targetIdx);
      }
      // "resize" needs no extra action — width already updated live
      this.node.graph?.setDirtyCanvas(true);
      return true;
    }

    if (event.type !== "pointerdown") return false;

    // Toolbar
    for (const btn of this._areas.toolbar) {
      if (hit(btn)) { this._handleToolbar(btn.key); return true; }
    }

    // Resize handles — checked before headers so the 6px strip takes priority
    for (const rh of this._areas.resizeHandles ?? []) {
      if (hit(rh)) {
        this._drag = {
          type   : "resize",
          colId  : rh.colId,
          startX : mx,
          startW : this.colWidth(rh.colId),
        };
        return true;
      }
    }

    // Column headers: drag on left portion, × on right, click in middle = edit
    for (const ch of this._areas.headers) {
      if (hit(ch)) {
        // × zone — last 20px: delete
        if (mx >= ch.x + ch.w - 20) {
          if (confirm(`Delete column "${this.schema.find(c=>c.id===ch.colId)?.label}"?`))
            this.deleteColumn(ch.colId);
          return true;
        }
        // Drag zone — the ⠿ handle strip on the left
        if (mx <= ch.x + (ch.dragW ?? 14)) {
          const fromIdx = this.schema.findIndex(c => c.id === ch.colId);
          if (fromIdx >= 0) {
            this._drag = { type:"col", fromIdx, colId:ch.colId,
                           currentX:mx, currentY:my, targetIdx:fromIdx };
          }
          return true;
        }
        // Middle zone: edit column
        this._openEditColumn(ch.colId);
        return true;
      }
    }

    // Row drag handles (top half of index column)
    for (const rh of this._areas.rowHandles ?? []) {
      if (hit(rh)) {
        this._drag = { type:"row", fromIdx:rh.rowIdx,
                       currentX:mx, currentY:my, targetIdx:rh.rowIdx };
        return true;
      }
    }

    // Row duplicate buttons
    for (const db of this._areas.dupBtns ?? []) {
      if (hit(db)) {
        this.duplicateRow(db.rowIdx);
        return true;
      }
    }

    // Row delete buttons
    for (const db of this._areas.delBtns) {
      if (hit(db)) {
        if (confirm(`Delete row ${db.rowIdx + 1}?`)) this.deleteRow(db.rowIdx);
        return true;
      }
    }

    // Audio play buttons (checked before cells to allow play without opening picker)
    for (const ab of this._areas.audioBtns ?? []) {
      if (hit(ab)) {
        audioToggle(ab.url, () => this.node.graph?.setDirtyCanvas(true));
        return true;
      }
    }

    // Cells
    for (const cell of this._areas.cells) {
      if (hit(cell)) {
        const curVal = this.rows[cell.rowIdx]?.[cell.colId];
        if (cell.col.type === "image") {
          openImagePicker(curVal, newVal => {
            this.setCellValue(cell.rowIdx, cell.colId, newVal);
          });
        } else if (cell.col.type === "audio") {
          openAudioPicker(curVal, newVal => {
            this.setCellValue(cell.rowIdx, cell.colId, newVal);
          });
        } else if (cell.col.type === "video") {
          openVideoPicker(curVal, newVal => {
            this.setCellValue(cell.rowIdx, cell.colId, newVal);
          });
        } else if (cell.col.type === "boolean") {
          // Toggle directly on click — no dialog needed
          const current = curVal === true || curVal === "true" || curVal === 1;
          this.setCellValue(cell.rowIdx, cell.colId, !current);
        } else if (cell.col.type === "select") {
          openSelectPicker(cell.col, curVal, newVal => {
            this.setCellValue(cell.rowIdx, cell.colId, newVal);
          });
        } else {
          openTextCellEditor(cell.col, curVal, newVal => {
            this.setCellValue(cell.rowIdx, cell.colId, newVal);
          });
        }
        return true;
      }
    }

    return false;
  }

  _handleToolbar(key) {
    switch (key) {
      case "addCol":
        openColumnDialog(null, ({label,type,options}) => this.addColumn(label,type,options)); break;
      case "addRow":
        if (!this.schema.length) alert("Add at least one column first.");
        else this.addRow();
        break;
      case "preset":
        openPresetDialog((name,cols) => {
          if (this.rows.length && !confirm("Applying this preset will delete existing data. Continue?")) return;
          this.applyPreset(name,cols);
        });
        break;
      case "importCSV": this.importCSV(); break;
      case "exportCSV": this.exportCSV(); break;
    }
  }

  _showColMenu(colId, mx, my) {
    document.getElementById("dm-col-menu")?.remove();
    const col = this.schema.find(c => c.id === colId); if (!col) return;
    const menu = document.createElement("div");
    menu.id = "dm-col-menu";
    menu.style.cssText = `position:fixed;background:#1e1e2e;border:1px solid #444;
      border-radius:7px;padding:4px 0;z-index:9998;min-width:160px;
      box-shadow:0 4px 16px rgba(0,0,0,.5);font-family:sans-serif;`;
    const ds   = this.node.graph.canvas.ds;
    const rect = this.node.graph.canvas.canvas.getBoundingClientRect();
    menu.style.left = ((this.node.pos[0]+mx)*ds.scale+ds.offset[0]+rect.left)+"px";
    menu.style.top  = ((this.node.pos[1]+my)*ds.scale+ds.offset[1]+rect.top) +"px";
    [
      { label:`✏️ Edit "${col.label}"`, action:()=> this._openEditColumn(colId) },
      { label:"🗑️ Elimina colonna",         action:()=> { if(confirm(`Delete "${col.label}"?`)) this.deleteColumn(colId); } },
    ].forEach(item => {
      const el = document.createElement("div");
      el.textContent = item.label;
      el.style.cssText = "padding:8px 16px;cursor:pointer;font-size:12px;color:#ddd;";
      el.onmouseenter = ()=> el.style.background="#2e2e4e";
      el.onmouseleave = ()=> el.style.background="transparent";
      el.onclick = ()=> { item.action(); menu.remove(); };
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    setTimeout(()=> document.addEventListener("click", ()=> menu.remove(), {once:true}), 10);
  }

  _openEditColumn(colId) {
    const col = this.schema.find(c => c.id === colId);
    if (col) openColumnDialog(col, ({label,type,options}) => this.editColumn(colId,label,type,options));
  }

  computeSize(width) {
    return [width, this.requiredHeight()];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrazione ComfyUI
// ─────────────────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "DataManager.GridWidget",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "DataManagerNode") return;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);

      // grid_data è il widget STRING che porta i dati nel workflow JSON.
      // Lo rendiamo invisibile e non interattivo, ma PRESERVIAMO la
      // serializzazione: ComfyUI salva widgets_values in ordine posizionale,
      // quindi grid_data deve restare nell'array e rispondere a serialize().
      const gd = this.widgets?.find(w => w.name === "grid_data");
      if (gd) {
        gd.computeSize    = () => [0, -4];
        gd.draw           = () => {};
        gd.mouse          = () => false;
        // serializeValue è il metodo che ComfyUI chiama per raccogliere il valore
        // da mettere in widgets_values[]. Deve restituire il JSON corrente.
        gd.serializeValue = async () => gd.value ?? "{}";
      }

      const dmWidget = new DataManagerWidget(this);

      const customW = {
        name        : "dm_grid",
        type        : "dm_grid",
        draw        : (ctx, node, w, y, h) => dmWidget.draw(ctx, node, w, y, h),
        mouse       : (e, pos, node)        => dmWidget.mouse(e, pos, node),
        computeSize : (w)                   => dmWidget.computeSize(w),
        // serialize:false esclude dm_grid da widgets_values (corretto:
        // i dati viaggiano solo attraverso grid_data).
        serialize   : false,
        dmRef       : dmWidget,
      };

      this.addCustomWidget(customW);

      // NON spostiamo dm_grid in testa: ComfyUI serializza widgets_values
      // nell'ordine originale del backend, spostare i widget rompe il mapping.
      // Per intercettare i click prima degli altri widget usiamo onMouseDown
      // sul nodo stesso, che viene chiamato prima del dispatch ai widget.
      const self = this;
      const NODE_HEADER = 30;

      // Helper to translate node-relative pos to widget-relative pos
      function localPos(pos) { return [pos[0], pos[1] - NODE_HEADER]; }

      function getDmWidget() {
        return self.widgets?.find(w => w.name === "dm_grid")?.dmRef ?? null;
      }

      // onMouseDown — handles pointerdown (and drag move/up via LiteGraph hooks)
      const origMouseDown = this.onMouseDown;
      this.onMouseDown = function(event, pos, graphCanvas) {
        const dm = getDmWidget();
        if (dm) {
          const handled = dm.mouse(event, localPos(pos), self);
          if (handled) return true;
        }
        return origMouseDown?.apply(this, arguments);
      };

      // onMouseMove — forwards pointermove to dmWidget so drag indicator updates
      const origMouseMove = this.onMouseMove;
      this.onMouseMove = function(event, pos, graphCanvas) {
        const dm = getDmWidget();
        if (dm?._drag) {
          dm.mouse(event, localPos(pos), self);
          return true;
        }
        return origMouseMove?.apply(this, arguments);
      };

      // onMouseUp — commits the drag on pointer release
      const origMouseUp = this.onMouseUp;
      this.onMouseUp = function(event, pos, graphCanvas) {
        const dm = getDmWidget();
        if (dm?._drag) {
          dm.mouse(event, localPos(pos), self);
          return true;
        }
        return origMouseUp?.apply(this, arguments);
      };

      this.size = [600, 360];
      this.setDirtyCanvas(true, true);
    };

    // configure() viene chiamato quando ComfyUI carica un workflow salvato.
    // A questo punto onNodeCreated è già stato chiamato, quindi dm_grid esiste.
    // origConfigure ripristina widgets_values → grid_data.value contiene il JSON.
    // Noi lo leggiamo e lo passiamo al dmWidget.
    const origConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (data) {
      origConfigure?.apply(this, arguments);

      // widgets_values è ora applicato: grid_data.value ha il JSON salvato.
      // Lo passiamo subito al widget visuale tramite un microtask, per
      // assicurarci che LiteGraph abbia finito il suo configure interno.
      const node = this;
      Promise.resolve().then(() => {
        const gd = node.widgets?.find(w => w.name === "grid_data");
        const cw = node.widgets?.find(w => w.name === "dm_grid");
        if (!cw?.dmRef || !gd?.value) return;
        try {
          const parsed = JSON.parse(gd.value);
          // Sanity check: deve avere schema e rows
          if (!Array.isArray(parsed.schema) || !Array.isArray(parsed.rows)) return;
          cw.dmRef.payload    = parsed;
          // Restore persisted column widths from meta
          cw.dmRef._colWidths = (parsed.meta?.col_widths && typeof parsed.meta.col_widths === "object")
            ? { ...parsed.meta.col_widths }
            : {};
          cw.dmRef._imgCache  = {};
          // Ridimensiona il nodo in base ai dati caricati
          node.size[1] = cw.dmRef.requiredHeight() + 120;
          node.setDirtyCanvas?.(true, true);
        } catch {
          // JSON malformato — lascia il payload vuoto corrente
        }
      });
    };
  },
});
