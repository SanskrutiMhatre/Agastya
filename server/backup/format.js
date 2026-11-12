'use strict';
/*
  The backup format (decisions.md K1-K4), and everything about it that does
  not touch the running application: identifiers, the paths a backup may
  hold, what a workspace walk leaves out, the manifest and its seal, and the
  optional encryption of stored files.

  A backup is one directory, <backupDir>/<id>/:

    manifest.json        what the backup holds (format, id, time, kind, who,
                         schema migrations, counts, and every file with its
                         size and SHA-256)
    manifest.seal        "sha256:<hex>" of manifest.json, or "hmac-sha256:<hex>"
                         keyed with the backup key when the backup is encrypted
    db/agastya.db        the database, a consistent copy (VACUUM INTO)
    projects/<id>/...    the project workspaces, without build outputs
    snapshots/<id>/...   the frozen submissions

  Nothing in a backup is trusted: a path must match PATH_RE and stay inside
  the backup directory, a file must be a regular file of the listed size and
  hash, and nothing unlisted may be present.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const FORMAT = 'agastya-backup';
const FORMAT_VERSION = 1;
const ID_RE = /^bk-\d{8}-\d{6}-[0-9a-f]{6}$/;
const KINDS = ['manual', 'scheduled', 'pre-restore'];
const MANIFEST = 'manifest.json';
const SEAL = 'manifest.seal';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/*
  Paths inside a backup: the database file, or a workspace or snapshot file
  under its own id. Every segment is a plain name (letters, digits, dot,
  underscore, hyphen, space), never '.' or '..'.
*/
const SEGMENT = "[A-Za-z0-9._ -]+";
const PATH_RE = new RegExp(`^(db/agastya\\.db|projects/prj-[0-9a-f]{10}(/${SEGMENT})+|snapshots/[0-9a-f-]{36}(/${SEGMENT})+)$`);
function safeBackupPath(rel) {
  if (typeof rel !== 'string' || rel.length > 500 || !PATH_RE.test(rel)) return false;
  return rel.split('/').every((s) => s !== '.' && s !== '..' && s.trim() === s && s.length <= 200);
}

// Resolve a validated backup path inside a root, or null if it would escape.
function resolveInside(root, rel) {
  if (!safeBackupPath(rel)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...rel.split('/'));
  return abs.startsWith(base + path.sep) ? abs : null;
}

/*
  What a workspace walk leaves out (decisions.md K2): build outputs the next
  build makes again (output.pdf/.fo, jss-book.xml, the _-prefixed preview and
  intermediate files, the generated *-run.xsl drivers), the per-module
  preview cache, and the write path's temporary files. Everything else in a
  workspace is source.
*/
const EXCLUDED_TOP = /^(output\.(pdf|fo)|jss-book\.xml|_.*|[A-Za-z0-9]+-run\.xsl|\.previews)$/;
const isTempFile = (name) => /\.tmp$/.test(name);

