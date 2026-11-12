'use strict';
/*
  The content lock (PROMPT.md "Approval workflow"; decisions.md L1-L4).

  While a publication request is pending, the publication module and the
  data modules it was submitted with are read-only for every Author on the
  project, and so are the other sources frozen with them (their graphics and
  BREX, and project.json): otherwise replacing one would make the request
  stale and so lift the lock. The locked set of a project is the union of
  the files frozen in its pending requests (each snapshot's manifest), so a
  data module placed in two publications is locked by a pending request on
  either. A request that
  is withdrawn, rejected, sent back with "changes requested", approved or
  made stale is no longer pending, and its files unlock at once: nothing is
  stored about the lock itself.

  The Software Administrator is exempt: an administrator edit goes through
  the override path (decisions.md V3, V5) and marks the request stale
  instead. Because that ends someone else's request, a save of a frozen file
  by the administrator is refused (409 OVERRIDE_MAKES_STALE, naming the
  request) until they acknowledge it.
*/

const fs = require('node:fs');
const { snapshotFile, PUBLICATION_REF } = require('./requests');

class LockedError extends Error {
  constructor(lock, { override = false } = {}) {
    super(`Locked: pending approval. This is part of a publication submitted by ${lock.submittedBy} to ${lock.manager} on ${lock.submittedAt.slice(0, 10)}. It can be edited again once the request is withdrawn, rejected or sent back with changes requested.`);
    this.status = 423;
    this.code = 'LOCKED_PENDING_APPROVAL';
    this.lock = lock;
    if (override) {
      this.message = `This is part of the publication ${lock.submittedBy} submitted to ${lock.manager} on ${lock.submittedAt.slice(0, 10)}. Saving it as an override makes that request out of date: the lock lifts, the Author and the manager are told, and the Author submits again. To decide the request on what was submitted instead, open it under Approvals.`;
      this.status = 409;
      this.code = 'OVERRIDE_MAKES_STALE';
    }
  }
}

function createLocks({ store, dataDir }) {
  // requestId -> Set of locked workspace paths (a manifest never changes once written).
  const manifests = new Map();

  function filesOf(request) {
    if (manifests.has(request.id)) return manifests.get(request.id);
    let rels = new Set([PUBLICATION_REF]);
    try {
      const m = JSON.parse(fs.readFileSync(snapshotFile(dataDir, request, 'manifest.json'), 'utf8'));
      // Every frozen source: the PM, its data modules, their graphics and BREX, project.json.
      rels = new Set([PUBLICATION_REF, ...m.files.map((f) => f.rel)]);
    } catch { /* an unreadable manifest still locks the publication module */ }
    if (manifests.size > 500) manifests.clear();
    manifests.set(request.id, rels);
    return rels;
  }

  const lockOut = (r) => ({
    requestId: r.id, submittedBy: r.submitted_by_name || 'an Author', manager: r.manager_name || 'a Project Manager',
    submittedAt: r.submitted_at, title: r.publication_title || '',
  });

  // rel -> lock description, for every locked file of the project.
  function lockedFiles(projectId) {
    const out = new Map();
    for (const r of store.listPendingRequestsForProject(projectId)) {
      const full = store.getRequest(r.id);
      for (const rel of filesOf(r)) if (!out.has(rel)) out.set(rel, lockOut(full));
    }
    return out;
  }

  const lockOf = (projectId, rel) => lockedFiles(projectId).get(rel) || null;

  /*
    Throws LockedError when `user` may not write `rel` because of a pending
    request. The administrator (writing under an override session) is
    exempt, once they have accepted that the save makes the request stale.
  */
  function assertUnlocked(user, projectId, rel, { acceptStale = false } = {}) {
    const lock = lockOf(projectId, rel);
    if (!lock) return;
    if (user && user.role === 'software_admin') {
      if (acceptStale) return;
      throw new LockedError(lock, { override: true });
    }
    throw new LockedError(lock);
  }

  // After a restore the requests may differ: forget what was read (decisions.md K5).
  const reset = () => manifests.clear();

  return { lockedFiles, lockOf, assertUnlocked, reset };
}

module.exports = { createLocks, LockedError };
