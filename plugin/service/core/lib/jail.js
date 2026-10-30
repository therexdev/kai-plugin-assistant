"use strict";

/*
 * One filesystem jail, shared by every surface that resolves a model- or
 * user-supplied path inside a root it must not leave.
 *
 * The obvious check — path.resolve() then startsWith(root) — is LEXICAL, and
 * lexical containment is not containment. It stops "../../etc/passwd", and
 * then happily hands back <project>/notes -> /home/you/.ssh, because the
 * string starts with the project path. fs follows the link; the jail does not.
 *
 * That is reachable, not theoretical: Koinos Code clones repositories from
 * GitHub, and a symlink is an ordinary checked-in file. "Clone this and fix
 * the failing test" would be enough to have the agent read a private key and
 * quote it back.
 *
 * So resolve against the real filesystem: canonicalise the root, canonicalise
 * the target (or, for a file about to be created, its deepest existing
 * ancestor), and compare those. A symlink pointing outside now IS outside.
 *
 * The residual gap is a symlink swapped between this check and the open —
 * a local race requiring code already running as the user, which is a
 * strictly larger capability than any of these tools grant.
 */

const fs = require("fs");
const path = require("path");

/**
 * Canonical path for something that may not exist yet: realpath the deepest
 * existing ancestor and re-attach the missing tail. Without this a write to a
 * brand-new file could not be checked at all.
 */
function realpathOfDeepestExisting(target) {
  const missing = [];
  let cur = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...missing.slice().reverse());
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e; // walked to the filesystem root; nothing exists
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `p` inside `root`, following symlinks, or null when it escapes.
 * Returns the CANONICAL path — callers should use it, so the bytes they open
 * are the ones that were checked.
 */
function confine(root, p) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(String(root || "")));
  } catch {
    return null; // no root to be inside of — deny rather than guess
  }
  let real;
  try {
    real = realpathOfDeepestExisting(path.resolve(realRoot, String(p || "")));
  } catch {
    return null; // unreadable or unresolvable — deny
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

module.exports = { confine, realpathOfDeepestExisting };
