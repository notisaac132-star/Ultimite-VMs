// QEMU engine: finds or installs QEMU, creates disks and starts VMs.
// A running VM is controlled through QMP (QEMU's JSON control socket) on a local TCP port.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { info } = require("../host");
const autoinstall = require("../autoinstall");

// Commas separate QEMU options, so commas inside file paths are doubled.
const q = (file) => String(file).replace(/,/g, ",,");

const exe = (name) => (info.platform === "win32" ? `${name}.exe` : name);

function searchDirs() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (info.platform === "win32") {
    dirs.unshift(path.join(process.env.ProgramFiles || "C:\\Program Files", "qemu"));
  } else if (info.platform === "darwin") {
    dirs.unshift("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin");
  } else {
    dirs.push("/usr/bin", "/usr/local/bin");
  }
  return [...new Set(dirs)];
}

// Returns { system, img, shareDirs } for the guest architecture, or null when QEMU isn't installed.
function find(guestArch = "x86_64") {
  for (const dir of searchDirs()) {
    const system = path.join(dir, exe(`qemu-system-${guestArch}`));
    const img = path.join(dir, exe("qemu-img"));
    if (fs.existsSync(system) && fs.existsSync(img)) {
      const shareDirs = [
        path.join(dir, "share"), // Windows installer layout
        path.join(dir, "..", "share", "qemu"), // Homebrew / MacPorts / /usr/local
        "/usr/share/qemu",
        "/usr/share/OVMF",
        "/usr/share/ovmf",
        "/usr/share/edk2/ovmf",
        "/usr/share/edk2/x64",
        "/usr/share/AAVMF",
        "/usr/share/edk2/aarch64",
        "/usr/share/qemu-efi-aarch64",
      ];
      return { system, img, shareDirs };
    }
  }
  return null;
}

// UEFI firmware: a read-only code file plus a template for the VM's own settings (NVRAM) file.
const FIRMWARE = {
  x86_64: [
    ["edk2-x86_64-code.fd", "edk2-i386-vars.fd"],
    ["OVMF_CODE_4M.fd", "OVMF_VARS_4M.fd"],
    ["OVMF_CODE.fd", "OVMF_VARS.fd"],
  ],
  aarch64: [
    ["edk2-aarch64-code.fd", "edk2-arm-vars.fd"],
    ["AAVMF_CODE.fd", "AAVMF_VARS.fd"],
    ["QEMU_EFI.fd", "QEMU_VARS.fd"],
  ],
};

