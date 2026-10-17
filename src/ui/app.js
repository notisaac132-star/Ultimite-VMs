// The Ultimate VMs menu: VM cards, the New VM wizard and VM settings. Talks to main.js through window.vmApi.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const gb = (mb) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;

let state = null; // { host, root, engines, catalog, vms }
const vms = new Map();
const osById = (id) => state.catalog.find((o) => o.id === id);

// ---------- VM cards ----------

function render() {
  const list = [...vms.values()].sort((a, b) => (b.lastRun || b.createdAt) - (a.lastRun || a.createdAt));
  $("#vm-grid").innerHTML = list.map(card).join("");
  $("#vm-count").textContent = list.length ? `${list.length} VM${list.length === 1 ? "" : "s"}` : "";
  $("#empty").hidden = list.length > 0;
  $(".section-head").hidden = list.length === 0;
  $("#slow").hidden = !(state.host.platform === "win32" && list.some((v) => v.slow) && !slowDismissed);
  // Cards redraw on every progress update; keep an open ⋯ menu open.
  if (openMenu) {
    const listEl = document.querySelector(`[data-id="${CSS.escape(openMenu)}"] .menu-list`);
    if (listEl) listEl.hidden = false;
  }
}

function card(vm) {
  const os = osById(vm.osId) || { name: "Other", logo: "disc" };
  const statusText = { running: "Running", busy: "Setting up", stopped: "Off", unfinished: "Not set up" }[vm.status];
  const job = vm.job
    ? `<div class="job"><span>${esc(vm.job.label)}</span>
         <div class="bar ${vm.job.progress == null ? "indeterminate" : ""}"><i style="width:${Math.round((vm.job.progress || 0) * 100)}%"></i></div></div>`
    : "";
  const error = vm.error ? `<pre class="note error">${esc(vm.error)}</pre>` : "";

  let primary;
  if (vm.status === "running") primary = `<button class="btn danger" data-act="stop">Shut down</button>`;
  else if (vm.status === "busy") primary = `<button class="btn ghost" data-act="cancel">Cancel</button>`;
  else if (vm.status === "unfinished") {
    primary = `<button class="btn primary" data-act="prepare">Resume setup</button>`;
    if (vm.error && !vm.iso && os.source?.page) {
      primary += `<button class="btn ghost" data-act="vendor">Microsoft's site ↗</button><button class="btn ghost" data-act="insert">Choose ISO…</button>`;
    }
  }
  else primary = `<button class="btn primary" data-act="start">▶ Start</button>`;

  const hint = vm.status === "running" && vm.iso && !vm.installed
    ? `<p class="hint">Installing? Follow the steps in the VM's window${vm.family === "windows" ? " (no product key? click <b>“I don't have a product key”</b>)" : ""}. When the OS is installed, shut down and click <b>⋯ → Eject disc</b>.</p>`
    : "";

  return `
  <article class="vm-card status-${vm.status}" data-id="${esc(vm.id)}">
    <div class="vm-top">
      ${osLogo(os.logo, 52)}
      <div class="vm-title">
        <h3>${esc(vm.name)}</h3>
        <span class="muted">${esc(os.name)}</span>
      </div>
      <span class="pill">${statusText}</span>
    </div>
    <div class="chips">
      <span>${vm.cpus} CPU${vm.cpus === 1 ? "" : "s"}</span><span>${gb(vm.memoryMB)} RAM</span><span>${vm.diskGB} GB disk</span>
      ${vm.iso ? `<span title="${esc(vm.iso)}">💿 disc in</span>` : ""}
    </div>
    ${job}${error}${hint}
    <div class="vm-actions">
      ${primary}
      ${vm.status === "running" ? `<button class="btn ghost" data-act="force" title="Like pulling the power cord">Force stop</button>` : ""}
      <span class="spacer"></span>
      <div class="menu">
        <button class="icon-btn" data-act="menu" aria-label="More">⋯</button>
        <div class="menu-list" hidden>
          <button data-act="settings" ${vm.status === "running" ? "disabled" : ""}>Settings…</button>
          ${vm.iso && vm.family !== "macos" ? `<button data-act="eject" ${vm.status === "running" ? "disabled" : ""}>Eject disc</button>` : ""}
          ${!vm.iso && vm.family !== "macos" ? `<button data-act="insert" ${vm.status === "running" ? "disabled" : ""}>Insert disc…</button>` : ""}
          <button data-act="folder">Show files</button>
          <button data-act="delete" class="danger-text" ${vm.status === "running" ? "disabled" : ""}>Delete…</button>
        </div>
      </div>
    </div>
  </article>`;
}

