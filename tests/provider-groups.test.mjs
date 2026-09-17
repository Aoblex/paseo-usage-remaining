import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRowsByProvider, metricLabel } from '../client/provider-groups.ts';

const row = (id, brand, group, status = 'available', detail = null) => ({
  id,
  brand,
  group,
  label: brand === 'fable' ? 'Fable' : brand[0].toUpperCase() + brand.slice(1),
  remainingText: status === 'available' ? '75%' : '—',
  remainingPct: status === 'available' ? 75 : null,
  resetAt: status === 'available' ? '4d' : null,
  resetIso: null,
  detail,
  tone: 'ok',
  status,
});

test('groups quota windows by provider instead of global window type', () => {
  const providers = groupRowsByProvider([
    row('claude_session', 'claude', 'session'),
    row('claude_week', 'claude', 'weekly'),
    row('fable_week', 'fable', 'weekly'),
    row('codex_week', 'codex', 'weekly'),
    row('kimi_balance', 'kimi', 'balance'),
  ]);
  assert.deepEqual(providers.map((provider) => provider.id), ['claude', 'codex', 'kimi']);
  assert.deepEqual(providers[0].metrics.map(metricLabel), ['Session', 'Weekly', 'Fable weekly']);
  assert.equal(providers[2].metrics.map(metricLabel)[0], 'Extra usage');
});

test('provider card extracts one credential source and keeps useful status details', () => {
  const [provider] = groupRowsByProvider([
    row('codex_session', 'codex', 'session', 'unavailable', 'no 5-hour window on this plan · credential: Pi'),
    row('codex_week', 'codex', 'weekly', 'available', 'credential: Pi'),
  ]);
  assert.equal(provider.credentialSource, 'Pi');
  assert.equal(provider.status, 'available');
  assert.deepEqual(provider.metrics.map((metric) => metric.id), ['codex_week']);
  assert.deepEqual(provider.details, []);
});

test('unconfigured providers remain as one explanatory card without empty metric rows', () => {
  const [provider] = groupRowsByProvider([
    row('glm_session', 'glm', 'session', 'unavailable', 'not signed in or no usage data · no supported credentials found'),
    row('glm_mcp', 'glm', 'weekly', 'unavailable', 'not signed in or no usage data · no supported credentials found'),
  ]);
  assert.equal(provider.status, 'unavailable');
  assert.deepEqual(provider.metrics, []);
  assert.deepEqual(provider.details, ['No supported credentials found']);
});

test('DeepSeek currency rows share one API balance card', () => {
  const [provider] = groupRowsByProvider([
    row('deepseek_balance_cny_0', 'deepseek', 'balance'),
    row('deepseek_balance_usd_1', 'deepseek', 'balance'),
  ]);
  assert.equal(provider.label, 'DeepSeek');
  assert.deepEqual(provider.metrics.map(metricLabel), ['API balance', 'API balance']);
});

test('extra Codex accounts stay separate cards under the Codex brand', () => {
  const codexRow = (id, group, account) => ({
    ...row(id, 'codex', group),
    label: account,
    providerKey: account === 'Codex #1' ? 'codex-1' : 'codex-2',
  });
  const providers = groupRowsByProvider([
    codexRow('codex_1_0', 'session', 'Codex #1'),
    codexRow('codex_1_1', 'weekly', 'Codex #1'),
    codexRow('codex_2_0', 'session', 'Codex #2'),
    row('grok_week', 'grok', 'weekly'),
  ]);
  assert.deepEqual(providers.map((provider) => provider.id), ['codex-1', 'codex-2', 'grok']);
  assert.deepEqual(providers.map((provider) => provider.label), ['Codex #1', 'Codex #2', 'Grok']);
  assert.deepEqual(providers.map((provider) => provider.brand), ['codex', 'codex', 'grok']);
  assert.deepEqual(providers[1].metrics.map((metric) => metric.id), ['codex_2_0']);
});
