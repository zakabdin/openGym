import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trainerCodeFromStart, findTrainerByCode, clientsOf, isClientOf, cleanBundle,
  newAssignment, addAssignment, resolveAssignment, MAX_ASSIGNMENTS
} from '../trainer.js';

test('deep-link parameter', () => {
  assert.equal(trainerCodeFromStart('t_abcdef23'), 'abcdef23');
  for (const bad of ['', 'abcdef', 't_', 't_ab', 'T_abcdef', 't_abc def', null]) assert.equal(trainerCodeFromStart(bad), null);
});

test('only a live trainer is found by code, and only their clients are theirs', () => {
  const users = [
    { id: 'a', role: 'trainer', trainerCode: 'codea1' },
    { id: 'b', role: 'trainer', trainerCode: 'codeb1', disabled: true },
    { id: 'c', trainerId: 'a' }, { id: 'd', trainerId: 'b' }, { id: 'e' }
  ];
  assert.equal(findTrainerByCode(users, 'codea1').id, 'a');
  assert.equal(findTrainerByCode(users, 'codeb1'), null);
  assert.equal(findTrainerByCode(users, ''), null);
  assert.deepEqual(clientsOf(users, 'a').map(u => u.id), ['c']);
  assert.ok(isClientOf(users[2], users[0]));
  assert.ok(!isClientOf(users[4], users[0]));
  assert.ok(!isClientOf(users[3], { id: 'b', role: undefined }));
});

test('cleanBundle keeps routines/week/customEx and nothing else', () => {
  const b = cleanBundle({ opengym_plan: 1, unit: 'lb', name: 'Block A', exported: 'x', routines: [{ id: 'r', name: 'Push', ex: [] }, 5, { name: 1 }], week: { 1: 'r' }, customEx: [{ id: 'x' }, null], evil: { admin: true } });
  assert.deepEqual(Object.keys(b).sort(), ['customEx', 'name', 'opengym_plan', 'routines', 'unit', 'week']);
  assert.equal(b.routines.length, 1);
  assert.equal(b.customEx.length, 1);
  assert.equal(cleanBundle({ routines: [] }), null);
  assert.equal(cleanBundle('x'), null);
  assert.equal(cleanBundle({ routines: [{ name: 'Big', ex: ['x'.repeat(300 * 1024)] }] }), null);
});

test('inbox: newest first, capped, resolved once', () => {
  const bundle = { routines: [{ name: 'A', ex: [] }], week: {}, customEx: [] };
  let list = [];
  for (let i = 0; i < MAX_ASSIGNMENTS + 5; i++) list = addAssignment(list, newAssignment({ from: 't', fromName: 'T', bundle, now: 1000 + i }));
  assert.equal(list.length, MAX_ASSIGNMENTS);
  assert.equal(list[0].created, 1000 + MAX_ASSIGNMENTS + 4);
  const id = list[0].id;
  assert.equal(resolveAssignment(list, id, 'nonsense'), null);
  assert.equal(resolveAssignment(list, id, 'accepted', 5).status, 'accepted');
  assert.equal(resolveAssignment(list, id, 'declined'), null);
  assert.equal(resolveAssignment(list, 'missing', 'accepted'), null);
});