function newBackupId(now) {
  const d = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261028-143005
  return `bk-${d}-${crypto.randomBytes(3).toString('hex')}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- the backup key ----------------------------------------------------------

/*
  AGASTYA_BACKUP_KEY: 32 bytes as 64 hex characters, or base64. Never written
  into a backup or a log. A backup records only a key id derived from it, so
  a restore can tell a wrong key from a damaged file.
*/
function parseKey(value) {
  if (value === undefined || value === null || value === '') return { key: null };
  const v = String(value).trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex');
  else {
    try { const b = Buffer.from(v, 'base64'); if (b.length === 32 && b.toString('base64').replace(/=+$/, '') === v.replace(/=+$/, '')) key = b; } catch { key = null; }
  }
  if (!key) return { key: null, error: 'AGASTYA_BACKUP_KEY must be 32 bytes, as 64 hexadecimal characters or base64.' };
  return { key, keyId: crypto.createHmac('sha256', key).update('agastya-backup-key-id').digest('hex').slice(0, 16) };
}

// ---- stored files: plain or AES-256-GCM ---------------------------------------

const MAGIC = Buffer.from('AGBK1\n');
const IV_LEN = 12;
const TAG_LEN = 16;

// A pass-through that hashes what flows through it.
function hasher() {
  const h = crypto.createHash('sha256');
  let size = 0;
  const t = new Transform({ transform(chunk, _enc, cb) { h.update(chunk); size += chunk.length; cb(null, chunk); } });
  t.result = () => ({ sha256: h.digest('hex'), size });
  return t;
}

/*
  Copy `src` to `dest` (which must not exist), encrypting when a key is given.
  Returns { size, sha256 } of the stored bytes and { plainSize, plainSha256 }
  of the source. Stored file: MAGIC | IV | ciphertext | tag.
*/
async function storeFile(src, dest, key, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const plain = hasher();
  const stored = hasher();
  if (!key) {
    await pipeline(fs.createReadStream(src), plain, stored, fs.createWriteStream(dest, { flags: 'wx', mode }));
  } else {
    const prefix = Buffer.concat([MAGIC, crypto.randomBytes(IV_LEN)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, prefix.subarray(MAGIC.length));
    // The header first, then the ciphertext and the GCM tag appended after it.
    fs.writeFileSync(dest, prefix, { flag: 'wx', mode });
    const withTag = new Transform({
      transform(chunk, _e, cb) { cb(null, chunk); },
      flush(cb) { this.push(cipher.getAuthTag()); cb(); },
    });
    await pipeline(fs.createReadStream(src), plain, cipher, withTag, fs.createWriteStream(dest, { flags: 'a', mode }));
    // The stored hash covers the whole file, header and tag included.
    const all = await hashFile(dest);
    const p = plain.result();
    return { size: all.size, sha256: all.sha256, plainSize: p.size, plainSha256: p.sha256 };
  }
  const p = plain.result();
  const s = stored.result();
  return { size: s.size, sha256: s.sha256, plainSize: p.size, plainSha256: p.sha256 };
}

// Hash a stored file as it is on disk.
async function hashFile(file) {
  const h = hasher();
  await pipeline(fs.createReadStream(file), h, new (require('node:stream').Writable)({ write(_c, _e, cb) { cb(); } }));
  return h.result();
}

/*
  Write the original bytes of a stored file to `dest` (which must not exist),
  decrypting when the backup is encrypted. Returns { size, sha256 } of what
  was written. A wrong key or a changed byte fails the GCM tag and throws.
*/
async function extractFile(src, dest, key, { mode = 0o644 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const h = hasher();
  const out = fs.createWriteStream(dest, { flags: 'wx', mode });
  if (!key) {
    await pipeline(fs.createReadStream(src), h, out);
    return h.result();
  }
  const fd = fs.openSync(src, 'r');
  let total;
  const head = Buffer.alloc(MAGIC.length + IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    total = fs.fstatSync(fd).size;
    if (total < head.length + TAG_LEN) throw Object.assign(new Error('stored file too short'), { code: 'CORRUPT' });
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, total - TAG_LEN);
  } finally { fs.closeSync(fd); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw Object.assign(new Error('not an encrypted backup file'), { code: 'CORRUPT' });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: head.length, end: total - TAG_LEN - 1 }), decipher, h, out);
  } catch (e) {
    throw Object.assign(new Error('the file failed decryption (wrong key or damaged)'), { code: 'DECRYPT_FAILED', cause: e });
  }
  return h.result();
}

// ---- the manifest and its seal -------------------------------------------------

function sealOf(bytes, key) {
  return key
    ? `hmac-sha256:${crypto.createHmac('sha256', key).update(bytes).digest('hex')}`
    : `sha256:${sha256(bytes)}`;
}

const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isCount = (n) => Number.isInteger(n) && n >= 0;

/*
  Check a parsed manifest's shape. Returns a list of problems (empty when it
  is well formed). Unknown top-level fields are refused, so a manifest from a
  different tool cannot slip extra instructions in.
*/
function checkManifest(m, dirName) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the manifest is not an object'];
  const allowed = new Set(['format', 'formatVersion', 'id', 'createdAt', 'kind', 'note', 'createdBy', 'app', 'schema', 'encryption', 'stats', 'components', 'files']);
  for (const k of Object.keys(m)) if (!allowed.has(k)) bad(`unknown manifest field ${k.slice(0, 40)}`);
  if (m.format !== FORMAT) bad('not an Agastya backup');
  if (m.formatVersion !== FORMAT_VERSION) bad(`backup format version ${m.formatVersion} is not supported (this version reads ${FORMAT_VERSION})`);
  if (!ID_RE.test(String(m.id)) || m.id !== dirName) bad('the backup id does not match its folder');
  if (!isIso(m.createdAt)) bad('the creation time is invalid');
  if (!KINDS.includes(m.kind)) bad('the backup kind is invalid');
  if (m.note !== undefined && (typeof m.note !== 'string' || m.note.length > 1000)) bad('the note is invalid');
  if (!m.schema || !Array.isArray(m.schema.migrations) || !m.schema.migrations.every((x) => typeof x === 'string' && /^\d{3}-[a-z0-9-]+$/.test(x))) bad('the schema list is invalid');
  if (m.encryption !== null && !(m.encryption && m.encryption.algorithm === 'aes-256-gcm' && /^[0-9a-f]{16}$/.test(String(m.encryption.keyId)))) bad('the encryption block is invalid');
  if (!m.stats || typeof m.stats !== 'object' || !Object.values(m.stats).every(isCount)) bad('the counts are invalid');
  if (!Array.isArray(m.files) || !m.files.length) bad('the file list is missing');
  else {
    const seen = new Set();
    let db = 0;
    for (const f of m.files) {
      if (!f || typeof f !== 'object' || !safeBackupPath(f.path)) { bad(`unsafe or invalid path ${String(f && f.path).slice(0, 80)}`); continue; }
      if (seen.has(f.path)) bad(`duplicate path ${f.path}`);
      seen.add(f.path);
      if (f.path === 'db/agastya.db') db++;
      if (!isCount(f.size) || !isHex64(f.sha256) || !isCount(f.plainSize) || !isHex64(f.plainSha256)) bad(`invalid size or hash for ${f.path}`);
    }
    if (db !== 1) bad('the database is missing from the file list');
  }
  return problems;
}

module.exports = {
  FORMAT, FORMAT_VERSION, ID_RE, KINDS, MANIFEST, SEAL, MAX_MANIFEST_BYTES,
  safeBackupPath, resolveInside, EXCLUDED_TOP, isTempFile, newBackupId, sha256,
  parseKey, storeFile, hashFile, extractFile, sealOf, checkManifest,
};
