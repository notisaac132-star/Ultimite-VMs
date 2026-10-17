// The VM library: every VM is a folder under ~/Ultimate VMs/ holding vm.json and its disk.
// Install discs are shared between VMs in ~/Ultimate VMs/Install Discs/.
const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const catalog = require("./catalog");
const host = require("./host");
const { download, fetchText } = require("./download");
const qemu = require("./engines/qemu");
const apple = require("./engines/apple");

const root = path.join(app.getPath("home"), "Ultimate VMs");
const discs = path.join(root, "Install Discs");
const engines = { qemu, apple };

// Live state that isn't saved: running VMs, background jobs (downloads/installs) and the last error.
const live = new Map(); // id -> { running, controller, job: { label, progress, abort }, error, slow }
let notify = () => {};

const folderOf = (id) => path.join(root, id);
const configFile = (id) => path.join(folderOf(id), "vm.json");

function read(id) {
  return JSON.parse(fs.readFileSync(configFile(id), "utf8"));
}

function save(vm) {
  fs.mkdirSync(folderOf(vm.id), { recursive: true });
  fs.writeFileSync(configFile(vm.id), JSON.stringify(vm, null, 2));
}

function liveOf(id) {
  if (!live.has(id)) live.set(id, {});
  return live.get(id);
}

function view(vm) {
  const l = live.get(vm.id) || {};
  const status = l.running ? "running" : l.job ? "busy" : vm.ready ? "stopped" : "unfinished";
  return {
    ...vm,
    status,
    job: l.job ? { label: l.job.label, progress: l.job.progress } : null,
    error: l.error || null,
    slow: !!l.slow,
  };
}