async function act(id, action) {
  const vm = vms.get(id);
  try {
    switch (action) {
      case "start": return await vmApi.start(id);
      case "stop": return await vmApi.stop(id, false);
      case "force": return await vmApi.stop(id, true);
      case "cancel": return await vmApi.cancel(id);
      case "prepare": return await vmApi.prepare(id);
      case "settings": return openSettings(vm);
      case "eject": return await vmApi.update(id, { iso: null });
      case "insert": {
        const iso = await vmApi.pickIso();
        if (iso) await vmApi.update(id, { iso });
        return;
      }
      case "folder": return await vmApi.showFolder(id);
      case "vendor": return await vmApi.openUrl(osById(vm.osId).source.page);
      case "delete": return await vmApi.remove(id);
    }
  } catch (err) {
    vms.set(id, { ...vm, error: cleanError(err) });
    render();
  }
}

// Electron prefixes errors from the main process; show just the message.
const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

$("#vm-grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]").dataset.id;
  if (btn.dataset.act === "menu") {
    const listEl = btn.nextElementSibling;
    const wasHidden = listEl.hidden;
    closeMenus();
    listEl.hidden = !wasHidden;
    openMenu = wasHidden ? id : null;
    e.stopPropagation();
    return;
  }
  closeMenus();
  act(id, btn.dataset.act);
});
let openMenu = null; // VM id whose ⋯ menu is open
function closeMenus() {
  openMenu = null;
  document.querySelectorAll(".menu-list").forEach((m) => { m.hidden = true; });
}
document.addEventListener("click", closeMenus);

vmApi.onVmChanged((vm) => {
  if (vm.deleted) vms.delete(vm.id);
  else vms.set(vm.id, vm);
  render();
});

// ---------- One-time setup (QEMU) ----------

function needsQemu() {
  return state.catalog.some((o) => o.engine === "qemu") && !state.engines.qemu;
}

function renderSetup() {
  $("#setup").hidden = !needsQemu();
}

$("#setup-install").addEventListener("click", async () => {
  const btn = $("#setup-install");
  btn.disabled = true;
  btn.textContent = "Installing…";
  $("#setup-log").hidden = false;
  $("#setup-log").textContent = "";
  const result = await vmApi.installQemu();
  state.engines = result.engines;
  btn.disabled = false;
  btn.textContent = "Install VM engine";
  if (result.engines.qemu) {
    $("#setup-log").hidden = true;
  } else {
    $("#setup-text").textContent = result.message || "The install didn't finish. Try again.";
    $("#setup-check").hidden = false;
    if (result.url) vmApi.openUrl(result.url);
  }
  renderSetup();
});
$("#setup-check").addEventListener("click", async () => {
  state.engines = await vmApi.checkEngines();
  renderSetup();
});
vmApi.onInstallLog((text) => {
  const log = $("#setup-log");
  log.textContent = (log.textContent + text).slice(-4000);
  log.scrollTop = log.scrollHeight;
});

let slowDismissed = false;
$("#slow-dismiss").addEventListener("click", () => { slowDismissed = true; render(); });
$("#slow-fix").addEventListener("click", async () => {
  const r = await vmApi.enableFastMode();
  if (r.message) alert(r.message);
  if (r.ok) { slowDismissed = true; render(); }
});

// ---------- New VM wizard ----------

