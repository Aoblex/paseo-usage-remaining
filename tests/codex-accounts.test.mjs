import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexSlotNumber } from '../server/credentials.ts';
import { codexSlotRows, groupCodexCredentialsBySlot } from '../server/usage.ts';

const credential = (providerId) => ({
  provider: 'codex',
  source: providerId ? 'pi' : 'official-cli',
  sourceLabel: providerId ? 'Pi' : 'official CLI',
  kind: 'oauth',
  secret: providerId ?? 'codex-cli-token',
  providerId,
});

const windowRows = () => [
  { id: 'codex_0', brand: 'codex', group: 'session', label: 'Codex', remainingText: '80%' },
  { id: 'codex_1', brand: 'codex', group: 'weekly', label: 'Codex', remainingText: '60%' },
];

test('Codex provider ids map to account slots', () => {
  assert.equal(codexSlotNumber('openai-codex'), 1);
  assert.equal(codexSlotNumber('openai-codex-2'), 2);
  assert.equal(codexSlotNumber('openai-codex-11'), 11);
  assert.equal(codexSlotNumber('openai'), 1);
  assert.equal(codexSlotNumber(undefined), 1);
});

test('Codex credentials group per slot and keep other sources on slot 1', () => {
  const slots = groupCodexCredentialsBySlot([
    credential('openai-codex-2'),
    credential(undefined),
    credential('openai-codex'),
    credential('openai-codex-2'),
  ]);
  assert.deepEqual([...slots.keys()], [2, 1]);
  assert.deepEqual(slots.get(2).map((item) => item.source), ['pi', 'pi']);
  assert.deepEqual(slots.get(1).map((item) => item.source), ['official-cli', 'pi']);
});

test('a lone Codex account keeps the original ids and label', () => {
  const rows = windowRows();
  assert.equal(codexSlotRows(1, rows, false), rows);
});

test('a lone extra slot still names its account', () => {
  const rows = codexSlotRows(2, windowRows(), false);
  assert.deepEqual(rows.map((row) => row.id), ['codex_2_0', 'codex_2_1']);
  assert.deepEqual(rows.map((row) => row.label), ['Codex #2', 'Codex #2']);
  assert.deepEqual(rows.map((row) => row.providerKey), ['codex-2', 'codex-2']);
  assert.deepEqual(rows.map((row) => row.brand), ['codex', 'codex']);
});

test('multiple Codex accounts become separate numbered rows', () => {
  const first = codexSlotRows(1, windowRows(), true);
  const second = codexSlotRows(2, windowRows(), true);
  assert.deepEqual(first.map((row) => row.id), ['codex_1_0', 'codex_1_1']);
  assert.deepEqual(first.map((row) => row.label), ['Codex #1', 'Codex #1']);
  assert.deepEqual(second.map((row) => row.id), ['codex_2_0', 'codex_2_1']);
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 4);
});
