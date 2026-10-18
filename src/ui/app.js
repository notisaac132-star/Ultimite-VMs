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

  let hint = "";
  if (vm.status === "running" && vm.iso && !vm.installed) {
    if (vm.unattended) hint = "Windows is installing itself. Just wait: it restarts a few times and ends on the desktop (about 20–40 minutes).";
    else if (vm.autoInstall) hint = "Installing by itself, no need to click anything. The window closes when it's done and the VM restarts into the new system (log in: <b>user</b> / <b>user</b>).";
    else if (vm.family === "linux") hint = "You're in the live desktop. To keep it for good, use the <b>Install</b> icon on its desktop, then shut down and click <b>⋯ → Eject disc</b>.";
    else if (vm.family === "chromeos") hint = "Pick <b>Try it first</b> to use ChromeOS now, or <b>Install ChromeOS Flex</b> to keep it, then shut down and click <b>⋯ → Eject disc</b>.";
    else hint = `Follow the steps in the VM's window${vm.family === "windows" ? " (no product key? click <b>“I don't have a product key”</b>)" : ""}. When it's installed, shut down and click <b>⋯ → Eject disc</b>.`;
  }
  if (hint) hint = `<p class="hint">${hint}</p>`;

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
        const iso = await vmApi.pickIso(vm.family);
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

// Installs QEMU, showing progress in the setup banner. Returns true when it's ready.
async function installEngine() {
  const btn = $("#setup-install");
  $("#setup").hidden = false;
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
  return result.engines.qemu;
}
$("#setup-install").addEventListener("click", installEngine);
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
// Steps: pick an OS → Quick Setup (one click) or Advanced Setup (settings + your own ISO).

const wizard = $("#wizard");
let picked = null; // catalog entry
let pickedIso = null; // Advanced Setup: the user's own file (null = download automatically)
let useOwnFile = true;

function osTile(os) {
  const off = !os.engine;
  const from = { windows: "From Microsoft", macos: "From Apple", chromeos: "From Google" }[os.family] || (os.source.type === "auto" ? "Automatic download" : "Bring your ISO");
  return `<button type="button" class="os-tile ${off ? "off" : ""}" data-os="${esc(os.id)}" ${off ? `title="${esc(os.reason)}"` : ""}>
    ${osLogo(os.logo, 44)}
    <span class="os-name">${esc(os.name)}</span>
    <span class="os-sub">${off ? "Not available here" : from}</span>
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
  for (const s of ["os", "mode", "config"]) $(`#step-${s}`).hidden = step !== s;
  $("#wizard-back").hidden = step === "os";
  $("#wizard-create").hidden = step !== "config";
  $("#wizard-error").hidden = true;
  $("#wizard-title").textContent = step === "os" ? "New VM" : step === "mode" ? `${picked.name}` : `${picked.name}: Advanced Setup`;
  $("#wizard-back").dataset.to = step === "config" && picked.quick ? "mode" : "os";
}

function pickOs(id) {
  const os = osById(id);
  if (!os.engine) {
    showError("#wizard-error", os.reason);
    return;
  }
  picked = os;
  pickedIso = null;
  useOwnFile = true;
  for (const where of ["mode", "picked"]) {
    $(`#${where}-logo`).innerHTML = osLogo(os.logo, 56);
    $(`#${where}-name`).textContent = os.name;
    $(`#${where}-blurb`).textContent = os.blurb;
  }
  for (const el of [$("#mode-warning"), $("#picked-warning")]) {
    el.hidden = !os.warning;
    el.textContent = os.warning || "";
  }
  if (!os.quick) return openAdvanced();
  $("#quick-text").textContent = os.quick;
  showStep("mode");
}

function openAdvanced() {
  const taken = new Set([...vms.values()].map((v) => v.name));
  const base = picked.name.replace(/ \(.*\)$/, "");
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  $("#cfg-name").value = name;
  setupSliders("cfg", picked.defaults);
  renderDisc();
  showStep("config");
}

