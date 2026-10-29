import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminActivityStatusHandler } from '../../admin-activity-status.mjs';

const request = (cancelled, activityId = 'ACT-TEST-001') => ({
  pathParameters: { activityId },
  body: JSON.stringify({ cancelled }),
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
});

const handlerWith = (client) => createAdminActivityStatusHandler(
  client,
  'club-activities-dev',
  () => new Date('2026-09-30T12:00:00.000Z')
);

describe('PUT /admin/activities/{activityId}/cancellation', () => {
  it('활동을 취소 상태로 바꾸고 관리자 감사 정보를 남긴다', async () => {
    let captured;
    const client = {
      send: async (command) => {
        captured = command.input;
        return { Attributes: { activityId: 'ACT-TEST-001', activityStatus: 'CANCELLED' } };
      }
    };

    const result = await handlerWith(client)(request(true));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.activity.activityStatus, 'CANCELLED');
    assert.match(captured.UpdateExpression, /activityStatus = :cancelled/);
    assert.equal(captured.ExpressionAttributeValues[':adminEmail'], 'admin@example.com');
  });

  it('활동 취소를 해제하고 기존 취소 감사 정보를 제거한다', async () => {
    let captured;
    const client = {
      send: async (command) => {
        captured = command.input;
        return { Attributes: { activityId: 'ACT-TEST-001', activityStatus: 'ACTIVE' } };
      }
    };

    const result = await handlerWith(client)(request(false));

    assert.equal(result.statusCode, 200);
    assert.match(captured.UpdateExpression, /activityStatus = :active/);
    assert.match(captured.UpdateExpression, /REMOVE activityCancelledAt, activityCancelledBy/);
  });

  it('잘못된 요청은 DynamoDB 호출 전에 거부한다', async () => {
    const client = { send: async () => { throw new Error('호출하면 안 됩니다'); } };
    const result = await handlerWith(client)({
      pathParameters: { activityId: 'ACT-TEST-001' },
      body: JSON.stringify({ cancelled: 'yes' })
    });

    assert.equal(result.statusCode, 400);
  });

  it('존재하지 않는 활동은 404로 응답한다', async () => {
    const error = new Error('not found');
    error.name = 'ConditionalCheckFailedException';
    const client = { send: async () => { throw error; } };

    const result = await handlerWith(client)(request(true));
    assert.equal(result.statusCode, 404);
  });
});
