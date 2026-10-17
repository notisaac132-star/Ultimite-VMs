// The operating systems offered in the "New VM" menu, and where each one's install disc comes from.
//
// source.type:
//   "auto"   - the app finds the newest official ISO and downloads it (resolve() returns { url, sha256, file }).
//   "manual" - the vendor doesn't allow direct links (Windows), so the app opens the official download page
//              and the user picks the ISO they downloaded.
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
    blurb: "Microsoft's latest Windows. Bring your own ISO from microsoft.com (free to download).",
    defaults: { cpus: 4, memoryMB: 8192, diskGB: 80 },
    firmware: "uefi",
    // Windows 11 normally refuses to install without TPM 2.0 / Secure Boot; the app answers those checks for you.
    bypassChecks: true,
    source: {
      type: "manual",
      page: "https://www.microsoft.com/software-download/windows11",
      steps: [
        "Scroll to “Download Windows 11 Disk Image (ISO) for x64 devices”.",
        "Pick “Windows 11 (multi-edition ISO for x64 devices)” → Confirm.",
        "Pick your language → Confirm → click “64-bit Download”.",
        "When it finishes, come back here and click “Choose the ISO file”.",
      ],
    },
  },
  {
    id: "windows10",
    name: "Windows 10",
    family: "windows",
    logo: "windows",
    blurb: "The classic. Runs well on older or slower computers.",
    defaults: { cpus: 2, memoryMB: 4096, diskGB: 64 },
    firmware: "bios",
    source: {
      type: "manual",
      page: "https://www.microsoft.com/software-download/windows10ISO",
      steps: [
        "Under “Select edition”, pick Windows 10 → Confirm.",
        "Pick your language → Confirm → click “64-bit Download”.",
        "When it finishes, come back here and click “Choose the ISO file”.",
      ],
    },
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
