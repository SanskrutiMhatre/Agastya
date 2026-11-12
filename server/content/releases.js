'use strict';
/*
  The release state of a publication (Phase 10, decisions.md RL1-RL6), the
  JSS PDF Publisher's rule (server.js releaseStateOf) on Agastya's approval
  workflow:

    released  the newest approved request's fingerprint equals the
              publication's live fingerprint: what was approved is what is
              there now. Release N is the Nth approval of the project.
    stale     approved once, but the content (or its build settings, which
              the fingerprint covers through project.json) moved on since.

  It is decided here only, and every build (full, module preview, snapshot)
  asks it, so the watermark, the running head and the download check can
  never disagree (RL2, RL4).
*/

const requests = require('./requests');

function stateOf(store, project, dir) {
  const fingerprint = requests.liveFingerprint(dir, store.listDataModules(project.id));
  const approved = store.listApprovedRequests(project.id);
  const last = approved[approved.length - 1] || null;
  const released = !!last && !!fingerprint && last.fingerprint === fingerprint;
  return {
    fingerprint,
    released,
    releaseNumber: last ? approved.length : null,
    approvedAt: last ? last.decided_at : null,
    requestId: last ? last.id : null,
    stale: !!last && !released,
  };
}

module.exports = { stateOf };