const wizard = $("#wizard");
let picked = null; // catalog entry
let pickedIso = null;

function osTile(os) {
  const off = !os.engine;
  return `<button type="button" class="os-tile ${off ? "off" : ""}" data-os="${esc(os.id)}" ${off ? `title="${esc(os.reason)}"` : ""}>
    ${osLogo(os.logo, 44)}
    <span class="os-name">${esc(os.name)}</span>
    <span class="os-sub">${off ? "Not available here" : os.source.type === "auto" ? (os.family === "windows" ? "From Microsoft" : "Automatic download") : os.source.type === "ipsw" ? "From Apple" : "Bring your ISO"}</span>
  </button>`;
}

function openWizard(osId) {
  $("#os-grid").innerHTML = state.catalog.map(osTile).join("");
  $("#wizard-error").hidden = true;
  if (osId) pickOs(osId);
  else showStep("os");
  wizard.showModal();
}

function showStep(step) {
  $("#step-os").hidden = step !== "os";
  $("#step-config").hidden = step !== "config";
  $("#wizard-back").hidden = step !== "config";
  $("#wizard-create").hidden = step !== "config";
  $("#wizard-title").textContent = step === "os" ? "New VM" : `New ${picked.name} VM`;
}

function pickOs(id) {
  const os = osById(id);
  if (!os.engine) {
    showError("#wizard-error", os.reason);
    return;
  }
  $("#wizard-error").hidden = true;
  picked = os;
  pickedIso = null;
  $("#picked-logo").innerHTML = osLogo(os.logo, 56);
  $("#picked-name").textContent = os.name;
  $("#picked-blurb").textContent = os.blurb;
  $("#picked-warning").hidden = !os.warning;
  $("#picked-warning").textContent = os.warning || "";

  const taken = new Set([...vms.values()].map((v) => v.name));
  let name = os.name.replace(/ \(.*\)$/, "");
  for (let n = 2; taken.has(name); n++) name = `${os.name.replace(/ \(.*\)$/, "")} ${n}`;
  $("#cfg-name").value = name;

  setupSliders("cfg", os.defaults);
  renderDisc();
  showStep("config");
}

function setupSliders(prefix, values, minDisk = 16) {
  const h = state.host;
  const cpus = $(`#${prefix}-cpus`);
  const mem = $(`#${prefix}-mem`);
  const disk = $(`#${prefix}-disk`);
  cpus.max = h.cpus;
  mem.max = Math.max(2048, Math.floor((h.memoryMB - 1024) / 512) * 512); // leave some memory for this computer
  disk.min = minDisk;
  cpus.value = Math.min(values.cpus, h.cpus);
  mem.value = Math.min(values.memoryMB, Number(mem.max));
  disk.value = Math.max(values.diskGB, minDisk);
  const show = () => {
    $(`#${prefix}-cpus-out`).textContent = cpus.value;
    $(`#${prefix}-mem-out`).textContent = gb(Number(mem.value));
    $(`#${prefix}-disk-out`).textContent = `${disk.value} GB`;
  };
  [cpus, mem, disk].forEach((el) => { el.oninput = show; });
  show();
}

