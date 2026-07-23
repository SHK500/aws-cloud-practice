import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApplicationsHandler } from '../../admin-applications.mjs';

const event = (queryStringParameters = {}) => ({
  queryStringParameters,
  requestContext: {
    authorizer: {
      claims: { email: 'admin@example.com' }
    }
  }
});

describe('GET /admin/applications', () => {
  it('관리자에게 필요한 필드만 반환하고 비밀번호 정보는 숨긴다', async () => {
    const client = {
      send: async () => ({
        Items: [{
          activityId: 'ACT-TEST-001',
          applicantKey: 'MEMBER#홍길동',
          applicationId: 'application-1',
          applicantRole: 'MEMBER',
          name: '홍길동',
          status: 'CONFIRMED',
          createdAt: '2026-07-22T01:00:00.000Z',
          passwordSalt: 'must-not-return',
          passwordHash: 'must-not-return'
        }]
      })
    };

    const result = await createAdminApplicationsHandler(
      client,
      'club-applications-dev'
    )(event({ activityId: 'ACT-TEST-001' }));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.count, 1);
    assert.equal(body.applications[0].name, '홍길동');
    assert.equal('passwordHash' in body.applications[0], false);
    assert.equal('passwordSalt' in body.applications[0], false);
  });

  it('대타 필요 상태만 필터링한다', async () => {
    const client = {
      send: async () => ({
        Items: [
          {
            activityId: 'ACT-TEST-001',
            applicationId: 'application-1',
            applicantRole: 'MEMBER',
            name: '홍길동',
            status: 'REPLACEMENT_NEEDED'
          },
          {
            activityId: 'ACT-TEST-001',
            applicationId: 'application-2',
            applicantRole: 'MEMBER',
            name: '김확정',
            status: 'CONFIRMED'
          }
        ]
      })
    };

    const result = await createAdminApplicationsHandler(
      client,
      'club-applications-dev'
    )(event({ status: 'REPLACEMENT_NEEDED' }));
    const body = JSON.parse(result.body);

    assert.equal(body.count, 1);
    assert.equal(body.applications[0].status, 'REPLACEMENT_NEEDED');
  });

  it('잘못된 조회 조건은 DynamoDB 호출 전에 거부한다', async () => {
    const client = {
      send: async () => {
        throw new Error('호출되면 안 됩니다');
      }
    };

    const result = await createAdminApplicationsHandler(
      client,
      'club-applications-dev'
    )(event({ limit: '1000' }));

    assert.equal(result.statusCode, 400);
  });

  it('DynamoDB 오류를 안전한 응답으로 바꾼다', async () => {
    const client = {
      send: async () => {
        throw new Error('database unavailable');
      }
    };

    const result = await createAdminApplicationsHandler(
      client,
      'club-applications-dev'
    )(event());

    assert.equal(result.statusCode, 500);
    assert.equal(JSON.parse(result.body).message, '신청자 목록을 불러오지 못했습니다.');
  });
});
