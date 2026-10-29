import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApplicationNameHandler } from '../../admin-application-name.mjs';

const event = (body) => ({
  body: JSON.stringify(body),
  requestContext: {
    authorizer: { claims: { email: 'admin@example.com' } }
  }
});

describe('PUT /admin/applications/name', () => {
  it('신청자의 표시 이름과 정규화 이름을 함께 수정한다', async () => {
    let command;
    const client = {
      send: async (received) => {
        command = received;
        return {
          Attributes: {
            activityId: 'ACT-TEST-001',
            applicantKey: 'MEMBER#김성현#key',
            applicationId: 'application-1',
            applicantRole: 'MEMBER',
            name: '김성현 (고려대)',
            status: 'CONFIRMED',
            createdAt: '2026-09-01T00:00:00.000Z'
          }
        };
      }
    };

    const result = await createAdminApplicationNameHandler(
      client,
      'club-applications-dev',
      () => new Date('2026-09-14T00:00:00.000Z')
    )(event({
      activityId: 'ACT-TEST-001',
      applicantKey: 'MEMBER#김성현#key',
      applicationId: 'application-1',
      name: '  김성현   (고려대)  '
    }));

    assert.equal(result.statusCode, 200);
    assert.equal(command.input.ExpressionAttributeValues[':name'], '김성현 (고려대)');
    assert.equal(command.input.ExpressionAttributeValues[':normalizedName'], '김성현 (고려대)');
    assert.equal(JSON.parse(result.body).application.name, '김성현 (고려대)');
  });

  it('너무 짧은 이름은 DynamoDB 호출 전에 거부한다', async () => {
    const client = {
      send: async () => {
        throw new Error('호출되면 안 됩니다');
      }
    };

    const result = await createAdminApplicationNameHandler(
      client,
      'club-applications-dev'
    )(event({
      activityId: 'ACT-TEST-001',
      applicantKey: 'MEMBER#김#key',
      applicationId: 'application-1',
      name: '김'
    }));

    assert.equal(result.statusCode, 400);
  });

  it('대상이 이미 바뀌었으면 충돌 응답을 반환한다', async () => {
    const client = {
      send: async () => {
        const error = new Error('conditional failure');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
    };

    const result = await createAdminApplicationNameHandler(
      client,
      'club-applications-dev'
    )(event({
      activityId: 'ACT-TEST-001',
      applicantKey: 'MEMBER#김성현#key',
      applicationId: 'application-1',
      name: '김성현 (고려대)'
    }));

    assert.equal(result.statusCode, 409);
  });
});
