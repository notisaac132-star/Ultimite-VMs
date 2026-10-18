// The operating systems offered in the "New VM" menu, and where each one's install disc comes from.
//
// source.type:
//   "auto"   - the app finds the newest official ISO and downloads it (resolve() returns { url, sha256?, file }).
//              The user can always pick an ISO they already have instead.
//   "manual" - the user picks an .iso file (the "Other" entry).
//   "ipsw"   - macOS: the restore image comes straight from Apple (only on Apple Silicon Macs, see engines/apple.js).

// Picks the newest file whose name matches `pattern` from a SHA256SUMS-style listing ("<hash> [*]<file>").
async function fromChecksums(fetchText, base, sumsFile, pattern) {
  const text = await fetchText(base + sumsFile);
  const files = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (m && pattern.test(m[2])) files.push({ sha256: m[1].toLowerCase(), file: m[2] });
  }
  if (!files.length) throw new Error(`No matching download found at ${base}`);
  files.sort((a, b) => compareVersions(a.file, b.file));
  const best = files[files.length - 1];
  return { url: base + best.file, sha256: best.sha256, file: best.file };
}

// Compares the first version number in each name: "ubuntu-24.04.10-…" sorts after "ubuntu-24.04.9-…".
function compareVersions(a, b) {
  const version = (s) => (s.match(/\d+(?:\.\d+)*/) || ["0"])[0].split(".");
  const pa = version(a);
  const pb = version(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] || 0) - Number(pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Windows: asks microsoft.com for a (24-hour) direct ISO link, the same way its download page does.
// If Microsoft refuses (it rate-limits automated requests now and then), the error tells the user how to
// get the ISO from the page instead; `page` is shown as a button on the VM card.
// Computer language → [Microsoft's ISO language name, Windows culture used by the automatic install].
const MS_LANGUAGES = {
  "en-US": ["English", "en-US"], "en-GB": ["English International", "en-GB"], en: ["English", "en-US"],
  es: ["Spanish", "es-ES"], "es-MX": ["Spanish (Mexico)", "es-MX"], "es-419": ["Spanish (Mexico)", "es-MX"],
  fr: ["French", "fr-FR"], "fr-CA": ["French Canadian", "fr-CA"], de: ["German", "de-DE"], it: ["Italian", "it-IT"],
  "pt-BR": ["Brazilian Portuguese", "pt-BR"], pt: ["Portuguese", "pt-PT"], nl: ["Dutch", "nl-NL"], pl: ["Polish", "pl-PL"],
  ru: ["Russian", "ru-RU"], uk: ["Ukrainian", "uk-UA"], tr: ["Turkish", "tr-TR"], ar: ["Arabic", "ar-SA"], he: ["Hebrew", "he-IL"],
  ja: ["Japanese", "ja-JP"], ko: ["Korean", "ko-KR"], "zh-CN": ["Chinese Simplified", "zh-CN"], "zh-TW": ["Chinese Traditional", "zh-TW"],
  sv: ["Swedish", "sv-SE"], da: ["Danish", "da-DK"], nb: ["Norwegian", "nb-NO"], fi: ["Finnish", "fi-FI"], cs: ["Czech", "cs-CZ"],
  el: ["Greek", "el-GR"], hu: ["Hungarian", "hu-HU"], ro: ["Romanian", "ro-RO"], th: ["Thai", "th-TH"],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GIB = 1024 ** 3;

// One try at Microsoft's regular download page API (the same calls its web page makes). Returns null when
// Microsoft's download protection ("Sentinel") turns the request away.
async function microsoftOnce(pageName, fetchText, locale) {
  const page = `https://www.microsoft.com/en-us/software-download/${pageName}`;
  const html = await fetchText(page);
  const edition = html.match(/<option value="(\d+)">[^<]*ISO[^<]*<\/option>/i);
  if (!edition) throw new Error("Microsoft's download page changed.");

  const session = require("crypto").randomUUID();
  // Registers the session with Microsoft's download protection, as the web page does, then gives it a
  // moment (the page's own script does the same before asking for links).
  await fetchText(`https://vlscppe.microsoft.com/tags?org_id=y6jn8c31&session_id=${session}`, { referrer: page }).catch(() => {});
  await wait(1500);

  const api = "https://www.microsoft.com/software-download-connector/api/";
  const query = `profile=606624d44113&friendlyFileName=undefined&Locale=en-US&sessionID=${session}`;
  const { Skus: skus = [] } = JSON.parse(await fetchText(`${api}getskuinformationbyproductedition?${query}&ProductEditionId=${edition[1]}&SKU=undefined`, { referrer: page }));
  const wanted = [MS_LANGUAGES[locale], MS_LANGUAGES[locale.split("-")[0]], MS_LANGUAGES.en].filter(Boolean);
  const match = wanted.map(([name, culture]) => ({ culture, sku: skus.find((s) => s.Language === name) })).find((m) => m.sku);
  const sku = match?.sku || skus[0];
  if (!sku) return null;

  const links = JSON.parse(await fetchText(`${api}GetProductDownloadLinksBySku?${query}&productEditionId=undefined&SKU=${sku.Id}`, { referrer: page }));
  const options = links.ProductDownloadOptions || [];
  const iso = options.find((o) => /x64/i.test(o.Uri)) || options[0];
  if (!iso) return null;
  return { url: iso.Uri, file: decodeURIComponent(new URL(iso.Uri).pathname.split("/").pop()), culture: match?.culture || "en-US" };
}

// Windows ISO sources, tried in this order until one works:
//   1. Microsoft's regular download (the real, retail Windows). Retried with fresh sessions, because its
//      download protection turns away a good share of requests at random.
//   2. Microsoft's Evaluation Center ISO: direct links without that protection. It's Windows Enterprise
//      that runs 90 days without a key (then shows a watermark); same Windows, same features.
//   3. The user downloads it in their browser (the VM card's "Choose ISO…").
const microsoft = (pageName, evalLinks) => async (_arch, fetchText, locale = "en-US", { resolveRedirect } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const found = await microsoftOnce(pageName, fetchText, locale);
      if (found) return found;
    } catch (err) {
      lastError = err;
    }
    await wait(2000 * (attempt + 1));
  }

  for (const link of evalLinks || []) {
    try {
      const { url, size } = await resolveRedirect(link);
      // A real Windows disc is a multi-gigabyte .iso; anything else (an error page, a changed link) is skipped.
      if (/\.iso($|\?)/i.test(url) && size > 3 * GIB) {
        return { url, file: decodeURIComponent(new URL(url).pathname.split("/").pop()), culture: "en-US", trial: true };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    "Microsoft's servers didn't hand out the Windows download (they limit automated downloads, and it can take a few tries).\n" +
    "Click “Resume setup” to try again, or download the ISO on Microsoft's site and click “Choose ISO…”." +
    (lastError ? `\n(${lastError.message})` : ""));
};

// Microsoft Evaluation Center direct links (Windows 11 / 10 Enterprise, English).
const EVAL_WIN11 = ["https://go.microsoft.com/fwlink/?linkid=2289031&clcid=0x409&culture=en-us&country=us"];
const EVAL_WIN10 = ["https://go.microsoft.com/fwlink/p/?LinkID=2208844&clcid=0x409&culture=en-us&country=US"];

// ChromeOS Flex: the newest stable image from Google's recovery list (a zipped USB-stick image).
async function chromeosFlex(_arch, fetchText) {
  const list = JSON.parse(await fetchText("https://dl.google.com/dl/edgedl/chromeos/recovery/cloudready_recovery2.json"));
  const images = list
    .filter((i) => /reven/i.test(i.url || "") && /\.zip$/i.test(i.url) && (!i.channel || /stable/i.test(i.channel)))
    .sort((a, b) => compareVersions(a.version || a.file || "", b.version || b.file || ""));
  const image = images.pop();
  if (!image) throw new Error("Google's ChromeOS Flex download list didn't include an image.");
  return { url: image.url, file: image.url.split("/").pop(), unzip: true };
}

const ubuntu = (version) => async (arch, fetchText) => {
  const amd = arch === "x86_64";
  const base = amd ? `https://releases.ubuntu.com/${version}/` : `https://cdimage.ubuntu.com/releases/${version}/release/`;
  const a = amd ? "amd64" : "arm64";
  return fromChecksums(fetchText, base, "SHA256SUMS", new RegExp(`^ubuntu-[\\d.]+-desktop-${a}\\.iso$`));
};

// What "Quick Setup" does for each kind of OS (shown before the user clicks it).
const QUICK_WINDOWS = "Downloads Windows from Microsoft and installs it by itself, with no questions. In about 20–40 minutes you're on the Windows desktop (user “User”, no password).";
const QUICK_LINUX = (name) => `Downloads ${name} and installs it by itself, with no questions. When it's done you're on the ${name} desktop (user “user”, password “user”).`;

const CATALOG = [
  {
    id: "windows11",
    name: "Windows 11",
    family: "windows",
    logo: "windows",
    blurb: "Microsoft's latest Windows, downloaded straight from Microsoft. No product key needed to install.",
    quick: QUICK_WINDOWS,
    defaults: { cpus: 4, memoryMB: 8192, diskGB: 80 },
    firmware: "uefi",
    // Windows 11 normally refuses to install without TPM 2.0 / Secure Boot; the app answers those checks for you.
    bypassChecks: true,
    unattended: true,
    source: { type: "auto", resolve: microsoft("windows11", EVAL_WIN11), page: "https://www.microsoft.com/software-download/windows11" },
  },
  {
    id: "windows10",
    name: "Windows 10",
    family: "windows",
    logo: "windows",
    blurb: "The classic, downloaded straight from Microsoft. Runs well on older or slower computers.",
    quick: QUICK_WINDOWS,
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 64 },
    firmware: "bios",
    unattended: true,
    source: { type: "auto", resolve: microsoft("windows10ISO", EVAL_WIN10), page: "https://www.microsoft.com/software-download/windows10ISO" },
  },
  {
    id: "macos",
    name: "macOS",
    family: "macos",
    logo: "apple",
    blurb: "The newest macOS, downloaded straight from Apple. Needs a Mac with Apple Silicon (M1 or newer).",
    quick: "Downloads the newest macOS from Apple and installs it for you (20–40 minutes). Then finish Apple's short welcome setup and you're on the desktop.",
    defaults: { cpus: 4, memoryMB: 8192, diskGB: 80 },
    source: { type: "ipsw" },
  },
  {
    id: "ubuntu",
    name: "Ubuntu 26.04 LTS",
    family: "linux",
    logo: "ubuntu",
    blurb: "The most popular Linux desktop. Downloaded automatically.",
    quick: QUICK_LINUX("Ubuntu"),
    autoInstall: "ubuntu",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    source: { type: "auto", resolve: ubuntu("26.04") },
  },
  {
    id: "ubuntu2404",
    name: "Ubuntu 24.04 LTS",
    family: "linux",
    logo: "ubuntu",
    blurb: "The previous long-term Ubuntu release. Downloaded automatically.",
    quick: QUICK_LINUX("Ubuntu"),
    autoInstall: "ubuntu",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    source: { type: "auto", resolve: ubuntu("24.04") },
  },
  {
    id: "fedora",
    name: "Fedora Workstation",
    family: "linux",
    logo: "fedora",
    blurb: "Cutting-edge Linux with the newest GNOME desktop. Downloaded automatically.",
    quick: QUICK_LINUX("Fedora"),
    autoInstall: "fedora",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    source: {
      type: "auto",
      resolve: async (arch, fetchText) => {
        const releases = JSON.parse(await fetchText("https://fedoraproject.org/releases.json"));
        const iso = releases
          .filter((r) => r.variant === "Workstation" && r.arch === arch && /^\d+$/.test(r.version) && /\.iso$/.test(r.link))
          .sort((a, b) => Number(a.version) - Number(b.version))
          .pop();
        if (!iso) throw new Error("Fedora doesn't offer a Workstation ISO for this computer.");
        return { url: iso.link, sha256: iso.sha256, file: iso.link.split("/").pop() };
      },
      // Hands-free installs use Fedora's network installer (kickstart doesn't work with the live desktop ISO).
      resolveInstaller: async (arch, fetchText) => {
        const releases = JSON.parse(await fetchText("https://fedoraproject.org/releases.json"));
        const iso = releases
          .filter((r) => r.variant === "Everything" && r.arch === arch && /^\d+$/.test(r.version) && /netinst.*\.iso$/i.test(r.link))
          .sort((a, b) => Number(a.version) - Number(b.version))
          .pop();
        if (!iso) throw new Error("Fedora doesn't offer a network installer for this computer.");
        return { url: iso.link, sha256: iso.sha256, file: iso.link.split("/").pop() };
      },
    },
  },
  {
    id: "debian",
    name: "Debian",
    family: "linux",
    logo: "debian",
    blurb: "Rock-solid, lightweight Linux. Downloaded automatically.",
    quick: QUICK_LINUX("Debian"),
    autoInstall: "debian",
    defaults: { cpus: 2, memoryMB: 2048, diskGB: 25 },
    source: {
      type: "auto",
      resolve: (arch, fetchText) =>
        arch === "x86_64"
          ? fromChecksums(fetchText, "https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/", "SHA256SUMS", /^debian-live-[\d.]+-amd64-gnome\.iso$/)
          : fromChecksums(fetchText, "https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/", "SHA256SUMS", /^debian-[\d.]+-arm64-netinst\.iso$/),
    },
  },
  {
    id: "mint",
    name: "Linux Mint",
    family: "linux",
    logo: "mint",
    blurb: "Feels like Windows — great first Linux. Downloaded automatically (Intel/AMD computers only).",
    quick: QUICK_LINUX("Linux Mint"),
    autoInstall: "mint",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    archs: ["x86_64"],
    source: {
      type: "auto",
      resolve: async (_arch, fetchText) => {
        const base = "https://mirrors.kernel.org/linuxmint/stable/";
        const versions = [...(await fetchText(base)).matchAll(/href="(\d+(?:\.\d+)*)\/"/g)].map((m) => m[1]);
        if (!versions.length) throw new Error("Couldn't find the latest Linux Mint version.");
        versions.sort(compareVersions);
        return fromChecksums(fetchText, `${base}${versions.pop()}/`, "sha256sum.txt", /^linuxmint-[\d.]+-cinnamon-64bit\.iso$/);
      },
    },
  },
  {
    id: "chromeos",
    name: "ChromeOS Flex",
    family: "chromeos",
    logo: "chrome",
    blurb: "Google's ChromeOS for PCs and Macs, downloaded straight from Google. Sign in with your Google account.",
    quick: "Downloads ChromeOS Flex from Google and starts it. Click “Try it first” to use it right away, or “Install ChromeOS Flex” to keep it.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 32 },
    firmware: "uefi",
    archs: ["x86_64"],
    source: { type: "auto", resolve: chromeosFlex },
  },
  {
    id: "custom",
    name: "Other (my own ISO)",
    family: "other",
    logo: "disc",
    blurb: "Any other operating system: pick an .iso file you already have.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 40 },
    source: { type: "manual" },
  },
];

const byId = (id) => CATALOG.find((os) => os.id === id);

module.exports = { CATALOG, byId, compareVersions };
