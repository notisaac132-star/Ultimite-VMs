// Downloads install discs with progress, resume (".part" files) and SHA-256 checking.
const { net } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const { once } = require("events");

async function fetchText(url) {
  const res = await net.fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// onProgress({ received, total }) is called a few times per second.
async function download(url, dest, { sha256, onProgress = () => {}, signal } = {}) {
  const part = `${dest}.part`;
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  let res = await net.fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal });
  if (res.status === 416) {
    // The .part file is already complete (or bad); start over.
    fs.rmSync(part, { force: true });
    start = 0;
    res = await net.fetch(url, { signal });
  }
  if (!res.ok) throw new Error(`Download failed: the server answered ${res.status}`);
  if (res.status !== 206) start = 0; // server ignored the resume request

  const total = start + Number(res.headers.get("content-length") || 0);
  const out = fs.createWriteStream(part, { flags: start ? "a" : "w" });
  let received = start;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await once(out, "drain");
      received += chunk.length;
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        onProgress({ received, total });
      }
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  onProgress({ received, total });

  if (sha256) {
    onProgress({ received, total, verifying: true });
    const actual = await sha256File(part);
    if (actual !== sha256.toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new Error("The download was damaged (checksum didn't match). Please try again.");
    }
  }
  fs.renameSync(part, dest);
  return dest;
}

module.exports = { fetchText, download };
