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
const MS_LANGUAGES = {
  "en-US": "English", "en-GB": "English International", en: "English", es: "Spanish", "es-MX": "Spanish (Mexico)",
  fr: "French", "fr-CA": "French Canadian", de: "German", it: "Italian", "pt-BR": "Brazilian Portuguese", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian", tr: "Turkish", ar: "Arabic", he: "Hebrew", ja: "Japanese",
  ko: "Korean", "zh-CN": "Chinese Simplified", "zh-TW": "Chinese Traditional", sv: "Swedish", da: "Danish", nb: "Norwegian",
  fi: "Finnish", cs: "Czech", el: "Greek", hu: "Hungarian", ro: "Romanian", th: "Thai", vi: "Vietnamese",
};

const microsoft = (pageName) => async (_arch, fetchText, locale = "en-US") => {
  const page = `https://www.microsoft.com/en-us/software-download/${pageName}`;
  const html = await fetchText(page);
  const edition = html.match(/<option value="(\d+)">[^<]*ISO[^<]*<\/option>/i);
  if (!edition) throw new Error("Microsoft's download page changed. Use “Choose ISO” with an ISO from microsoft.com instead.");

  const session = require("crypto").randomUUID();
  // Registers the session with Microsoft's download protection, as the web page does.
  await fetchText(`https://vlscppe.microsoft.com/tags?org_id=y6jn8c31&session_id=${session}`).catch(() => {});

  const api = "https://www.microsoft.com/software-download-connector/api/";
  const query = `profile=606624d44113&friendlyFileName=undefined&Locale=en-US&sessionID=${session}`;
  const { Skus: skus = [] } = JSON.parse(await fetchText(`${api}getskuinformationbyproductedition?${query}&ProductEditionId=${edition[1]}&SKU=undefined`, { referrer: page }));
  const wanted = [MS_LANGUAGES[locale], MS_LANGUAGES[locale.split("-")[0]], "English"];
  const sku = wanted.map((lang) => skus.find((s) => s.Language === lang)).find(Boolean) || skus[0];
  if (!sku) throw new Error("Microsoft didn't list any Windows downloads.");

  const links = JSON.parse(await fetchText(`${api}GetProductDownloadLinksBySku?${query}&productEditionId=undefined&SKU=${sku.Id}`, { referrer: page }));
  const options = links.ProductDownloadOptions || [];
  const iso = options.find((o) => /x64/i.test(o.Uri)) || options[0];
  if (!iso) {
    throw new Error(
      "Microsoft's server didn't allow the automatic download this time (it limits how often this works).\n" +
      "Click “Resume setup” to try again later, or download the ISO on Microsoft's site and click “Choose ISO…”.");
  }
  return { url: iso.Uri, file: decodeURIComponent(new URL(iso.Uri).pathname.split("/").pop()) };
};

const ubuntu = (version) => async (arch, fetchText) => {
  const amd = arch === "x86_64";
  const base = amd ? `https://releases.ubuntu.com/${version}/` : `https://cdimage.ubuntu.com/releases/${version}/release/`;
  const a = amd ? "amd64" : "arm64";
  return fromChecksums(fetchText, base, "SHA256SUMS", new RegExp(`^ubuntu-[\\d.]+-desktop-${a}\\.iso$`));
};

const CATALOG = [
  {
    id: "windows11",
    name: "Windows 11",
    family: "windows",
    logo: "windows",
    blurb: "Microsoft's latest Windows, downloaded straight from Microsoft. No product key needed to install.",
    defaults: { cpus: 4, memoryMB: 8192, diskGB: 80 },
    firmware: "uefi",
    // Windows 11 normally refuses to install without TPM 2.0 / Secure Boot; the app answers those checks for you.
    bypassChecks: true,
    source: { type: "auto", resolve: microsoft("windows11"), page: "https://www.microsoft.com/software-download/windows11" },
  },
  {
    id: "windows10",
    name: "Windows 10",
    family: "windows",
    logo: "windows",
    blurb: "The classic, downloaded straight from Microsoft. Runs well on older or slower computers.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 64 },
    firmware: "bios",
    source: { type: "auto", resolve: microsoft("windows10ISO"), page: "https://www.microsoft.com/software-download/windows10ISO" },
  },
  {
    id: "macos",
    name: "macOS",
    family: "macos",
    logo: "apple",
    blurb: "The newest macOS, downloaded straight from Apple. Needs a Mac with Apple Silicon (M1 or newer).",
    defaults: { cpus: 4, memoryMB: 8192, diskGB: 80 },
    source: { type: "ipsw" },
  },
  {
    id: "ubuntu",
    name: "Ubuntu 26.04 LTS",
    family: "linux",
    logo: "ubuntu",
    blurb: "The most popular Linux desktop. Downloaded automatically.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    source: { type: "auto", resolve: ubuntu("26.04") },
  },
  {
    id: "ubuntu2404",
    name: "Ubuntu 24.04 LTS",
    family: "linux",
    logo: "ubuntu",
    blurb: "The previous long-term Ubuntu release. Downloaded automatically.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 30 },
    source: { type: "auto", resolve: ubuntu("24.04") },
  },
  {
    id: "fedora",
    name: "Fedora Workstation",
    family: "linux",
    logo: "fedora",
    blurb: "Cutting-edge Linux with the newest GNOME desktop. Downloaded automatically.",
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
    },
  },
  {
    id: "debian",
    name: "Debian",
    family: "linux",
    logo: "debian",
    blurb: "Rock-solid, lightweight Linux. Downloaded automatically.",
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
