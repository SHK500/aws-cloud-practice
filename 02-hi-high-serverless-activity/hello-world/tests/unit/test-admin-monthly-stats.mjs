import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminMonthlyStatsHandler } from '../../admin-monthly-stats.mjs';

const event = (queryStringParameters = {}) => ({
  queryStringParameters: {
    month: '2026-09',
    applicantRole: 'ALL',
    ...queryStringParameters
  },
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
});

const activities = [
  { activityId: 'ACT-SEP-001', name: '9월 봉사', activityDate: '2026-09-03', startTime: '10:00' },
  { activityId: 'ACT-SEP-002', name: '9월 버킷', activityDate: '2026-09-20', startTime: '10:00' },
  { activityId: 'ACT-SEP-CANCELLED', name: '취소된 봉사', activityDate: '2026-09-15', startTime: '10:00', activityStatus: 'CANCELLED' },
  { activityId: 'ACT-AUG-001', name: '8월 봉사', activityDate: '2026-08-31', startTime: '10:00' }
];

const applications = [
  { activityId: 'ACT-SEP-001', applicantRole: 'MEMBER', name: '김성현 (고려대)', normalizedName: '김성현 (고려대)', status: 'CONFIRMED', attendanceStatus: 'ATTENDED' },
  { activityId: 'ACT-SEP-002', applicantRole: 'REPORTER', name: '김성현 (고려대)', normalizedName: '김성현 (고려대)', status: 'CONFIRMED', attendanceStatus: 'ATTENDED' },
  { activityId: 'ACT-SEP-001', applicantRole: 'MEMBER', name: '박민지', normalizedName: '박민지', status: 'CONFIRMED', attendanceStatus: 'ATTENDED' },
  { activityId: 'ACT-SEP-002', applicantRole: 'MEMBER', name: '박민지', normalizedName: '박민지', status: 'CONFIRMED', attendanceStatus: 'ABSENT' },
  { activityId: 'ACT-SEP-002', applicantRole: 'MEMBER', name: '최대기', normalizedName: '최대기', status: 'WAITLISTED', attendanceStatus: 'ATTENDED' },
  { activityId: 'ACT-SEP-CANCELLED', applicantRole: 'MEMBER', name: '취소활동 참가자', normalizedName: '취소활동 참가자', status: 'CONFIRMED', attendanceStatus: 'ATTENDED' },
  { activityId: 'ACT-AUG-001', applicantRole: 'MEMBER', name: '지난달', normalizedName: '지난달', status: 'CONFIRMED', attendanceStatus: 'ATTENDED' }
];

const handler = (now = '2026-09-30T00:00:00.000Z') => createAdminMonthlyStatsHandler({
  send: async (command) => ({
    Items: command.input.TableName === 'club-activities-dev' ? activities : applications
  })
}, 'club-activities-dev', 'club-applications-dev', () => new Date(now));

describe('GET /admin/stats/monthly', () => {
  it('실제 참여자만 월별로 집계하고 순위를 계산한다', async () => {
    const result = await handler()(event());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.activityCount, 2);
    assert.equal(body.attendedCount, 3);
    assert.equal(body.absentCount, 1);
    assert.deepEqual(body.mvp, [{
      rank: 1,
      name: '김성현 (고려대)',
      count: 2
    }]);
    assert.equal(body.leaderboard[1].rank, 2);
    assert.equal(body.leaderboard[1].name, '박민지');
  });

  it('일반 부원과 기자단 참여를 하나의 MVP 기록으로 합친다', async () => {
    const result = await handler()(event());
    const body = JSON.parse(result.body);

    assert.equal(body.leaderboard[0].name, '김성현 (고려대)');
    assert.equal(body.leaderboard[0].count, 2);
    assert.equal('memberCount' in body.leaderboard[0], false);
    assert.equal('reporterCount' in body.leaderboard[0], false);
  });

  it('취소된 활동과 해당 참가자는 MVP 집계에서 제외한다', async () => {
    const result = await handler()(event());
    const body = JSON.parse(result.body);

    assert.equal(body.activityCount, 2);
    assert.equal(body.leaderboard.some((item) => item.name === '취소활동 참가자'), false);
  });

  it('아직 시작하지 않은 활동은 기본 참여 집계에서 제외한다', async () => {
    const result = await handler('2026-09-10T00:00:00.000Z')(event());
    const body = JSON.parse(result.body);

    assert.equal(body.activityCount, 1);
    assert.equal(body.attendedCount, 2);
    assert.equal(body.leaderboard.every((item) => item.count === 1), true);
  });

  it('잘못된 월 형식을 DynamoDB 호출 전에 거부한다', async () => {
    const result = await handler()(event({ month: '2026-13' }));
    assert.equal(result.statusCode, 400);
  });
});
