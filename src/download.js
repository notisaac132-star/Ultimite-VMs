// Downloads install discs with progress, resume (".part" files) and SHA-256 checking.
const { net } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const { once } = require("events");

// Looks like a normal Firefox: Microsoft's download protection turns away anything that doesn't.
const BROWSER_HEADERS = {
  // Not a Windows browser: Microsoft's Windows 10 page only offers an ISO to those.
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// referrer: sent as Referer (and its site as Origin). Cookies are kept between calls, like in a browser tab.
async function fetchText(url, { referrer, headers } = {}) {
  const res = await net.fetch(url, {
    cache: "no-store",
    credentials: "include",
    headers: { ...BROWSER_HEADERS, ...(referrer && { Referer: referrer, Origin: new URL(referrer).origin }), ...headers },
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

// Follows redirects (e.g. Microsoft's go.microsoft.com links) and reports where they end up.
async function resolveRedirect(url) {
  const res = await net.fetch(url, { method: "HEAD", headers: BROWSER_HEADERS, credentials: "include" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { url: res.url, size: Number(res.headers.get("content-length") || 0) };
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

// Extracts the biggest file in a .zip (e.g. ChromeOS Flex's disk image) to `dest`.
function unzipLargest(zipFile, dest, onProgress = () => {}) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      let best = null;
      zip.on("entry", (entry) => {
        if (!best || entry.uncompressedSize > best.uncompressedSize) best = entry;
        zip.readEntry();
      });
      zip.on("error", reject);
      zip.on("end", () => {
        if (!best) return reject(new Error("The download was empty."));
        zip.openReadStream(best, (err2, stream) => {
          if (err2) return reject(err2);
          const part = `${dest}.part`;
          const out = fs.createWriteStream(part);
          let done = 0;
          stream.on("data", (d) => {
            done += d.length;
            onProgress(done / best.uncompressedSize);
          });
          stream.on("error", reject);
          out.on("error", reject);
          out.on("close", () => {
            zip.close();
            fs.renameSync(part, dest);
            resolve(dest);
          });
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { fetchText, resolveRedirect, download, unzipLargest };
