import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepSeekBalance, parseGlmLimits, parseKimiUsage } from '../server/usage.ts';

test('Kimi parses short and weekly quota windows plus extra balance', () => {
  const rows = parseKimiUsage({ data: {
    kind: 'ok',
    summary: { used: 25, limit: 100, reset_at: '2026-09-21T00:00:00Z' },
    limits: [{ name: 'session', window: { duration: 5, unit: 'hour' }, used: 40, limit: 100, reset_at: '2026-09-15T08:00:00Z' }],
    extra_usage: { balance_cents: 1234, currency: 'CNY' },
  } });
  assert.deepEqual(rows.map((row) => row.id), ['kimi_limit_0', 'kimi_5h', 'kimi_balance']);
  assert.equal(rows.find((row) => row.id === 'kimi_5h').remainingPct, 60);
  assert.equal(rows.find((row) => row.id === 'kimi_5h').metricLabel, '5-hour limit');
  assert.equal(rows.find((row) => row.id === 'kimi_limit_0').remainingPct, 75);
  assert.equal(rows.find((row) => row.id === 'kimi_limit_0').metricLabel, 'Usage limit');
  assert.equal(rows.find((row) => row.id === 'kimi_balance').remainingText, 'CNY 12.34');
});

test('Kimi preserves named limits from the current subscription payload', () => {
  const rows = parseKimiUsage({ usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-09-15T08:00:00Z' },
    limit_month_total: { used_ratio: 0.1, reset_time: '2026-10-15T00:00:00Z' },
    limit_month_code: { used_ratio: 0.4, reset_time: '2026-10-15T00:00:00Z' },
  } });
  assert.deepEqual(rows.map((row) => row.metricLabel), [
    '5-hour rolling usage',
    'Membership monthly usage',
    'Kimi Code monthly usage',
  ]);
  assert.deepEqual(rows.map((row) => row.remainingPct), [75, 90, 60]);
});

test('Kimi accepts the upstream raw limits/detail and booster-wallet shape', () => {
  const rows = parseKimiUsage({
    limits: [{ name: 'rolling', window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: 1, limit: 10, resetTime: '2026-09-15T08:00:00Z' } }],
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: 2_000_000_000, amountLeft: 1_250_000_000 },
      monthlyChargeLimit: { priceInCents: 2000, currency: 'CNY' },
    },
  });
  assert.equal(rows.find((row) => row.id === 'kimi_5h').remainingPct, 90);
  assert.equal(rows.find((row) => row.id === 'kimi_5h').metricLabel, '5-hour limit');
  assert.equal(rows.find((row) => row.id === 'kimi_balance').remainingText, 'CNY 12.50');
});

test('GLM parses token/credit and MCP limits as remaining percentages', () => {
  const rows = parseGlmLimits({ data: { limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: 1789459200000 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 25, nextResetTime: 1790812800000 },
  ] } });
  assert.equal(rows[0].id, 'glm_credit_3_5');
  assert.equal(rows[0].metricLabel, '5-hour credits');
  assert.equal(rows[0].remainingPct, 82);
  assert.equal(rows[1].id, 'glm_mcp_5_1');
  assert.equal(rows[1].metricLabel, 'MCP usage · 1 month');
  assert.equal(rows[1].remainingPct, 75);
});

test('DeepSeek emits one monetary balance row per currency', () => {
  const rows = parseDeepSeekBalance({ is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '19.50', granted_balance: '1.25', topped_up_balance: '18.25' },
    { currency: 'USD', total_balance: 2 },
  ] });
  assert.deepEqual(rows.map((row) => row.remainingText), ['CNY 19.50', 'USD 2.00']);
  assert.ok(rows.every((row) => row.metricLabel === 'API balance'));
  assert.match(rows[0].detail, /Available for API calls/);
  assert.match(rows[0].detail, /granted CNY 1.25/);
  assert.ok(rows.every((row) => row.group === 'balance' && row.status === 'available'));
});