async function quickSetup() {
  if (picked.quickEngine === "qemu" && !state.engines.qemu) {
    wizard.close();
    if (!(await installEngine())) return;
  }
  try {
    const vm = await vmApi.create({ osId: picked.id, quick: true });
    vms.set(vm.id, vm);
    render();
    if (wizard.open) wizard.close();
  } catch (err) {
    if (!wizard.open) wizard.showModal();
    showError("#wizard-error", cleanError(err));
  }
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

// What kind of file each OS installs from.
const FILE_KIND = {
  macos: { label: "macOS restore image (.ipsw)", hint: "An .ipsw file for Apple Silicon Macs." },
  chromeos: { label: "ChromeOS Flex image (.bin)", hint: "The .bin file from Google's ChromeOS Flex download (unzipped)." },
};

function renderDisc() {
  const canDownload = picked.source.type !== "manual";
  const kind = FILE_KIND[picked.family] || { label: "install disc (.iso)", hint: "Any .iso file on this computer." };
  const autoText = {
    windows: "The newest version is downloaded straight from Microsoft (about 7 GB). During setup, click <b>“I don't have a product key”</b>.",
    macos: "The newest macOS (about 15 GB) is downloaded from Apple and installed for you.",
    chromeos: "The newest ChromeOS Flex is downloaded from Google (about 1.5 GB).",
  }[picked.family] || "The newest version is downloaded from the official site and checked before it's used.";
  const own = !canDownload || useOwnFile;
  $("#disc").innerHTML = `
    <b>Install from</b>
    ${canDownload ? `<div class="segmented">
      <button type="button" data-src="own" class="${own ? "on" : ""}">📁 My own file</button>
      <button type="button" data-src="auto" class="${own ? "" : "on"}">⬇ Download it for me</button>
    </div>` : ""}
    ${own ? `<p class="muted">${kind.hint}</p>
      <div class="disc-row">
        <button type="button" class="btn ${pickedIso ? "ghost" : "primary"}" id="choose-iso">${pickedIso ? "Change…" : `Choose ${kind.label}…`}</button>
        <code class="path">${pickedIso ? esc(pickedIso) : "No file chosen"}</code>
      </div>` : `<p class="muted">${autoText}</p>`}`;
  $("#disc").querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => {
    useOwnFile = b.dataset.src === "own";
    renderDisc();
  }));
  $("#choose-iso")?.addEventListener("click", async () => {
    const iso = await vmApi.pickIso(picked.family);
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
$("#mode-quick").addEventListener("click", quickSetup);
$("#mode-advanced").addEventListener("click", openAdvanced);
$("#wizard-back").addEventListener("click", (e) => showStep(e.currentTarget.dataset.to));
$("#new-vm").addEventListener("click", () => openWizard());

$("#wizard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const own = picked.source.type === "manual" || useOwnFile;
  if (own && !pickedIso) return showError("#wizard-error", "Choose the file to install from first (or switch to “Download it for me”).");
  if (picked.engine === "qemu" && !state.engines.qemu) {
    wizard.close();
    if (!(await installEngine())) return;
  }
  try {
    const vm = await vmApi.create({
      osId: picked.id,
      name: $("#cfg-name").value,
      cpus: Number($("#cfg-cpus").value),
      memoryMB: Number($("#cfg-mem").value),
      diskGB: Number($("#cfg-disk").value),
      iso: own ? pickedIso : null,
    });
    vms.set(vm.id, vm);
    render();
    if (wizard.open) wizard.close();
  } catch (err) {
    if (!wizard.open) wizard.showModal();
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
  const iso = await vmApi.pickIso(editing.family);
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

// ---------- Pick several OSes ----------

const picker = $("#picker");
const picks = new Set();

function openPicker() {
  picks.clear();
  const usable = state.catalog.filter((o) => o.quick && o.quickEngine);
  $("#picker-grid").innerHTML = usable.map((os) => osTile(os).replace("</button>", `<span class="check"></span></button>`)).join("");
  renderPicks();
  picker.showModal();
}

function renderPicks() {
  $("#picker-grid").querySelectorAll("[data-os]").forEach((t) => {
    t.classList.toggle("picked", picks.has(t.dataset.os));
    t.querySelector(".check").textContent = picks.has(t.dataset.os) ? "✓" : "";
  });
  const n = picks.size;
  $("#picker-go").disabled = !n;
  $("#picker-go").textContent = n ? `Install ${n} automatically` : "Install selected";
  const mem = [...picks].reduce((sum, id) => sum + osById(id).defaults.memoryMB, 0);
  $("#picker-note").textContent = n > 1 && mem > state.host.memoryMB - 2048
    ? "They'll download one after another, and install one or two at a time so this computer doesn't run out of memory."
    : n ? "They'll download one after another and start as soon as each is ready." : "";
}

$("#picker-grid").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-os]");
  if (!tile) return;
  const id = tile.dataset.os;
  if (picks.has(id)) picks.delete(id);
  else picks.add(id);
  renderPicks();
});

async function installMany(osIds) {
  const needQemu = osIds.some((id) => osById(id)?.quickEngine === "qemu");
  if (needQemu && !state.engines.qemu && !(await installEngine())) return;
  const created = await vmApi.createMany(osIds);
  for (const vm of created) if (vm.id) vms.set(vm.id, vm);
  const failed = created.filter((vm) => vm.error);
  if (failed.length) alert(failed.map((f) => `${osById(f.osId)?.name}: ${f.error}`).join("\n"));
  render();
}

$("#picker-form").addEventListener("submit", (e) => {
  e.preventDefault();
  picker.close();
  installMany([...picks]);
});
$("#open-picker").addEventListener("click", openPicker);

// ---------- Updates ----------

let updateDismissed = false;
function renderUpdate(u) {
  if (!u) return;
  $("#version").textContent = u.state === "checking" ? `v${state.version} · checking…` : u.state === "latest" ? `v${state.version} · up to date` : `v${state.version}`;
  const show = { downloading: true, ready: true, manual: true }[u.state] && !(updateDismissed && u.state !== "ready");
  $("#update").hidden = !show;
  if (!show) return;
  $("#update-bar").hidden = u.state !== "downloading";
  $("#update-bar i").style.width = `${u.percent || 0}%`;
  $("#update-later").hidden = u.state === "downloading";
  $("#update-go").hidden = u.state === "downloading";
  if (u.state === "downloading") {
    $("#update-title").textContent = `Downloading Ultimate VMs ${u.version}…`;
    $("#update-text").textContent = `${u.percent || 0}%. Keep using the app; it'll be ready in a moment.`;
  } else if (u.state === "ready") {
    $("#update-title").textContent = `Ultimate VMs ${u.version} is ready`;
    $("#update-text").textContent = "Restart to finish updating (takes a few seconds). It also installs by itself next time you close the app.";
    $("#update-go").textContent = "Restart and update";
  } else {
    $("#update-title").textContent = `Ultimate VMs ${u.version} is out`;
    $("#update-text").textContent = u.message || "";
    $("#update-go").textContent = "Download it";
  }
}
vmApi.onUpdateStatus(renderUpdate);
$("#update-later").addEventListener("click", () => { updateDismissed = true; $("#update").hidden = true; });
$("#update-go").addEventListener("click", async () => {
  const u = await vmApi.updateStatus();
  if (u.state === "manual") return vmApi.openReleases();
  const r = await vmApi.installUpdate();
  if (r.blocked) alert("Shut down your running VMs first, then click “Restart and update” again.");
});
$("#version").addEventListener("click", async () => renderUpdate(await vmApi.checkUpdates()));

// ---------- Start ----------

(async () => {
  state = await vmApi.state();
  const h = state.host;
  $("#host-line").textContent = `${h.name} · ${h.cpus} cores · ${gb(h.memoryMB)} memory`;
  state.vms.forEach((vm) => vms.set(vm.id, vm));
  $("#quick-picks").innerHTML = state.catalog.filter((o) => o.engine).map(osTile).join("");
  renderSetup();
  render();
  renderUpdate(await vmApi.updateStatus());

  // OSes picked in the Windows installer get set up right away; otherwise the very first launch
  // shows the "pick your OSes" screen.
  const fromInstaller = await vmApi.firstRunPicks();
  let welcomed = false;
  try { welcomed = localStorage.getItem("welcomed") === "1"; localStorage.setItem("welcomed", "1"); } catch {}
  if (fromInstaller.length) installMany(fromInstaller);
  else if (!welcomed && vms.size === 0) openPicker();
})();
