'use strict';
/*
  Undo a restore that was interrupted during the swap (decisions.md K5).

  The restore writes a journal (<dataDir>/.restore-journal.json) before it
  moves anything. While the journal says "swapping", the original data is in
  the holding folder, wholly or item by item, and the data folder may hold a
  part of the restored data. Recovery puts the originals back: for every item
  found in the holding folder, whatever stands in its place is removed and
  the original moved back. An item not in the holding folder was never moved
  and is left alone. "done" means the restore finished and only the clean-up
  was cut short.

  Runs when the server (or the backup command) starts, before the database is
  opened. Returns a short description of what it did, or null.
*/

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL = '.restore-journal.json';

/*
  Rename, retrying for a moment when the file is briefly held (decisions.md
  K13): on Windows an antivirus scanner or the search indexer often opens a
  file just written, and a rename then fails with EBUSY, EPERM or EACCES for a
  fraction of a second. Other errors, and a hold that lasts, still throw.
*/
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
function renameRetry(from, to, { attempts = 15, waitMs = 200, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!BUSY.has(e.code) || i >= attempts) throw e;
      sleep(waitMs);
    }
  }
}
// Everything a restore replaces, at the top of the data folder.
const ITEMS = ['agastya.db', 'agastya.db-wal', 'agastya.db-shm', 'projects', 'snapshots'];

function rm(target) {
  if (!fs.existsSync(target)) return;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {
    (function unlock(p) {
      let st;
      try { st = fs.lstatSync(p); } catch { return; }
      try { fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600); } catch { /* best effort */ }
      if (st.isDirectory()) for (const e of fs.readdirSync(p)) unlock(path.join(p, e));
    })(target);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function recoverInterruptedRestore(dataDir, log = console) {
  const journal = path.join(dataDir, JOURNAL);
  if (!fs.existsSync(journal)) return null;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch { j = null; }
  const holdingName = j && typeof j.holding === 'string' && /^\.pre-restore-bk-\d{8}-\d{6}-[0-9a-f]{6}$/.test(j.holding) ? j.holding : null;
  const holding = holdingName ? path.join(dataDir, holdingName) : null;
  let outcome;
  if (j && j.phase === 'swapping' && holding && fs.existsSync(holding)) {
    for (const name of ITEMS) {
      const original = path.join(holding, name);
      if (!fs.existsSync(original)) continue;
      rm(path.join(dataDir, name));
      renameRetry(original, path.join(dataDir, name));
    }
    rm(holding);
    outcome = `an interrupted restore of ${j.backupId} was undone; the data is as it was before it started`;
  } else if (j && j.phase === 'done') {
    if (holding) rm(holding);
    outcome = `the clean-up of a completed restore of ${j.backupId} was finished`;
  } else {
    outcome = 'an unreadable restore journal was found; the data folder was left as it is';
  }
  if (j && typeof j.staging === 'string' && /^\.restore-staging-bk-\d{8}-\d{6}-[0-9a-f]{6}$/.test(j.staging)) rm(path.join(dataDir, j.staging));
  fs.unlinkSync(journal);
  if (log && log.log) log.log(`[backup] ${outcome}`);
  return outcome;
}

module.exports = { recoverInterruptedRestore, renameRetry, JOURNAL, ITEMS };
