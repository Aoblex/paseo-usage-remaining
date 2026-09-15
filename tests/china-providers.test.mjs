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
  assert.deepEqual(rows.map((row) => row.id), ['kimi_week', 'kimi_session', 'kimi_balance']);
  assert.equal(rows.find((row) => row.id === 'kimi_session').remainingPct, 60);
  assert.equal(rows.find((row) => row.id === 'kimi_week').remainingPct, 75);
  assert.equal(rows.find((row) => row.id === 'kimi_balance').remainingText, 'CNY 12.34');
});

test('Kimi accepts the upstream raw limits/detail and booster-wallet shape', () => {
  const rows = parseKimiUsage({
    limits: [{ name: 'rolling', window: { duration: 300, unit: 'TIME_UNIT_MINUTE' }, detail: { used: 1, limit: 10, resetTime: '2026-09-15T08:00:00Z' } }],
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: 2_000_000_000, amountLeft: 1_250_000_000 },
      monthlyChargeLimit: { priceInCents: 2000, currency: 'CNY' },
    },
  });
  assert.equal(rows.find((row) => row.id === 'kimi_session').remainingPct, 90);
  assert.equal(rows.find((row) => row.id === 'kimi_balance').remainingText, 'CNY 12.50');
});

test('GLM parses token/credit and MCP limits as remaining percentages', () => {
  const rows = parseGlmLimits({ data: { limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: 1789459200000 },
    { type: 'TIME_LIMIT', unit: 6, number: 1, percentage: 25, nextResetTime: 1790812800000 },
  ] } });
  assert.equal(rows[0].id, 'glm_session');
  assert.equal(rows[0].remainingPct, 82);
  assert.equal(rows[1].id, 'glm_mcp');
  assert.equal(rows[1].remainingPct, 75);
});

test('DeepSeek emits one monetary balance row per currency', () => {
  const rows = parseDeepSeekBalance({ balance_infos: [
    { currency: 'CNY', total_balance: '19.50' },
    { currency: 'USD', total_balance: 2 },
  ] });
  assert.deepEqual(rows.map((row) => row.remainingText), ['CNY 19.50', 'USD 2.00']);
  assert.ok(rows.every((row) => row.group === 'balance' && row.status === 'available'));
});
