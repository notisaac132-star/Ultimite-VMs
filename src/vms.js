// The VM library: every VM is a folder under ~/Ultimate VMs/ holding vm.json and its disk.
// Install discs are shared between VMs in ~/Ultimate VMs/Install Discs/.
const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const catalog = require("./catalog");
const host = require("./host");
const { download, fetchText, resolveRedirect, unzipLargest } = require("./download");
const msbrowser = require("./msbrowser");
const qemu = require("./engines/qemu");
const apple = require("./engines/apple");
const autoinstall = require("./autoinstall");

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

// What the download steps tried, for diagnosing "it can't get the ISO": <app data>/downloads.log.
function downloadLog(message) {
  try {
    const file = path.join(app.getPath("userData"), "downloads.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 200_000) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break setup
  }
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "vm";

// Creates the VM and starts preparing it (downloading its disc, creating its disk) in the background.
// Quick Setup (quick: true) uses the recommended settings, installs Windows by itself and starts the VM
// as soon as it's ready. Advanced Setup takes the user's settings and, optionally, their own ISO.
async function create({ osId, quick, name, cpus, memoryMB, diskGB, iso, deferPrepare, samples, isolate }) {
  const entry = catalog.byId(osId);
  if (!entry) throw new Error("Unknown operating system.");
  const plan = host.plan(entry, { quick });
  if (!plan.engine) throw new Error(plan.reason);
  if (quick && !entry.quick) throw new Error(`${entry.name} needs Advanced Setup.`);
  if (entry.source.type === "manual" && !iso) throw new Error("Choose the install disc (.iso file) first.");
  const settings = quick ? { ...entry.defaults, name: uniqueName(entry.name.replace(/ \(.*\)$/, "")) } : { name, cpus, memoryMB, diskGB };

  const vm = {
    id: `${slug(settings.name)}-${crypto.randomBytes(3).toString("hex")}`,
    name: String(settings.name).trim().slice(0, 60) || entry.name,
    osId,
    family: entry.family,
    engine: plan.engine,
    guestArch: plan.guestArch,
    firmware: entry.firmware || "bios",
    bypassChecks: !!entry.bypassChecks,
    // Hands-free installs: Windows through its answer file (only with the ISO the app downloads, whose
    // language is known); Linux through its installer's automatic mode (see autoinstall.js).
    unattended: !!(quick && entry.unattended),
    autoInstall: (quick && plan.engine === "qemu" && entry.autoInstall) || null,
    culture: app.getLocale(),
    autoStart: !!quick,
    cpus: clamp(settings.cpus, 1, host.info.cpus),
    memoryMB: clamp(settings.memoryMB, 512, Math.max(1024, host.info.memoryMB - 1024)),
    diskGB: clamp(settings.diskGB, 8, 2048),
    iso: (!quick && iso) || null,
    // Files to test inside the VM (see "Test files" below): copies kept in the VM's own "samples" folder.
    samples: [],
    // Blocks all network access for the VM (needed when opening something suspicious).
    isolate: !!isolate,
    ready: false,
    installed: false,
    createdAt: Date.now(),
  };
  save(vm);
  // Copied before setup starts, so setup's own saves of vm.json never overwrite them.
  if (samples?.length) {
    try {
      Object.assign(vm, { samples: await copySamples(vm.id, [], samples) });
      save(vm);
    } catch (err) {
      fs.rmSync(folderOf(vm.id), { recursive: true, force: true });
      throw err;
    }
  }
  if (!deferPrepare) prepare(vm.id);
  return view(vm);
}

// ---------- Test files ----------
// Files added when making a VM (e.g. something to check for malware) are copied into <VM folder>/samples and
// shown to the VM as a read-only USB drive (QEMU) or disc (Apple). The originals are never touched, and a
// VM can't write to the drive, so nothing the file does can reach back out through it.
const MAX_SAMPLES_BYTES = 450 * 1024 * 1024; // the virtual FAT drive is 504 MiB, and needs room for itself
const samplesDir = (id) => path.join(folderOf(id), "samples");

// Copies `paths` into the VM's samples folder next to the `existing` list; returns the new list [{ name, size }].
// Everything is checked before anything is copied, and a failure part-way removes what this call copied.
async function copySamples(id, existing, paths) {
  const dir = samplesDir(id);
  const sources = paths.map((source) => ({ source, stat: fs.statSync(source) }));
  for (const { source, stat } of sources) {
    if (!stat.isFile()) throw new Error(`${path.basename(source)} isn't a file. Add files one by one (zip a folder first).`);
  }
  const total = [...existing, ...sources.map((s) => ({ size: s.stat.size }))].reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_SAMPLES_BYTES) throw new Error("Too much to put in the VM: the files can add up to 450 MB at most.");

  fs.mkdirSync(dir, { recursive: true });
  const list = [...existing];
  const copied = [];
  try {
    for (const { source, stat } of sources) {
      let name = path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
      for (let n = 2; list.some((f) => f.name.toLowerCase() === name.toLowerCase()); n++) {
        name = `${path.parse(source).name} (${n})${path.extname(source)}`;
      }
      await fs.promises.copyFile(source, path.join(dir, name));
      copied.push(name);
      list.push({ name, size: stat.size });
    }
  } catch (err) {
    for (const name of copied) fs.rmSync(path.join(dir, name), { force: true });
    throw err;
  }
  return list;
}

function removeSamples(id, existing, names) {
  const dir = samplesDir(id);
  for (const name of names) fs.rmSync(path.join(dir, path.basename(name)), { force: true });
  return existing.filter((f) => !names.includes(f.name));
}

function uniqueName(base) {
  const taken = new Set(list().map((v) => v.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
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
      // Hands-free installs may need a different disc (e.g. Fedora's network installer).
      const resolve = (vm.autoInstall && entry.source.resolveInstaller) || entry.source.resolve;
      const found = await resolve(vm.guestArch, fetchText, app.getLocale(), {
        resolveRedirect,
        browserLink: msbrowser.getIsoLink,
        step,
        signal: abort.signal,
        log: downloadLog,
      });
      vm.iso = await fetchDisc(found, entry.name, step, abort.signal);
      if (found.culture) vm.culture = found.culture;
      if (found.trial) vm.trial = true; // Evaluation Edition: no product key to enter, runs 90 days
      save(vm);
    }

    if (vm.engine === "apple" && vm.family === "macos") {
      // Advanced Setup can bring its own .ipsw; otherwise ask Apple for the newest one.
      let ipsw = vm.iso;
      if (!ipsw) {
        step("Asking Apple for the newest macOS…");
        const url = await apple.latestIpswUrl();
        ipsw = await fetchDisc({ url, file: url.split("/").pop() }, "macOS", step, abort.signal);
      }
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
    const autoStart = vm.autoStart;
    vm.autoStart = false;
    save(vm);
    if (autoStart) await waitForMemory(vm, step, abort.signal);
    liveOf(id).job = null;
    changed(id);
    if (autoStart) await start(id);
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

// Several Quick Setup VMs at once: don't start one until the computer has memory free for it.
async function waitForMemory(vm, step, signal) {
  const spare = () => host.info.memoryMB - 2048 - list().filter((v) => v.status === "running").reduce((sum, v) => sum + v.memoryMB, 0);
  while (spare() < vm.memoryMB && list().some((v) => v.status === "running")) {
    if (signal.aborted) throw new Error("Cancelled");
    step("Waiting for your other VMs to finish, so this computer doesn't run out of memory…");
    await new Promise((r) => setTimeout(r, 15000));
  }
}

// Quick Setup for several OSes (the first-run picker, or the Windows installer's OS page).
// Downloads happen one after another; each VM starts as soon as it's ready.
async function createMany(osIds) {
  const created = [];
  for (const osId of osIds) {
    try {
      created.push(await create({ osId, quick: true, deferPrepare: true }));
    } catch (err) {
      created.push({ osId, error: err.message });
    }
  }
  const queued = created.filter((vm) => vm.id);
  for (const vm of queued) setJob(vm.id, { label: "Waiting its turn to download…", progress: null, abort: new AbortController() });
  (async () => {
    for (const vm of queued) {
      if (liveOf(vm.id).job?.abort.signal.aborted) {
        liveOf(vm.id).job = null;
        liveOf(vm.id).error = "Setup was cancelled. Click “Resume setup” to continue.";
        changed(vm.id);
        continue;
      }
      await prepare(vm.id);
    }
  })();
  return created;
}

// Downloads into Install Discs (skipped when already there). Returns the file path.
// Zipped images (ChromeOS Flex) are unpacked and the .zip deleted.
async function fetchDisc({ url, sha256, file, unzip }, label, step, signal) {
  const name = path.basename(file);
  if (unzip) {
    const image = path.join(discs, name.replace(/\.zip$/i, ""));
    if (fs.existsSync(image)) return image;
    const zip = await fetchDisc({ url, sha256, file: name }, label, step, signal);
    step(`Unpacking ${label}…`, 0);
    await unzipLargest(zip, image, (p) => step(`Unpacking ${label}…`, p));
    fs.rmSync(zip, { force: true });
    return image;
  }
  const dest = path.join(discs, name);
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
    onSlow: () => { l.slow = true; changed(id); },
    onExit: ({ code, log, slow }) => {
      l.running = false;
      l.controller = null;
      l.slow = !!slow;
      // A hands-free Linux install powers the VM off when it's done: eject the disc and boot the new system.
      if (vm.autoInstall && !vm.installed && code === 0 && autoinstall.looksInstalled(folderOf(id))) {
        const fresh = read(id);
        Object.assign(fresh, { installed: true, iso: null });
        save(fresh);
        autoinstall.cleanup(fresh, folderOf(id));
        changed(id);
        start(id).catch((err) => { l.error = err.message; changed(id); });
        return;
      }
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
  if (changes.addSamples?.length || changes.removeSamples?.length) {
    if (liveOf(id).job) throw new Error("Wait until setup finishes before changing the VM's files.");
    vm.samples = removeSamples(id, vm.samples || [], changes.removeSamples || []);
    if (changes.addSamples?.length) vm.samples = await copySamples(id, vm.samples, changes.addSamples);
  }
  if ("isolate" in changes) vm.isolate = !!changes.isolate;
  save(vm);
  changed(id);
  // Picking an ISO for a VM whose download failed carries on with its setup.
  if (changes.iso && !vm.ready && !liveOf(id).job) prepare(id);
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
  createMany,
  prepare,
  cancel,
  start,
  stop,
  update,
  remove,
  samplesDir,
  anyRunning,
  onChange: (fn) => { notify = fn; },
};
