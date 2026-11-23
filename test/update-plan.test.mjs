import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { planUpdates } from '../dist/update/plan.mjs';

const agentRuntime = { current: '0.2.0-rc.2', latest: '0.2.0' };

test('an agent runtime update is offered when the user allows optional updates', () => {
  assert.deepEqual(planUpdates({ agentRuntime }, { promptOptional: true }), { agentRuntime });
});

test('an agent runtime update honors skip and explicit manual checks', () => {
  assert.equal(planUpdates({ agentRuntime }, { promptOptional: true, skippedAgentRuntime: agentRuntime.latest }), undefined);
  assert.equal(planUpdates({ agentRuntime }, { promptOptional: false }), undefined);
  assert.equal(planUpdates({}, { promptOptional: true }), undefined);
});
