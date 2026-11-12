'use strict';
/*
  One place that runs a build for a request: progress goes to the event hub
  (and from there to the project's WebSocket subscribers), the outcome is
  recorded in `builds` for the dashboards, and errors are re-thrown for the
  route to answer. Used by the full build, the module preview and the
  snapshot taken at submission.
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pdf = require('./pdf');
const releases = require('../content/releases');

const sha256File = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
// What a build was made from (decisions.md RL5): settings are project.json, byte for byte.
const settingsHash = (dir) => sha256File(path.join(dir, 'project.json'));

/*
  Builds in progress, process-wide (every runner shares it), for the
  administrator's build queue (decisions.md V11). A build for a project
  whose earlier build is still running waits behind it inside pdf.js, so
  more than one entry for a project means the later ones are queued.
*/
const active = new Map();
let seq = 0;
function activeBuilds() {
  const list = [...active.values()].sort((a, b) => a.seq - b.seq);
  const seen = new Set();
  return list.map((b) => {
    const queued = seen.has(b.projectId);
    seen.add(b.projectId);
    return { projectId: b.projectId, projectName: b.projectName, kind: b.kind, target: b.target, by: b.by, startedAt: b.startedAt, state: queued ? 'waiting' : 'running' };
  });
}

function createBuildRunner({ store, events, log = console, now = () => new Date() }) {
  const at = () => now().toISOString();

  async function run({ project, dir, kind, user, target = null, dmRel = null }) {
    const base = { projectId: project.id, kind, target, by: user.fullName || user.username };
    const emit = (phase, message = '') => events.emit('build', { ...base, phase, message, at: at() });
    const id = ++seq;
    active.set(id, { seq: id, projectId: project.id, projectName: project.name, kind, target, by: base.by, startedAt: at() });
    emit('start', kind === 'preview' ? `Preview of ${target || 'a data module'} started` : 'Publication build started');
    const onMessage = (line) => emit('progress', line);
    const started = Date.now();
    // The release state decides the marking, once, before the build (decisions.md RL2).
    const release = releases.stateOf(store, project, dir);
    const settings = settingsHash(dir);
    try {
      const r = kind === 'preview'
        ? await pdf.buildPreview(dir, dmRel, { log, onMessage, release })
        : await pdf.buildPublication(dir, { log, onMessage, release });
      const provenance = {
        fingerprint: release.fingerprint, settingsHash: settings, released: release.released,
        releaseNumber: release.released ? release.releaseNumber : null,
        marking: r.marking && r.marking.watermark ? r.marking.watermark.text : null, pdfSha256: sha256File(r.pdf),
      };
      const buildId = store.recordBuild({ projectId: project.id, kind, target, userId: user.id, ok: true, ms: r.totalMs, now: at(), ...provenance });
      emit('done', `Finished in ${(r.totalMs / 1000).toFixed(1)} s${provenance.marking ? ` · marked ${provenance.marking}` : release.released ? ` · Release ${release.releaseNumber}` : ''}`);
      return { ...r, provenance: { ...provenance, buildId } };
    } catch (e) {
      store.recordBuild({ projectId: project.id, kind, target, userId: user.id, ok: false, ms: Date.now() - started, errorCode: e.code || 'BUILD_FAILED', now: at() });
      emit('error', e instanceof pdf.BuildError ? e.message : 'The build failed.');
      throw e;
    } finally {
      active.delete(id);
    }
  }

  return { run };
}

module.exports = { createBuildRunner, activeBuilds };
