'use strict';
// "Delete project" (decisions.md UI7): archiving, not erasing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, adminClient, makeUser } = require('./helpers');

let t, admin, owner, other;
test.before(async () => {
  t = await startServer();
  admin = await adminClient(t);
  owner = await makeUser(t, admin, { username: 'owner.one', role: 'project_manager' });
  other = await makeUser(t, admin, { username: 'owner.two', role: 'project_manager' });
});
test.after(() => t.stop());

test('archiving a project frees its name for a new one; restoring brings it back exactly as it was', async () => {
  const r = await owner.post('/api/projects', { name: 'Demo' });
  assert.equal(r.status, 201);
  const id = r.body.project.id;

  // While active, the name is still taken (unchanged behaviour).
  assert.equal((await other.post('/api/projects', { name: 'Demo' })).body.code, 'NAME_TAKEN');
  // Nobody but its owner or the administrator may archive it (not a member, so not even found).
  assert.equal((await other.post(`/api/projects/${id}/archive`, {})).status, 404);

  assert.equal((await owner.post(`/api/projects/${id}/archive`, {})).status, 200);
  assert.equal((await owner.post(`/api/projects/${id}/archive`, {})).body.code, 'ALREADY_ARCHIVED');

  // Archived: hidden from the default list, but a new project may now use its name.
  assert.deepEqual((await owner.get('/api/projects')).body.projects.map((p) => p.name), []);
  const again = await other.post('/api/projects', { name: 'Demo' });
  assert.equal(again.status, 201, 'the archived project no longer blocks its own name');

  // Restoring the original while another active project now holds its name is a clean conflict, not a crash.
  assert.equal((await owner.post(`/api/projects/${id}/restore`, {})).body.code, 'NAME_TAKEN');

  // With that one out of the way, restoring brings the original back, unchanged.
  assert.equal((await other.post(`/api/projects/${again.body.project.id}/archive`, {})).status, 200);
  assert.equal((await owner.post(`/api/projects/${id}/restore`, {})).status, 200);
  assert.equal((await owner.post(`/api/projects/${id}/restore`, {})).body.code, 'NOT_ARCHIVED');
  const restored = (await owner.get(`/api/projects/${id}`)).body.project;
  assert.equal(restored.name, 'Demo');
  assert.equal(restored.status, 'active');
});