function findFirmware(qemu, guestArch) {
  for (const [code, vars] of FIRMWARE[guestArch]) {
    for (const dir of qemu.shareDirs) {
      const c = path.join(dir, code);
      const v = path.join(dir, vars);
      if (fs.existsSync(c) && fs.existsSync(v)) return { code: c, vars: v };
    }
  }
  return null;
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

async function createDisk(vm, dir) {
  const qemu = find(vm.guestArch);
  if (!qemu) throw new Error("QEMU isn't installed yet. Click “Install VM engine” at the top of the window.");
  const disk = path.join(dir, "disk.qcow2");
  if (!fs.existsSync(disk)) await run(qemu.img, ["create", "-f", "qcow2", disk, `${vm.diskGB}G`]);
}

async function resizeDisk(vm, dir) {
  const qemu = find(vm.guestArch);
  if (qemu) await run(qemu.img, ["resize", path.join(dir, "disk.qcow2"), `${vm.diskGB}G`]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Windows Setup reads autounattend.xml from any attached drive; here it's a folder QEMU shows to the VM as a
// USB stick. It always answers Windows 11's TPM / Secure Boot / CPU / RAM checks. For Quick Setup
// (vm.unattended) it also answers every setup question: wipe the virtual disk, install Windows Pro with
// Microsoft's generic install key (no activation), and create the auto-login account "User" (no password).
function unattendXml(vm) {
  const component = (name, body) =>
    `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n${body}\n    </component>`;
  const commands = (list) => !list.length ? "" : `      <RunSynchronous>\n${list.map((cmd, i) =>
    `        <RunSynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Path>${cmd}</Path></RunSynchronousCommand>`).join("\n")}\n      </RunSynchronous>`;
  const reg = (key, name) => `reg add ${key} /v ${name} /t REG_DWORD /d 1 /f`;
  const bypass = vm.bypassChecks
    ? ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck", "BypassStorageCheck"].map((n) => reg("HKLM\\SYSTEM\\Setup\\LabConfig", n))
    : [];
  const locale = (c) => `      <InputLocale>${c}</InputLocale>\n      <SystemLocale>${c}</SystemLocale>\n      <UILanguage>${c}</UILanguage>\n      <UserLocale>${c}</UserLocale>`;
  const noPassword = "<Password><Value></Value><PlainText>true</PlainText></Password>";
  const partition = (order, inner) => `<CreatePartition wcm:action="add"><Order>${order}</Order>${inner}</CreatePartition>`;
  const modify = (order, inner) => `<ModifyPartition wcm:action="add"><Order>${order}</Order><PartitionID>${order}</PartitionID>${inner}</ModifyPartition>`;
  const uefi = vm.firmware === "uefi";

  const passes = [];
  if (!vm.unattended) {
    passes.push(`  <settings pass="windowsPE">\n${component("Microsoft-Windows-Setup", commands(bypass))}\n  </settings>`);
  } else {
    const c = vm.culture || "en-US";
    const disk = uefi
      ? [partition(1, "<Type>EFI</Type><Size>300</Size>"), partition(2, "<Type>MSR</Type><Size>16</Size>"), partition(3, "<Type>Primary</Type><Extend>true</Extend>")].join("")
        + `</CreatePartitions><ModifyPartitions>${modify(1, "<Format>FAT32</Format><Label>System</Label>")}${modify(2, "")}${modify(3, "<Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter>")}`
      : partition(1, "<Type>Primary</Type><Extend>true</Extend>")
        + `</CreatePartitions><ModifyPartitions>${modify(1, "<Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter><Active>true</Active>")}`;
    passes.push(`  <settings pass="windowsPE">
${component("Microsoft-Windows-International-Core-WinPE", `      <SetupUILanguage><UILanguage>${c}</UILanguage></SetupUILanguage>\n${locale(c)}`)}
${component("Microsoft-Windows-Setup", `${commands(bypass)}
      <DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>${disk}</ModifyPartitions></Disk></DiskConfiguration>
      <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>${uefi ? 3 : 1}</PartitionID></InstallTo></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula>${vm.trial ? "" : "<ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>OnError</WillShowUI></ProductKey>"}</UserData>`)}
  </settings>`);
    passes.push(`  <settings pass="specialize">
${component("Microsoft-Windows-Deployment", commands([reg("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE", "BypassNRO")]))}
  </settings>`);
    passes.push(`  <settings pass="oobeSystem">
${component("Microsoft-Windows-International-Core", locale(c))}
${component("Microsoft-Windows-Shell-Setup", `      <AutoLogon><Enabled>true</Enabled><Username>User</Username>${noPassword}<LogonCount>9999999</LogonCount></AutoLogon>
      <OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>User</Name><Group>Administrators</Group>${noPassword}</LocalAccount></LocalAccounts></UserAccounts>`)}
  </settings>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
${passes.join("\n")}
</unattend>
`;
}

function audioArgs() {
  const backend = { win32: "dsound", darwin: "coreaudio" }[info.platform];
  return backend ? ["-audiodev", `${backend},id=snd0`, "-device", "intel-hda", "-device", "hda-duplex,audiodev=snd0"] : [];
}

function accelArgs(guestArch) {
  if (guestArch !== info.arch) return ["-accel", "tcg"];
  const fast = { win32: "whpx,kernel-irqchip=off", darwin: "hvf", linux: "kvm" }[info.platform];
  // QEMU tries each -accel in order, so it falls back to (slower) emulation if hardware virtualization is off.
  return [...(fast ? ["-accel", fast] : []), "-accel", "tcg"];
}

// boot: { kernel, initrd, append } to start a Linux installer hands-free (see autoinstall.js).
function buildArgs(vm, dir, qmpPort, boot = null) {
  const windows = vm.family === "windows";
  // ChromeOS Flex comes as a USB-stick image and wants PC-style (SATA/Intel) hardware with a virtio display.
  const chromeos = vm.family === "chromeos";
  const pcHardware = windows || chromeos;
  const x86 = vm.guestArch === "x86_64";
  const disk = path.join(dir, "disk.qcow2");
  const args = [
    "-name", vm.name.replace(/,/g, " "),
    "-machine", x86 ? "q35" : "virt",
    ...accelArgs(vm.guestArch),
    "-cpu", "max",
    "-smp", String(vm.cpus),
    "-m", String(vm.memoryMB),
    "-qmp", `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
    "-device", "qemu-xhci,id=xhci",
    "-device", "usb-tablet",
  ];

  if (vm.firmware === "uefi" || !x86) {
    const qemu = find(vm.guestArch);
    const fw = findFirmware(qemu, vm.guestArch);
    if (!fw) throw new Error("QEMU's UEFI firmware files are missing. Reinstall QEMU (on Linux: install the ovmf package).");
    const vars = path.join(dir, "efi-vars.fd");
    if (!fs.existsSync(vars)) fs.copyFileSync(fw.vars, vars);
    args.push(
      "-drive", `if=pflash,format=raw,readonly=on,file=${q(fw.code)}`,
      "-drive", `if=pflash,format=raw,file=${q(vars)}`,
    );
  }

  if (boot) {
    // Hands-free Linux install: boot the installer's kernel directly. -no-reboot makes QEMU exit when the
    // installer finishes, so the next start boots the installed system from the disk.
    args.push("-kernel", boot.kernel, "-initrd", boot.initrd, "-append", boot.append, "-no-reboot");
  }

  // The disk boots first; while it's still empty the firmware falls through to the install disc.
  args.push("-drive", `file=${q(disk)},if=none,id=hd0,format=qcow2,discard=unmap`);
  if (pcHardware) args.push("-device", "ide-hd,drive=hd0,bus=ide.0,bootindex=0");
  else args.push("-device", "virtio-blk-pci,drive=hd0,bootindex=0");

  if (vm.iso && chromeos) {
    // snapshot=on: the live system can write to the stick without changing the downloaded image.
    args.push("-drive", `file=${q(vm.iso)},if=none,id=usb0,format=raw,snapshot=on`, "-device", "usb-storage,drive=usb0,bootindex=1");
  } else if (vm.iso) {
    args.push("-drive", `file=${q(vm.iso)},if=none,id=cd0,media=cdrom,readonly=on`);
    if (x86) args.push("-device", "ide-cd,drive=cd0,bus=ide.1,bootindex=1");
    else args.push("-device", "virtio-scsi-pci,id=scsi0", "-device", "scsi-cd,drive=cd0,bus=scsi0.0,bootindex=1");
  }

  if ((vm.bypassChecks || vm.unattended) && vm.iso && !vm.installed) {
    const unattend = path.join(dir, "unattend");
    fs.mkdirSync(unattend, { recursive: true });
    fs.writeFileSync(path.join(unattend, "autounattend.xml"), unattendXml(vm));
    args.push("-drive", `file=fat:rw:${q(unattend)},if=none,id=ud0,format=raw`, "-device", "usb-storage,drive=ud0");
  }

  if (chromeos) {
    args.push("-device", "virtio-vga");
  } else if (x86) {
    args.push("-vga", "std");
  } else {
    args.push("-device", "virtio-gpu-pci", "-device", "usb-kbd");
  }
  args.push("-nic", `user,model=${pcHardware ? "e1000e" : "virtio-net-pci"}`);
  if (windows) args.push("-rtc", "base=localtime");
  args.push(...audioArgs());
  // A directly booted kernel takes the first boot slot, so the devices drop theirs.
  return boot ? args.map((a) => a.replace(/,bootindex=\d+/, "")) : args;
}

// Minimal QMP client: connects, enables commands, then sends one JSON command per call.
function qmpConnect(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n");
        resolve({
          send: (execute, args) => sock.writable && sock.write(JSON.stringify(args ? { execute, arguments: args } : { execute }) + "\n"),
          close: () => sock.destroy(),
        });
      });
      sock.once("error", () => {
        sock.destroy();
        if (left > 0) setTimeout(() => attempt(left - 1), 250);
        else reject(new Error("Couldn't connect to the VM."));
      });
    };
    attempt(tries);
  });
}

// Starts the VM in its own window. Returns { stop(), forceStop() } and calls onExit({ code, log, slow }).
async function start(vm, dir, { onExit }) {
  const qemu = find(vm.guestArch);
  if (!qemu) throw new Error("QEMU isn't installed yet. Click “Install VM engine” at the top of the window.");
  const port = await freePort();
  const args = buildArgs(vm, dir, port, await autoinstall.prepareBoot(vm, dir));
  const child = spawn(qemu.system, args, { cwd: dir, windowsHide: true });
  let log = "";
  child.stderr.on("data", (d) => { log = (log + d).slice(-8000); });
  child.stdout.on("data", (d) => { log = (log + d).slice(-8000); });

  let qmp = null;
  let pressKeys = null;
  child.once("spawn", async () => {
    try {
      qmp = await qmpConnect(port);
      // UEFI Windows discs wait for "Press any key to boot from CD"; press Enter for the first few seconds.
      if (vm.family === "windows" && vm.iso && !vm.installed) {
        let n = 0;
        pressKeys = setInterval(() => {
          qmp.send("send-key", { keys: [{ type: "qcode", data: "ret" }] });
          if (++n >= 24) clearInterval(pressKeys);
        }, 500);
      }
    } catch {
      // The VM still runs; only the Stop button falls back to killing the process.
    }
  });
  child.once("error", (err) => { log += `\n${err.message}`; });
  child.once("close", (code) => {
    clearInterval(pressKeys);
    if (qmp) qmp.close();
    const slow = /(whpx|hvf|kvm).*(fail|not|error|unavailable|no accelerator)|could not access KVM|No accelerator found/i.test(log);
    onExit({ code, log, slow });
  });

  return {
    stop: () => (qmp ? qmp.send("system_powerdown") : child.kill()),
    forceStop: () => (qmp ? qmp.send("quit") : child.kill("SIGKILL")),
  };
}

// One-time QEMU install. onLog(text) receives installer output.
function install(onLog) {
  const runStreaming = (file, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(file, args, { windowsHide: true, ...opts });
      child.stdout?.on("data", (d) => onLog(String(d)));
      child.stderr?.on("data", (d) => onLog(String(d)));
      child.once("error", (err) => resolve({ ok: false, message: err.message }));
      child.once("close", (code) => resolve({ ok: code === 0, code }));
    });

  if (info.platform === "win32") {
    onLog("Installing QEMU with Windows Package Manager (click Yes if Windows asks)…\n");
    return runStreaming("winget", [
      "install", "--id", "SoftwareFreedomConservancy.QEMU", "-e", "--silent",
      "--accept-package-agreements", "--accept-source-agreements",
    ]).then((r) => (r.ok || find() ? { ok: true } : {
      ok: false,
      message: "Windows couldn't install QEMU automatically. Download it from qemu.weilnetz.de/w64, run the installer, then restart this app.",
      url: "https://qemu.weilnetz.de/w64/",
    }));
  }

  if (info.platform === "darwin") {
    const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((b) => fs.existsSync(b));
    if (brew) {
      onLog("Installing QEMU with Homebrew…\n");
      return runStreaming(brew, ["install", "qemu"], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } })
        .then((r) => (r.ok ? { ok: true } : { ok: false, message: "Homebrew couldn't install QEMU. See the log above." }));
    }
    // No Homebrew: open Terminal with the official one-line installers (it asks for the Mac's password).
    const script =
      '/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\" && ' +
      '(/opt/homebrew/bin/brew install qemu || /usr/local/bin/brew install qemu) && echo && echo Done! You can close this window and go back to Ultimate VMs.';
    return runStreaming("osascript", ["-e", `tell application "Terminal" to activate`, "-e", `tell application "Terminal" to do script "${script}"`])
      .then(() => ({ ok: false, pending: true, message: "A Terminal window opened to install QEMU. Type your Mac password when it asks, wait for “Done!”, then click Check again." }));
  }

  // Linux: ask for the admin password with pkexec and use the distro's package manager.
  const managers = [
    ["apt-get", ["install", "-y", "qemu-system-x86", "qemu-system-arm", "qemu-utils", "ovmf", "qemu-efi-aarch64"]],
    ["dnf", ["install", "-y", "qemu-kvm", "qemu-img", "edk2-ovmf", "edk2-aarch64"]],
    ["pacman", ["-S", "--noconfirm", "qemu-full", "edk2-ovmf"]],
    ["zypper", ["install", "-y", "qemu-x86", "qemu-arm", "qemu-tools", "qemu-ovmf-x86_64"]],
  ];
  const found = managers.find(([m]) => ["/usr/bin", "/bin"].some((d) => fs.existsSync(path.join(d, m))));
  if (!found) return Promise.resolve({ ok: false, message: "Install QEMU with your package manager, then click Check again." });
  onLog(`Installing QEMU with ${found[0]}…\n`);
  return runStreaming("pkexec", [found[0], ...found[1]]).then((r) =>
    r.ok ? { ok: true } : { ok: false, message: `Couldn't install automatically. Run: sudo ${found[0]} ${found[1].join(" ")}` });
}

// Windows only: turns on "Windows Hypervisor Platform" so VMs run at full speed (asks for admin, needs a restart).
function enableFastMode() {
  if (info.platform !== "win32") return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const cmd = "Start-Process dism.exe -Verb RunAs -Wait -ArgumentList '/online','/enable-feature','/featurename:HypervisorPlatform','/all','/norestart'";
    execFile("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true }, (err) =>
      resolve(err ? { ok: false, message: err.message } : { ok: true, message: "Done. Restart your computer to finish turning on fast mode." }));
  });
}

module.exports = { find, createDisk, resizeDisk, start, install, enableFastMode, buildArgs, unattendXml };
