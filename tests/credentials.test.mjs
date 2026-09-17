import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCredentials, fetchWithCredentials, sortCredentialCandidates } from '../server/credentials.ts';

const credential = (source, secret, extra = {}) => ({
  provider: 'kimi',
  source,
  sourceLabel: source,
  kind: 'oauth',
  secret,
  ...extra,
});

test('credential candidates follow source priority and deduplicate secrets', () => {
  const candidates = sortCredentialCandidates([
    credential('official-cli', 'shared'),
    credential('pi', 'pi-token'),
    credential('opencode', 'shared'),
    credential('env', 'env-token'),
  ], ['pi', 'opencode', 'official-cli', 'env']);
  assert.deepEqual(candidates.map((item) => [item.source, item.secret]), [
    ['pi', 'pi-token'],
    ['opencode', 'shared'],
    ['env', 'env-token'],
  ]);
});

test('credentials sharing a secret retain authentication-critical metadata', () => {
  const refresh = async () => null;
  const candidates = sortCredentialCandidates([
    credential('env', 'shared'),
    credential('pi', 'shared', { accountId: 'account', expiresAt: 123, refresh }),
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].accountId, 'account');
  assert.equal(candidates[1].refresh, refresh);
});

test('OpenCode auth content is discovered without creating a plugin credential store', async () => {
  const previous = process.env.OPENCODE_AUTH_CONTENT;
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    deepseek: { type: 'api', key: 'opencode-deepseek-test-key' },
    'zai-coding-plan': { type: 'api', key: 'opencode-zai-test-key' },
  });
  try {
    const candidates = await discoverCredentials('deepseek');
    const found = candidates.find((item) => item.source === 'opencode');
    assert.equal(found?.kind, 'api-key');
    assert.equal(found?.secret, 'opencode-deepseek-test-key');
    const glm = (await discoverCredentials('glm')).find((item) => item.source === 'opencode');
    assert.equal(glm?.providerId, 'zai-coding-plan');
  } finally {
    if (previous == null) delete process.env.OPENCODE_AUTH_CONTENT;
    else process.env.OPENCODE_AUTH_CONTENT = previous;
  }
});

test('authentication rejection falls through to the next credential source', async () => {
  const attempts = [];
  const result = await fetchWithCredentials('kimi', [
    credential('pi', 'stale'),
    credential('opencode', 'valid'),
  ], async (item) => {
    attempts.push(item.source);
    return new Response(null, { status: item.secret === 'valid' ? 200 : 401 });
  });
  assert.deepEqual(attempts, ['pi', 'opencode']);
  assert.equal(result.response?.status, 200);
  assert.equal(result.credential?.source, 'opencode');
  assert.equal(result.detail, 'credential: opencode');
});

test('Codex HTML login responses fall through to another credential', async () => {
  const attempts = [];
  const result = await fetchWithCredentials('codex', [
    { ...credential('env', 'redirected'), provider: 'codex' },
    { ...credential('pi', 'valid'), provider: 'codex' },
  ], async (item) => {
    attempts.push(item.source);
    return item.secret === 'redirected'
      ? new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(attempts, ['env', 'pi']);
  assert.equal(result.credential?.source, 'pi');
});

test('expired credentials are skipped and never sent', async () => {
  const attempts = [];
  const result = await fetchWithCredentials('kimi', [
    credential('pi', 'expired', { expiresAt: 1 }),
    credential('official-cli', 'valid'),
  ], async (item) => {
    attempts.push(item.secret);
    return new Response(null, { status: 200 });
  }, 10_000);
  assert.deepEqual(attempts, ['valid']);
  assert.equal(result.credential?.source, 'official-cli');
});

test('a refreshable credential refreshes once after a 401', async () => {
  let refreshes = 0;
  const refreshed = credential('pi', 'fresh');
  const initial = credential('pi', 'stale', {
    refresh: async (force) => {
      assert.equal(force, true);
      refreshes += 1;
      return refreshed;
    },
  });
  const attempts = [];
  const result = await fetchWithCredentials('kimi', [initial], async (item) => {
    attempts.push(item.secret);
    return new Response(null, { status: item.secret === 'fresh' ? 200 : 401 });
  });
  assert.deepEqual(attempts, ['stale', 'fresh']);
  assert.equal(refreshes, 1);
  assert.equal(result.response?.status, 200);
});

test('refresh failures do not prevent fallback to another source', async () => {
  const attempts = [];
  const result = await fetchWithCredentials('kimi', [
    credential('pi', 'stale', { refresh: async () => { throw new Error('network'); } }),
    credential('opencode', 'valid'),
  ], async (item) => {
    attempts.push(item.secret);
    return new Response(null, { status: item.secret === 'valid' ? 200 : 401 });
  });
  assert.deepEqual(attempts, ['stale', 'valid']);
  assert.equal(result.credential?.source, 'opencode');
});

test('failure details contain source labels but never credential contents', async () => {
  const result = await fetchWithCredentials('kimi', [credential('pi', 'do-not-log-this')], async () =>
    new Response(null, { status: 403 }),
  );
  assert.match(result.detail, /Rejected: pi \(403\)/i);
  assert.doesNotMatch(result.detail, /do-not-log-this/);
});
