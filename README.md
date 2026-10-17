<div align="center">

<img src="src/icon.png" width="110" alt="">

# Ultimate VMs

**Plug-and-play virtual machines.** Download the app, pick an operating system from a simple menu, and it sets everything up for you.

[**Download the latest version**](https://github.com/notisaac132-star/Ultimite-VMs/releases/latest)

</div>

---

## What you can run

| | On a Windows PC | On a Mac (Apple Silicon) | On an Intel Mac | On Linux |
|---|:-:|:-:|:-:|:-:|
| **Windows 11 / 10** | ✅ | ✅ (emulated, slow) | ✅ | ✅ |
| **macOS** | ❌ ¹ | ✅ | ❌ ² | ❌ ¹ |
| **ChromeOS Flex** | ✅ | ❌ ³ | ✅ | ✅ |
| **Ubuntu, Fedora, Debian** | ✅ | ✅ | ✅ | ✅ |
| **Linux Mint** | ✅ | ❌ ³ | ✅ | ✅ |
| **Any other .iso** | ✅ | ✅ | ✅ | ✅ |

¹ Apple's license only allows macOS to run on Apple hardware, so the app doesn't offer it on PCs.
² Apple's virtualization only runs macOS guests on Apple Silicon (M1 or newer).
³ Only made for Intel/AMD chips.

## How it works

Click **New VM** (or one of the big OS tiles), pick an OS, then choose:

### ⚡ Quick Setup (one click)

Uses recommended settings and downloads everything for you, then starts the VM by itself.

| OS | What Quick Setup does |
|---|---|
| **Windows 11 / 10** | Downloads Windows straight from Microsoft and **installs it with no questions**: no product key, no Microsoft account, TPM/Secure Boot checks skipped. You end up on the desktop as user **User** (no password) in about 20–40 minutes. |
| **macOS** | Downloads the newest macOS from Apple and installs it. Then you finish Apple's short welcome setup. |
| **ChromeOS Flex** | Downloads it from Google and starts it. Pick **Try it first** or **Install ChromeOS Flex**. |
| **Linux** | Downloads the newest version (checked with SHA-256) and opens its **live desktop** right away. Use its **Install** icon to keep it. |

### ⚙ Advanced Setup

Pick the name, processors, memory and disk size, and install from **your own file** (`.iso`; `.ipsw` for macOS; `.bin` for ChromeOS Flex), or switch to **Download it for me**.

When an OS is installed, shut it down and click **⋯ → Eject disc**. Your VMs live in a folder called **Ultimate VMs** in your home folder. Each card has **Start / Shut down / Force stop**, and the **⋯** menu has **Settings**, **Eject / Insert disc**, **Show files** and **Delete**.

Microsoft sometimes limits automatic downloads. If that happens, the VM card shows **Microsoft's site ↗** and **Choose ISO…** so you can download it in your browser and carry on.

### First launch on Windows and Linux

The app needs [QEMU](https://www.qemu.org) (free and open source) for Windows, Linux and ChromeOS VMs. Quick Setup installs it automatically the first time; you can also click **Install VM engine** on the setup banner. It uses Windows Package Manager, or your Linux package manager. Click **Yes** if Windows asks for permission.

If a VM is slow on Windows, the app offers **Turn on fast mode**, which switches on Windows' built-in *Hypervisor Platform* feature (needs a restart).

### On a Mac

macOS and Linux VMs use Apple's built-in Virtualization framework — nothing extra to install. Windows and ChromeOS VMs on a Mac need QEMU; it's installed with Homebrew (it opens Terminal and asks for your Mac password if Homebrew isn't installed yet).

## Installing the app

- **Windows:** `Ultimate-VMs-Windows-Setup.exe` (installer) or `Ultimate-VMs-Windows-Portable.exe` (no install). If Windows says *"Windows protected your PC"*, click **More info → Run anyway**.
- **Mac:** open `Ultimate-VMs-Mac.dmg` and drag the app into Applications. If it says *"Apple could not verify…"*, go to  → System Settings → Privacy & Security and click **Open Anyway**.
- **Linux:** download `Ultimate-VMs-Linux.AppImage`, make it executable (`chmod +x`) and run it.

Installed copies update themselves.

## For developers

```sh
npm install
npm start              # run from source
npm run build:windows  # or build:mac / build:linux
```

| Path | What it is |
|---|---|
| `src/main.js` | Electron entry point and IPC bridge |
| `src/ui/` | The menu (VM cards, New VM wizard, settings) |
| `src/vms.js` | The VM library: create, prepare (download disc, make disk), start, stop |
| `src/catalog.js` | The OS list and where each install disc comes from |
| `src/host.js` | Decides which engine runs each OS on this computer |
| `src/engines/qemu.js` | QEMU engine (Windows/Linux hosts, Windows-on-Mac) |
| `src/engines/apple.js` + `mac/macvm/main.swift` | Apple Virtualization engine (macOS and Linux on Macs) |
| `.github/workflows/build.yml` | Builds all three apps on every push and publishes a release from the default branch |