function list() {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((id) => fs.existsSync(configFile(id)))
    .map((id) => {
      try { return view(read(id)); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.lastRun || b.createdAt) - (a.lastRun || a.createdAt));
}

function changed(id) {
  try { notify(view(read(id))); } catch { notify({ id, deleted: true }); }
}

function setJob(id, job) {
  liveOf(id).job = job;
  changed(id);
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "vm";

// Creates the VM and starts preparing it (downloading its disc, creating its disk) in the background.
function create({ osId, name, cpus, memoryMB, diskGB, iso }) {
  const entry = catalog.byId(osId);
  if (!entry) throw new Error("Unknown operating system.");
  const plan = host.plan(entry);
  if (!plan.engine) throw new Error(plan.reason);
  if (entry.source.type === "manual" && !iso) throw new Error("Choose the install disc (.iso file) first.");

  const vm = {
    id: `${slug(name)}-${crypto.randomBytes(3).toString("hex")}`,
    name: String(name).trim().slice(0, 60) || entry.name,
    osId,
    family: entry.family,
    engine: plan.engine,
    guestArch: plan.guestArch,
    firmware: entry.firmware || "bios",
    bypassChecks: !!entry.bypassChecks,
    cpus: clamp(cpus, 1, host.info.cpus),
    memoryMB: clamp(memoryMB, 512, host.info.memoryMB),
    diskGB: clamp(diskGB, 8, 2048),
    iso: iso || null,
    ready: false,
    installed: false,
    createdAt: Date.now(),
  };
  save(vm);
  prepare(vm.id);
  return view(vm);
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));

// Gets the VM ready to start. Safe to call again after a failure or cancel ("Resume setup").
async function prepare(id) {
  const vm = read(id);
  const entry = catalog.byId(vm.osId);
  const abort = new AbortController();
  const job = { label: "Getting ready…", progress: null, abort };
  liveOf(id).error = null;
  setJob(id, job);
  const step = (label, progress = null) => {
    job.label = label;
    job.progress = progress;
    changed(id);
  };

  try {
    fs.mkdirSync(discs, { recursive: true });
    if (entry.source.type === "auto" && !vm.iso) {
      step(`Finding the newest ${entry.name}…`);
      const found = await entry.source.resolve(vm.guestArch, fetchText);
      vm.iso = await fetchDisc(found, entry.name, step, abort.signal);
      save(vm);
    }

    if (vm.engine === "apple" && vm.family === "macos") {
      step("Asking Apple for the newest macOS…");
      const url = await apple.latestIpswUrl();
      const ipsw = await fetchDisc({ url, file: url.split("/").pop() }, "macOS", step, abort.signal);
      step("Installing macOS…", 0);
      await apple.installMacOS(vm, folderOf(id), ipsw, {
        signal: abort.signal,
        onProgress: (p, text) => step(text || "Installing macOS…", p),
      });
      vm.installed = true;
    } else if (vm.engine === "qemu") {
      step("Creating the virtual disk…");
      await qemu.createDisk(vm, folderOf(id));
    }
    // (Apple engine Linux VMs create their disk on first start.)

    vm.ready = true;
    save(vm);
    liveOf(id).job = null;
    changed(id);
  } catch (err) {
    const l = liveOf(id);
    l.job = null;
    l.error = abort.signal.aborted
      ? "Setup was cancelled. Click “Resume setup” to continue."
      : /^net::|fetch failed/.test(err.message)
        ? `Couldn't reach the download site (${err.message}). Check your internet connection, then click “Resume setup”.`
        : err.message;
    changed(id);
  }
}

// Downloads into Install Discs (skipped when already there). Returns the file path.
async function fetchDisc({ url, sha256, file }, label, step, signal) {
  const dest = path.join(discs, path.basename(file));
  if (fs.existsSync(dest)) return dest;
  const mb = (n) => (n / 1024 / 1024 / 1024).toFixed(1);
  step(`Downloading ${label}…`, 0);
  await download(url, dest, {
    sha256,
    signal,
    onProgress: ({ received, total, verifying }) =>
      verifying
        ? step(`Checking the ${label} download…`)
        : step(`Downloading ${label}… ${mb(received)} of ${total ? mb(total) : "?"} GB`, total ? received / total : null),
  });
  return dest;
}

function cancel(id) {
  liveOf(id).job?.abort?.abort();
}

async function start(id) {
  const vm = read(id);
  const l = liveOf(id);
  if (l.running || l.job) return;
  if (!vm.ready) throw new Error("This VM isn't set up yet.");
  l.error = null;
  l.slow = false;
  const started = Date.now();
  l.controller = await engines[vm.engine].start(vm, folderOf(id), {
    onExit: ({ code, log, slow }) => {
      l.running = false;
      l.controller = null;
      l.slow = !!slow;
      // A VM that dies within a few seconds failed to start; show QEMU's/the helper's explanation.
      if (code && Date.now() - started < 15000) l.error = lastLines(log) || `The VM stopped unexpectedly (code ${code}).`;
      changed(id);
    },
  });
  l.running = true;
  vm.lastRun = Date.now();
  save(vm);
  changed(id);
}

const lastLines = (log) => (log || "").trim().split("\n").slice(-4).join("\n");

function stop(id, force) {
  const c = liveOf(id).controller;
  if (c) (force ? c.forceStop : c.stop)();
}

// Settings changes from the VM's settings dialog.
async function update(id, changes) {
  const vm = read(id);
  if (liveOf(id).running) throw new Error("Shut the VM down before changing its settings.");
  if (changes.name != null) vm.name = String(changes.name).trim().slice(0, 60) || vm.name;
  if (changes.cpus != null) vm.cpus = clamp(changes.cpus, 1, host.info.cpus);
  if (changes.memoryMB != null) vm.memoryMB = clamp(changes.memoryMB, 512, host.info.memoryMB);
  const grow = changes.diskGB != null && Number(changes.diskGB) > vm.diskGB;
  if (grow) vm.diskGB = clamp(changes.diskGB, vm.diskGB, 2048); // disks can only grow
  if ("iso" in changes) {
    vm.iso = changes.iso || null;
    if (!vm.iso) vm.installed = true; // ejecting the disc means setup is done
  }
  if (grow && vm.engine === "qemu") await qemu.resizeDisk(vm, folderOf(id));
  save(vm);
  changed(id);
  return view(vm);
}

function remove(id) {
  const l = liveOf(id);
  if (l.running) throw new Error("Shut the VM down before deleting it.");
  l.job?.abort?.abort();
  fs.rmSync(folderOf(id), { recursive: true, force: true });
  live.delete(id);
  notify({ id, deleted: true });
}

const anyRunning = () => [...live.values()].some((l) => l.running);

module.exports = {
  root,
  folderOf,
  list,
  create,
  prepare,
  cancel,
  start,
  stop,
  update,
  remove,
  anyRunning,
  onChange: (fn) => { notify = fn; },
};
