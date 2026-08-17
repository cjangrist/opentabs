import assert from 'node:assert/strict';
import test from 'node:test';
import { mapConversation } from '../dist/grok-conversations.js';

const legacyMembershipId = '1735c097-cfe2-42ec-809d-b2cd8e806e9d';

test('does not expose a legacy research membership as a writable Project', () => {
  const mapped = mapConversation({
    conversationId: '00000000-0000-0000-0000-000000000001',
    workspaceId: legacyMembershipId,
  });

  assert.equal(mapped.project_id, null);
});

test('selects a writable Project after a legacy research membership', () => {
  const mapped = mapConversation({
    conversationId: '00000000-0000-0000-0000-000000000002',
    workspaceId: legacyMembershipId,
    workspaces: [{ workspaceId: '00000000-0000-0000-0000-000000000003' }],
  });

  assert.equal(mapped.project_id, '00000000-0000-0000-0000-000000000003');
});
