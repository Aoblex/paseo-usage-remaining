import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrokBilling, withLastGood } from '../server/usage.ts';

const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-13T18:57:40Z', end: '2026-09-20T18:57:40Z' };

test('grok: creditUsagePercent drives the row when present', () => {
  const row = parseGrokBilling({ config: { creditUsagePercent: 100, currentPeriod: period } });
  assert.equal(row.status, 'available');
  assert.equal(row.remainingPct, 0);
  assert.equal(row.resetIso, period.end);
});

test('grok: a live period with the zero-valued usage fields omitted (protobuf JSON) is 100% remaining, not missing', () => {
  // Exact shape returned by cli-chat-proxy.grok.com right after the 2026-09-13 weekly reset.
  const row = parseGrokBilling({
    config: {
      currentPeriod: period,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      billingPeriodStart: period.start,
      billingPeriodEnd: period.end,
    },
  });
  assert.equal(row.status, 'available');
  assert.equal(row.remainingPct, 100);
  assert.equal(row.remainingText, '100%');
  assert.equal(row.resetIso, period.end);
  assert.equal(row.tone, 'ok');
});

test('grok: limit/used fallback still works and a body without any period is unavailable', () => {
  const row = parseGrokBilling({ config: { monthlyLimit: { val: 200 }, used: { val: 50 } } });
  assert.equal(row.remainingPct, 75);
  assert.equal(row.detail, 'of 200 credits');
  assert.equal(parseGrokBilling({}).status, 'unavailable');
  assert.equal(parseGrokBilling(null).status, 'unavailable');
});

test('withLastGood: a provider whose cached window already reset stays visible as a dimmed placeholder', () => {
  const now = Date.parse('2026-09-13T21:00:00Z');
  const cached = {
    id: 'grok_week', brand: 'grok', group: 'weekly', label: 'Grok', remainingText: '0%', remainingPct: 0,
    resetAt: '1m', resetIso: '2026-09-13T18:57:40Z', detail: null, tone: 'danger', status: 'available',
  };
  const cache = new Map([[cached.id, { row: cached, at: now - 60 * 60_000 }]]);
  const fresh = { ...cached, remainingText: '—', remainingPct: null, resetAt: null, resetIso: null, tone: 'default', status: 'unavailable', detail: 'not signed in or no usage data' };
  const [merged] = withLastGood([fresh], now, cache);
  assert.equal(merged.status, 'error');
  assert.equal(merged.remainingText, '—');
  assert.equal(merged.brand, 'grok');
  assert.equal(merged.resetAt, null);
  assert.match(merged.detail, /window reset/);
});

test('withLastGood: a provider with no cache at all stays unavailable (hidden), and a live cache is served with a fresh countdown', () => {
  const now = Date.parse('2026-09-13T21:00:00Z');
  const unavailable = { id: 'cursor_month', brand: 'cursor', group: 'weekly', label: 'Cursor', remainingText: '—', remainingPct: null, resetAt: null, resetIso: null, detail: null, tone: 'default', status: 'unavailable' };
  assert.equal(withLastGood([unavailable], now, new Map())[0].status, 'unavailable');
  const live = { ...unavailable, remainingText: '74%', remainingPct: 74, tone: 'ok', status: 'available', resetIso: '2026-09-16T19:01:09Z', resetAt: 'stale' };
  const cache = new Map([[live.id, { row: live, at: now - 5 * 60_000 }]]);
  const [served] = withLastGood([unavailable], now, cache);
  assert.equal(served.status, 'available');
  assert.equal(served.remainingText, '74%');
  assert.equal(served.resetAt, '2d 22h');
});
