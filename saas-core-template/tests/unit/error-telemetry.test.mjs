// Client error telemetry throttle / guards.   node tests/unit/error-telemetry.test.mjs
import assert from 'node:assert/strict';
import { createErrorReporter } from '../../extension-core/error-telemetry.js';

const mk = (over = {}) => {
  const calls = []; let clock = 1e12;
  const report = createErrorReporter({ configured: () => true, getToken: async () => 'tok', rpc: async (...a) => { calls.push(a); }, getVersion: () => '1.2.3', now: () => clock, ...over });
  return { report, calls, tick: (ms) => (clock += ms) };
};

{
  const { report, calls, tick } = mk();
  await report('sync_failed', 'ctx');
  assert.deepEqual(calls[0], ['tok', 'report_client_error', { p_code: 'sync_failed', p_context: 'ctx', p_version: '1.2.3' }]);
  await report('sync_failed', 'ctx');
  assert.equal(calls.length, 1, 'same key throttled for 10 min');
  await report('sync_failed', 'other');
  assert.equal(calls.length, 2, 'other context passes');
  tick(10 * 60000 + 1);
  await report('sync_failed', 'ctx');
  assert.equal(calls.length, 3, 'passes after 10 min');
  await report('');
  assert.equal(calls.length, 3, 'empty code ignored');
  await report('x'.repeat(500), 'y'.repeat(500));
  assert.equal(calls[3][2].p_code.length, 120);
  assert.equal(calls[3][2].p_context.length, 120);
}
{
  const { report, calls } = mk({ configured: () => false });
  await report('a'); assert.equal(calls.length, 0, 'not configured: nothing sent');
}
{
  const { report, calls } = mk({ getToken: async () => null });
  await report('a'); assert.equal(calls.length, 0, 'signed out: nothing sent');
}
{
  const { report } = mk({ rpc: async () => { throw new Error('boom'); } });
  await report('a'); // must not throw
}
console.log('ok error-telemetry');
