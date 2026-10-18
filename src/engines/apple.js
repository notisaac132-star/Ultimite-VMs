// Apple engine: runs macOS and Linux VMs with Apple's built-in Virtualization framework,
// through the small macvm helper bundled with the Mac app (source: mac/macvm/main.swift).
//
// The helper prints one status line at a time:  PROGRESS <0..1> <text> | STATUS <text> | ERROR <text> | URL <url>
const { app } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { info } = require("../host");

function helperPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "macvm") : path.join(__dirname, "..", "..", "mac", "build", "macvm");
}

const available = () => info.platform === "darwin" && fs.existsSync(helperPath());

function runHelper(args, { onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), args);
    let error = "";
    let buf = "";
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("ERROR ")) error = line.slice(6);
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", (d) => { if (!error) error = String(d).trim().slice(-500); });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("Cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(error || `The Mac VM helper stopped (code ${code}).`));
    });
  });
}

// The newest macOS restore image (.ipsw) Apple supports on this Mac.
async function latestIpswUrl() {
  let url = null;
  await runHelper(["ipsw-url"], { onLine: (l) => { if (l.startsWith("URL ")) url = l.slice(4); } });
  if (!url) throw new Error("Apple didn't return a macOS download.");
  return url;
}

function installMacOS(vm, dir, ipsw, { onProgress, signal }) {
  return runHelper(
    ["install-macos", dir, "--ipsw", ipsw, "--cpus", String(vm.cpus), "--memory", String(vm.memoryMB), "--disk", String(vm.diskGB)],
    {
      signal,
      onLine: (line) => {
        const m = line.match(/^PROGRESS ([\d.]+)\s*(.*)$/);
        if (m) onProgress(Number(m[1]), m[2]);
      },
    },
  );
}

// Test files (see vms.js) go into the VM as a read-only disc made with hdiutil.
async function buildSamplesDisc(vm, dir) {
  const iso = path.join(dir, "samples.iso");
  fs.rmSync(iso, { force: true });
  if (!vm.samples?.length) return null;
  await new Promise((resolve, reject) =>
    execFile("/usr/bin/hdiutil", ["makehybrid", "-iso", "-joliet", "-default-volume-name", "SAMPLES", "-o", iso, path.join(dir, "samples")],
      (err, _out, stderr) => (err ? reject(new Error(`Couldn't pack the test files: ${String(stderr || err.message).trim()}`)) : resolve())));
  return iso;
}

async function start(vm, dir, { onExit }) {
  const args = ["run", dir, "--os", vm.family === "macos" ? "macos" : "linux", "--name", vm.name,
    "--cpus", String(vm.cpus), "--memory", String(vm.memoryMB), "--disk", String(vm.diskGB)];
  if (vm.iso && vm.family !== "macos") args.push("--iso", vm.iso);
  const samples = await buildSamplesDisc(vm, dir);
  if (samples) args.push("--extra", samples);
  if (vm.isolate) args.push("--no-network", "1");
  const child = spawn(helperPath(), args);
  let log = "";
  child.stdout.on("data", (d) => { log = (log + d).slice(-8000); });
  child.stderr.on("data", (d) => { log = (log + d).slice(-8000); });
  child.once("error", (err) => { log += `\n${err.message}`; });
  child.once("close", (code) => onExit({ code, log: log.replace(/^ERROR /gm, "") }));
  return {
    stop: () => child.kill("SIGTERM"), // the helper asks the guest to shut down
    forceStop: () => child.kill("SIGKILL"),
  };
}

module.exports = { available, latestIpswUrl, installMacOS, start };
