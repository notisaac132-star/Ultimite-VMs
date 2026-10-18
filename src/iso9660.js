// Minimal ISO 9660 reader (with Rock Ridge names): finds files on an install disc and copies them out.
// Used to boot a Linux installer's kernel directly so it can be given an automatic-install answer file.
const fs = require("fs");

const SECTOR = 2048;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, position);
  return buf;
}

// Rock Ridge keeps the real (lowercase, long) name in an "NM" entry of the record's system use area.
function rockRidgeName(buf, start, end) {
  let name = "";
  for (let i = start; i + 4 <= end;) {
    const sig = buf.toString("latin1", i, i + 2);
    const len = buf[i + 2];
    if (len < 4) break;
    if (sig === "NM") name += buf.toString("utf8", i + 5, i + len);
    i += len;
  }
  return name || null;
}

function readDir(fd, lba, size) {
  const buf = readAt(fd, lba * SECTOR, size);
  const entries = [];
  for (let off = 0; off < size;) {
    const len = buf[off];
    if (!len) {
      off = (Math.floor(off / SECTOR) + 1) * SECTOR; // records never cross sectors
      continue;
    }
    const nameLen = buf[off + 32];
    const raw = buf.toString("latin1", off + 33, off + 33 + nameLen);
    if (!(nameLen === 1 && (raw === "\0" || raw === "\x01"))) {
      const suStart = off + 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
      const name = rockRidgeName(buf, suStart, off + len) || raw.replace(/;\d+$/, "").replace(/\.$/, "");
      entries.push({ name, lba: buf.readUInt32LE(off + 2), size: buf.readUInt32LE(off + 10), dir: !!(buf[off + 25] & 2) });
    }
    off += len;
  }
  return entries;
}

function open(file) {
  const fd = fs.openSync(file, "r");
  const pvd = readAt(fd, 16 * SECTOR, SECTOR);
  if (pvd[0] !== 1 || pvd.toString("latin1", 1, 6) !== "CD001") {
    fs.closeSync(fd);
    throw new Error("This isn't an ISO disc image.");
  }
  const root = { lba: pvd.readUInt32LE(156 + 2), size: pvd.readUInt32LE(156 + 10), dir: true };

  // Path lookup is case-insensitive ("casper/vmlinuz" matches "CASPER/VMLINUZ").
  function find(p) {
    let node = root;
    for (const part of p.split("/").filter(Boolean)) {
      if (!node.dir) return null;
      node = readDir(fd, node.lba, node.size).find((e) => e.name.toLowerCase() === part.toLowerCase());
      if (!node) return null;
    }
    return node;
  }

  return {
    volumeId: pvd.toString("latin1", 40, 72).trim(),
    find,
    list: (p) => {
      const node = find(p);
      return node && node.dir ? readDir(fd, node.lba, node.size).map((e) => e.name) : [];
    },
    extract(p, dest) {
      const node = find(p);
      if (!node || node.dir) throw new Error(`${p} isn't on the disc.`);
      const out = fs.openSync(dest, "w");
      const chunk = 8 * 1024 * 1024;
      for (let done = 0; done < node.size; done += chunk) {
        const n = Math.min(chunk, node.size - done);
        fs.writeSync(out, readAt(fd, node.lba * SECTOR + done, n));
      }
      fs.closeSync(out);
      return dest;
    },
    close: () => fs.closeSync(fd),
  };
}

module.exports = { open };
