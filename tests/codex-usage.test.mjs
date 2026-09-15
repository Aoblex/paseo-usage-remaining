import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsage } from '../server/usage.ts';

test('Codex preserves every reported window and additional rate-limit bucket', () => {
  const rows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 20, reset_at: 1_800_000_000, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 40, reset_at: 1_800_500_000, limit_window_seconds: 604_800 },
    },
    additional_rate_limits: [{
      metered_feature: 'code_review',
      limit_name: 'Code review',
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1_800_100_000, limit_window_seconds: 1_800 },
        secondary_window: { used_percent: 30, reset_at: 1_800_600_000, limit_window_seconds: 604_800 },
      },
    }],
  });

  assert.deepEqual(rows.map((row) => row.id), ['codex_0', 'codex_1', 'code_review_0', 'code_review_1']);
  assert.deepEqual(rows.map((row) => row.metricLabel), [
    '5-hour limit',
    '1-week limit',
    'Code review · 30-minute limit',
    'Code review · 1-week limit',
  ]);
  assert.deepEqual(rows.map((row) => row.remainingPct), [80, 60, 90, 70]);
});

test('Codex does not infer a duration from reset horizon when duration is absent', () => {
  const rows = parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 25, reset_at: Math.floor(Date.now() / 1000) + 60 },
  } });
  assert.equal(rows[0].metricLabel, 'Usage limit');
});
