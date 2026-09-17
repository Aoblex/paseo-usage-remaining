import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerUsagePills, usageLabel } from '../client/registry.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const agent = (id, workspaceId = 'w', extra = {}) => ({ id, workspaceId, provider: 'codex', ...extra });
const snapshot = { rows: [{ brand: 'codex', label: 'Codex', group: 'weekly', remainingText: '92%', status: 'available' }] };
function fixture(list) {
  let update;
  const created = [];
  const state = { unsubscribed: false, opened: null };
  const client = {
    paseo: { agents: { list, subscribe(fn) { update = fn; return () => { state.unsubscribed = true; }; } } },
    addComposerPill(input) {
      assert.ok(input.button.behavior);
      const row = { input, removed: false, patches: [] };
      created.push(row);
      return { update(patch) { row.patches.push(patch); }, remove() { row.removed = true; } };
    },
    openSurface(id) { state.opened = id; },
  };
  return { client, created, state, update: value => update(value) };
}
test('current provider label uses value shape without quota group abbreviations', () => {
  assert.equal(usageLabel('codex', 'gpt-6-astra', snapshot), 'Codex · 92%');
  assert.equal(usageLabel('codex/gpt-6-astra', undefined, snapshot), 'Codex · 92%');
  assert.equal(usageLabel('claude', 'fable-1', snapshot), 'Usage unavailable');
  assert.equal(usageLabel('codex', 'gpt-6-astra'), 'Usage…');
  assert.equal(usageLabel('cursor', 'auto', { rows: [{ ...snapshot.rows[0], brand: 'cursor', label: 'Cursor', resetAt: '4d' }] }), 'Cursor · 92% 4d');
});

test('wrapper providers resolve the brand from the model', () => {
  const rows = [
    { ...snapshot.rows[0], label: 'Codex #1', providerKey: 'codex-1' },
    { ...snapshot.rows[0], id: 'codex_2_week', label: 'Codex #2', providerKey: 'codex-2', remainingText: '—', status: 'error' },
    { ...snapshot.rows[0], id: 'deepseek_balance', brand: 'deepseek', label: 'DeepSeek', remainingText: 'CNY 28.70' },
    { ...snapshot.rows[0], id: 'kimi_week', brand: 'kimi', label: 'Kimi', remainingText: '96%' },
  ];
  const wrapperSnapshot = { rows };
  // Paseo reports every Pi agent as provider "pi", so the old provider-only lookup
  // labelled all of them "Usage unavailable".
  assert.equal(usageLabel('pi', 'deepseek/deepseek-flash', wrapperSnapshot), 'DeepSeek · CNY 28.70');
  assert.equal(usageLabel('pi', 'openai-codex/gpt-5.6-sol', wrapperSnapshot), 'Codex #1 92% · Codex #2 —');
  assert.equal(usageLabel('pi', 'kimi-coding/k3', wrapperSnapshot), 'Kimi · 96%');
  assert.equal(usageLabel('opencode', 'zai-coding-plan/glm-5', wrapperSnapshot), 'Usage unavailable');
  // An unknown model still shows the providers we do know about, in strip order.
  assert.equal(usageLabel('pi', 'mystery/model', wrapperSnapshot), 'Codex #1 92% · Codex #2 — · Kimi 96% · DeepSeek CNY 28.70');
  assert.equal(usageLabel('pi', null, wrapperSnapshot), 'Codex #1 92% · Codex #2 — · Kimi 96% · DeepSeek CNY 28.70');
});
test('all pages register; status updates preserve identity; moving/removing agents cleans up', async () => {
  const f = fixture(async ({ page }) => page.cursor ? { entries: [{ agent: agent('b') }], pageInfo: {} } : { entries: [{ agent: agent('a') }], pageInfo: { hasMore: true, nextCursor: 'next' } });
  const stop = registerUsagePills(f.client, async () => snapshot);
  try {
    await tick();
    assert.equal(f.created.length, 2);
    f.update({ kind: 'upsert', agent: agent('a') });
    assert.equal(f.created.length, 2);
    assert.equal(f.created[0].patches.at(-1).label, 'Codex · 92%');
    f.created[0].input.button.behavior.onPress();
    assert.equal(f.state.opened, 'main');
    f.update({ kind: 'upsert', agent: agent('a', 'other') });
    assert.ok(f.created[0].removed);
    assert.equal(f.created.length, 3);
    f.update({ kind: 'remove', agentId: 'b' });
    assert.ok(f.created[1].removed);
  } finally { stop(); }
  assert.ok(f.state.unsubscribed);
  assert.ok(f.created.every(row => row.removed));
});
test('late bootstrap and usage replies cannot recreate pills after cleanup', async () => {
  const bootstrap = deferred(), usage = deferred();
  const f = fixture(() => bootstrap.promise);
  const stop = registerUsagePills(f.client, () => usage.promise);
  stop();
  bootstrap.resolve({ entries: [{ agent: agent('a') }], pageInfo: {} });
  usage.resolve(snapshot);
  await tick();
  assert.equal(f.created.length, 0);
});
test('bootstrap cannot resurrect an agent removed by a newer update', async () => {
  const bootstrap = deferred();
  const f = fixture(() => bootstrap.promise);
  const stop = registerUsagePills(f.client, async () => snapshot);
  try {
    f.update({ kind: 'remove', agentId: 'a' });
    bootstrap.resolve({ entries: [{ agent: agent('a') }], pageInfo: {} });
    await tick();
    assert.equal(f.created.length, 0);
  } finally { stop(); }
});
test('usage failure leaves a visible, clickable unavailable state', async () => {
  const f = fixture(async () => ({ entries: [{ agent: agent('a') }], pageInfo: {} }));
  const stop = registerUsagePills(f.client, async () => { throw Error('offline'); });
  try {
    await tick();
    assert.equal(f.created[0].patches.at(-1).label, 'Usage unavailable');
    f.created[0].input.button.behavior.onPress();
    assert.equal(f.state.opened, 'main');
  } finally { stop(); }
});

test('native sheet remains available after refresh, agent updates and provider failure', async () => {
  const f = fixture(async () => ({ entries: [{ agent: agent('a') }], pageInfo: {} }));
  const Content = () => null;
  const stop = registerUsagePills(f.client, async () => { throw Error('offline'); }, 'Gauge', Content);
  try {
    await tick();
    const button = f.created[0].input.button;
    assert.equal(button.behavior.kind, 'popover');
    assert.equal(button.behavior.Content, Content);
    assert.equal(f.created[0].patches.at(-1).label, 'Usage unavailable');
    f.update({ kind: 'upsert', agent: agent('a') });
    assert.equal(f.created.length, 1);
    assert.equal(button.behavior.Content, Content);
    assert.equal(f.state.opened, null);
  } finally { stop(); }
});
