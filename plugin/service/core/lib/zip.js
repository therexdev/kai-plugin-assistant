"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { confine } = require("./jail");

/*
 * Minimal zip extraction — enough for engine release archives (store +
 * deflate entries, < 4 GB each), keeping Core dependency-free. Preserves
 * unix mode bits (llama-server must stay executable) and refuses traversal.
 * No zip64, no encryption — both fail loudly, never silently.
 *
 * Reads by file descriptor in ranges — never the whole archive into
 * memory (field finding: a 1.4 GB engine zip read with readFileSync froze
 * the app for minutes and spiked memory by gigabytes). extractZipAsync
 * additionally runs the work in a worker thread: Core lives inside the
 * Electron main process, and anything synchronous there is a frozen
 * window.
 */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readAt(fd, position, length) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > fs.fstatSync(fd).size) throw new Error("Corrupt zip: invalid entry bounds");
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) throw new Error("Corrupt zip: unexpected end of file");
    done += n;
  }
  return buf;
}

function extractZip(zipPath, destDir) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const size = fs.fstatSync(fd).size;

    // End of central directory: scan backwards (comment can pad the tail).
    const tailLen = Math.min(size, 22 + 65536);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`Not a zip file: ${zipPath}`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdirSize = tail.readUInt32LE(eocd + 12);
    const cdirOff = tail.readUInt32LE(eocd + 16);
    if (cdirOff === 0xffffffff || count === 0xffff) throw new Error("zip64 archives are not supported");
    if (cdirSize > 32 * 1024 * 1024) throw new Error("Zip central directory exceeds the 32 MB limit");

    const cdir = readAt(fd, cdirOff, cdirSize);
    const root = path.resolve(destDir);
    fs.mkdirSync(root, { recursive: true });
    const files = [];
    let off = 0;

    for (let n = 0; n < count; n++) {
      if (off + 46 > cdir.length) throw new Error("Corrupt zip: truncated central directory");
      if (cdir.readUInt32LE(off) !== CDIR_SIG) throw new Error("Corrupt zip: bad central directory");
      const flags = cdir.readUInt16LE(off + 8);
      const method = cdir.readUInt16LE(off + 10);
      const compSize = cdir.readUInt32LE(off + 20);
      const uncompressedSize = cdir.readUInt32LE(off + 24);
      const nameLen = cdir.readUInt16LE(off + 28);
      const extraLen = cdir.readUInt16LE(off + 30);
      const commentLen = cdir.readUInt16LE(off + 32);
      const externalAttrs = cdir.readUInt32LE(off + 38);
      const localOff = cdir.readUInt32LE(off + 42);
      if (off + 46 + nameLen + extraLen + commentLen > cdir.length) throw new Error("Corrupt zip: truncated entry name");
      const name = cdir.toString("utf8", off + 46, off + 46 + nameLen);
      off += 46 + nameLen + extraLen + commentLen;

      if (flags & 0x0001) throw new Error(`Encrypted zip entries are not supported (${name})`);
      if (!name || /[\\\x00]/.test(name) || /^[A-Za-z]:/.test(name) || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Refusing zip entry escaping the target directory or using an unsafe name: ${name}`);
      if (((externalAttrs >>> 16) & 0o170000) === 0o120000) throw new Error(`Refusing symbolic link zip entry: ${name}`);
      if (compSize > 2 * 1024 ** 3 - 1 || uncompressedSize > 2 * 1024 ** 3 - 1) throw new Error("Zip entry exceeds the 2 GB limit");

      // Zip-slip guard: entry must resolve inside destDir.
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Refusing zip entry escaping the target directory: ${name}`);
      }
      if (!confine(root, target)) throw new Error(`Refusing zip entry escaping through a symbolic link: ${name}`);
      if (name.endsWith("/")) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }

      // Local header repeats name/extra with possibly different lengths.
      const local = readAt(fd, localOff, 30);
      if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error("Corrupt zip: bad local header");
      const lNameLen = local.readUInt16LE(26);
      const lExtraLen = local.readUInt16LE(28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = compSize ? readAt(fd, dataStart, compSize) : Buffer.alloc(0);

      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize) });
      else throw new Error(`Unsupported zip compression method ${method} (${name})`);
      if (data.length !== uncompressedSize) throw new Error(`Corrupt zip: size mismatch (${name})`);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      // Unix mode lives in the high 16 bits of external attributes.
      const mode = (externalAttrs >>> 16) & 0o777;
      if (mode && process.platform !== "win32") fs.chmodSync(target, mode);
      files.push(name);
    }
    return files;
  } finally {
    fs.closeSync(fd);
  }
}

/** extractZip in a worker thread — the main process stays responsive. */
function extractZipAsync(zipPath, destDir) {
  const { Worker } = require("worker_threads");
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { zipPath, destDir } });
    w.once("message", (m) => (m.ok ? resolve(m.files) : reject(new Error(m.error))));
    w.once("error", reject);
    w.once("exit", (code) => {
      if (code !== 0) reject(new Error(`zip worker exited with code ${code}`));
    });
  });
}

// Worker entry: when loaded by extractZipAsync, do the job and report back.
if (require("worker_threads").isMainThread === false) {
  const { workerData, parentPort } = require("worker_threads");
  if (workerData && workerData.zipPath) {
    try {
      const files = extractZip(workerData.zipPath, workerData.destDir);
      parentPort.postMessage({ ok: true, files });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: String(e.message) });
    }
  }
}

module.exports = { extractZip, extractZipAsync };
