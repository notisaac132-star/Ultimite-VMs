// What this computer is, and which engine runs each OS on it.
//   qemu  - QEMU (Windows, Linux, ChromeOS and Windows-on-Mac VMs). Installed once from the app's setup banner.
//   apple - Apple's built-in Virtualization framework through the bundled macvm helper (macOS and Linux on Macs).
const os = require("os");

const platform = process.platform; // "win32" | "darwin" | "linux"
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const isAppleSilicon = platform === "darwin" && arch === "aarch64";

const info = {
  platform,
  arch,
  isAppleSilicon,
  cpus: os.cpus().length,
  memoryMB: Math.floor(os.totalmem() / 1024 / 1024),
  name: { win32: "Windows", darwin: "Mac", linux: "Linux" }[platform] || platform,
};

// Returns { engine, guestArch, warning } or { engine: null, reason }.
// options.quick: Quick Setup installs Linux hands-free, which needs QEMU (Apple's framework can't pass
// the installer its automatic-install settings), so on Macs Quick Setup runs Linux on QEMU.
function plan(entry, options = {}) {
  if (entry.family === "macos") {
    if (isAppleSilicon) return { engine: "apple", guestArch: "aarch64" };
    if (platform === "darwin") return { engine: null, reason: "macOS VMs need a Mac with Apple Silicon (M1 or newer). Apple's VM support doesn't run macOS on Intel Macs." };
    return {
      engine: null,
      reason: "Apple only allows macOS to run on Apple hardware, so macOS VMs are available in the Mac version of Ultimate VMs (on M1 or newer Macs).",
    };
  }

  if (entry.family === "windows") {
    // Windows ISOs from microsoft.com are x64, so ARM computers have to emulate them.
    const warning = arch === "aarch64" ? "This computer has an ARM chip, so Windows (x64) runs emulated. It works, but it's very slow." : undefined;
    return { engine: "qemu", guestArch: "x86_64", warning };
  }

  if (entry.archs && !entry.archs.includes(arch)) {
    return { engine: null, reason: `${entry.name} is only made for Intel/AMD computers, and this ${info.name} has an ARM chip.` };
  }
  // Linux and custom ISOs: Macs use Apple's built-in virtualization (fast, nothing to install).
  // ChromeOS Flex needs a PC-style machine, so it always runs on QEMU.
  const qemuOnMac = entry.family === "chromeos" || (options.quick && entry.autoInstall);
  return { engine: platform === "darwin" && !qemuOnMac ? "apple" : "qemu", guestArch: arch };
}

module.exports = { info, plan };
