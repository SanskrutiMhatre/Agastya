// Client navigation is role-aware: each role sees only what it may use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { navFor, pathsFor } from '../client/src/nav.js';

test('Authors see no user management, approvals or audit', () => {
  const p = pathsFor('author');
  assert.ok(!p.includes('/users'));
  assert.ok(!p.includes('/approvals'));
  assert.ok(!p.includes('/audit'));
  // The Author Panel redesign: a project is opened directly into its editor
  // rather than reached through separate "Data modules" / "Publications"
  // pickers, which workspaces/projects and the graphics library supersede.
  assert.ok(p.includes('/workspaces') && p.includes('/projects') && p.includes('/graphics') && p.includes('/backup'));
  assert.ok(!p.includes('/data-modules') && !p.includes('/publications'));
});

test('Project Managers see their Authors and approvals, but not the audit log', () => {
  const p = pathsFor('project_manager');
  assert.ok(p.includes('/users') && p.includes('/approvals'));
  assert.ok(!p.includes('/audit'));
  const labels = navFor('project_manager').flatMap((s) => s.items.map((i) => i.label));
  assert.ok(labels.includes('Authors') && !labels.includes('Users'));
});

test('the Software Administrator sees administration', () => {
  const p = pathsFor('software_admin');
  for (const x of ['/', '/users', '/projects', '/approvals', '/audit', '/health', '/backups']) assert.ok(p.includes(x), x);
  assert.ok(!p.includes('/data-modules'), 'no authoring entry in the admin navigation');
});

test('the administrator screens are in nobody else\'s navigation', () => {
  for (const role of ['project_manager', 'author']) {
    const p = pathsFor(role);
    assert.ok(!p.includes('/audit') && !p.includes('/health') && !p.includes('/backups'), role);
  }
});

test('no item is labelled as a later phase any more', () => {
  const all = ['software_admin', 'project_manager', 'author'].flatMap((r) => navFor(r).flatMap((s) => s.items));
  const phased = Object.fromEntries(all.filter((i) => i.phase).map((i) => [i.to, i.phase]));
  assert.deepEqual(phased, {}, 'the audit log arrived in Phase 4');
  assert.equal(all.find((i) => i.to === '/approvals').badge, 'approvals');
});

test('an unknown role gets no navigation', () => {
  assert.deepEqual(navFor('superuser'), []);
});
