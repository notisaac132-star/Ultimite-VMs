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
| **Ubuntu, Fedora, Debian** | ✅ | ✅ | ✅ | ✅ |
| **Linux Mint** | ✅ | ❌ (no ARM version) | ✅ | ✅ |
| **Any other .iso** | ✅ | ✅ | ✅ | ✅ |

¹ Apple's license only allows macOS to run on Apple hardware, so the app doesn't offer it on PCs.
² Apple's virtualization only runs macOS guests on Apple Silicon (M1 or newer).

## How it works

1. **Open the app** and click **New VM** (or one of the big OS tiles).
2. **Pick an OS.** Adjust processors, memory and disk with the sliders if you want.
3. **Install disc — automatic for every OS:**
   - **Windows** — downloaded straight from Microsoft's servers (in your computer's language). During setup click **"I don't have a product key"**; Windows installs and runs without one.
   - **Linux** — downloaded from the official site and checked (SHA-256) before use.
   - **macOS** — downloaded straight from Apple and installed for you.
   - Already have an ISO? Click **"Already have the ISO file? Use it instead"**.

   Microsoft sometimes limits automatic downloads. If that happens the VM card shows **Microsoft's site ↗** and **Choose ISO…**, so you can download it in your browser and carry on.
4. Click **Start**. The VM opens in its own window. Install the OS like on a real computer.
5. When the OS is installed, shut it down and click **⋯ → Eject disc**.

Your VMs live in a folder called **Ultimate VMs** in your home folder. Each card in the app has **Start / Shut down / Force stop**, and the **⋯** menu has **Settings**, **Eject / Insert disc**, **Show files** and **Delete**.

### First launch on Windows and Linux

The app shows a **one-time setup** banner: click **Install VM engine**. It installs [QEMU](https://www.qemu.org) (free and open source) using Windows Package Manager, or your Linux package manager. Click **Yes** if Windows asks for permission.

If a VM is slow on Windows, the app offers **Turn on fast mode**, which switches on Windows' built-in *Hypervisor Platform* feature (needs a restart).

### Windows 11 without TPM

Windows 11 normally refuses to install without TPM 2.0 and Secure Boot. Ultimate VMs gives the installer a small answer file that skips those checks, so it just works.

### On a Mac

macOS and Linux VMs use Apple's built-in Virtualization framework — nothing extra to install. Windows VMs on a Mac need QEMU; the setup banner installs it with Homebrew (it opens Terminal and asks for your Mac password if Homebrew isn't installed yet).

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
