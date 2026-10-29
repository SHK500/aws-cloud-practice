import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminAttendanceHandler } from '../../admin-attendance.mjs';

const event = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    applicantKey: 'MEMBER#홍길동#key',
    applicationId: 'application-1',
    attendanceStatus: 'ATTENDED',
    ...overrides
  }),
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
});

describe('PUT /admin/applications/attendance', () => {
  it('확정 신청자를 참여로 기록한다', async () => {
    let command;
    const client = {
      send: async (received) => {
        command = received;
        return {
          Attributes: {
            activityId: 'ACT-TEST-001',
            applicantKey: 'MEMBER#홍길동#key',
            applicationId: 'application-1',
            attendanceStatus: 'ATTENDED',
            attendanceUpdatedAt: '2026-09-14T00:00:00.000Z'
          }
        };
      }
    };

    const result = await createAdminAttendanceHandler(
      client,
      'club-applications-dev',
      () => new Date('2026-09-14T00:00:00.000Z')
    )(event());

    assert.equal(result.statusCode, 200);
    assert.equal(command.input.ExpressionAttributeValues[':attendanceStatus'], 'ATTENDED');
    assert.equal(command.input.ExpressionAttributeValues[':adminEmail'], 'admin@example.com');
    assert.equal(JSON.parse(result.body).application.attendanceStatus, 'ATTENDED');
  });

  it('잘못된 출석 상태를 저장 전에 거부한다', async () => {
    const client = { send: async () => { throw new Error('호출되면 안 됩니다'); } };
    const result = await createAdminAttendanceHandler(
      client,
      'club-applications-dev'
    )(event({ attendanceStatus: 'LATE' }));

    assert.equal(result.statusCode, 400);
  });

  it('확정자가 아니거나 변경된 신청은 충돌로 처리한다', async () => {
    const client = {
      send: async () => {
        const error = new Error('conditional failure');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
    };
    const result = await createAdminAttendanceHandler(
      client,
      'club-applications-dev'
    )(event());

    assert.equal(result.statusCode, 409);
  });
});