function renderDisc() {
  const src = picked.source;
  const own = pickedIso
    ? `<div class="disc-row"><code class="path">${esc(pickedIso)}</code>
         ${src.type === "auto" ? `<button type="button" class="btn ghost small" id="use-auto">Download it for me instead</button>` : ""}
         <button type="button" class="btn ghost small" id="choose-iso">Change…</button></div>`
    : "";
  let html;
  if (src.type === "ipsw") {
    html = `<div class="disc-auto">✅ <div><b>Install: automatic.</b><br><span class="muted">macOS (about 15 GB) is downloaded from Apple and installed for you. Setup takes 20–40 minutes.</span></div></div>`;
  } else if (src.type === "auto" && !pickedIso) {
    const where = picked.family === "windows" ? "straight from Microsoft (about 7 GB)" : "from the official site and checked before it's used";
    const extra = picked.family === "windows"
      ? `<br><span class="muted">During setup, click <b>“I don't have a product key”</b>, it installs and runs without one.</span>` : "";
    html = `<div class="disc-auto">✅ <div><b>Install disc: automatic.</b><br><span class="muted">The newest ${esc(picked.name)} is downloaded ${where}.</span>${extra}</div></div>
      <button type="button" class="link" id="choose-iso">Already have the ISO file? Use it instead</button>`;
  } else if (src.type === "auto") {
    html = `<b>Install disc: your ISO file</b>${own}`;
  } else {
    html = `<b>Install disc</b><p class="muted">Choose an .iso file on this computer.</p>
      ${own || `<div class="disc-row"><button type="button" class="btn primary" id="choose-iso">Choose the ISO file…</button></div>`}`;
  }
  $("#disc").innerHTML = html;
  $("#use-auto")?.addEventListener("click", () => { pickedIso = null; renderDisc(); });
  $("#choose-iso")?.addEventListener("click", async () => {
    const iso = await vmApi.pickIso();
    if (iso) { pickedIso = iso; renderDisc(); }
  });
}

function showError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = false;
}

$("#os-grid").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-os]");
  if (tile) pickOs(tile.dataset.os);
});
$("#quick-picks").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-os]");
  if (tile) openWizard(tile.dataset.os);
});
$("#wizard-back").addEventListener("click", () => showStep("os"));
$("#new-vm").addEventListener("click", () => openWizard());

$("#wizard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (picked.source.type === "manual" && !pickedIso) return showError("#wizard-error", "Choose the install disc (.iso file) first.");
  if (picked.engine === "qemu" && !state.engines.qemu) return showError("#wizard-error", "Finish the one-time setup first: click “Install VM engine” at the top of the window.");
  try {
    const vm = await vmApi.create({
      osId: picked.id,
      name: $("#cfg-name").value,
      cpus: Number($("#cfg-cpus").value),
      memoryMB: Number($("#cfg-mem").value),
      diskGB: Number($("#cfg-disk").value),
      iso: pickedIso,
    });
    vms.set(vm.id, vm);
    render();
    wizard.close();
  } catch (err) {
    showError("#wizard-error", cleanError(err));
  }
});

// ---------- Settings ----------

const settings = $("#settings");
let editing = null;
let editIso = null;

function openSettings(vm) {
  editing = vm;
  editIso = vm.iso;
  $("#set-name").value = vm.name;
  setupSliders("set", vm, vm.diskGB);
  renderSetIso();
  const macos = vm.family === "macos";
  $("#set-iso-change").hidden = macos;
  $("#set-iso-eject").hidden = macos;
  $("#settings-error").hidden = true;
  settings.showModal();
}

function renderSetIso() {
  $("#set-iso").textContent = editIso || (editing.family === "macos" ? "Not needed for macOS" : "No disc");
  $("#set-iso-eject").disabled = !editIso;
}
$("#set-iso-change").addEventListener("click", async () => {
  const iso = await vmApi.pickIso();
  if (iso) { editIso = iso; renderSetIso(); }
});
$("#set-iso-eject").addEventListener("click", () => { editIso = null; renderSetIso(); });

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const changes = {
    name: $("#set-name").value,
    cpus: Number($("#set-cpus").value),
    memoryMB: Number($("#set-mem").value),
    diskGB: Number($("#set-disk").value),
  };
  if (editIso !== editing.iso) changes.iso = editIso;
  try {
    await vmApi.update(editing.id, changes);
    settings.close();
  } catch (err) {
    showError("#settings-error", cleanError(err));
  }
});

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------- Start ----------

(async () => {
  state = await vmApi.state();
  const h = state.host;
  $("#host-line").textContent = `${h.name} · ${h.cpus} cores · ${gb(h.memoryMB)} memory`;
  state.vms.forEach((vm) => vms.set(vm.id, vm));
  $("#quick-picks").innerHTML = state.catalog.filter((o) => o.engine).map(osTile).join("");
  renderSetup();
  render();
})();
