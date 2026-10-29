import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPublicApplicationsHandler } from '../../public-applications.mjs';

const request = ({
  activityId = 'ACT-TEST-001',
  applicantRole = 'MEMBER'
} = {}) => ({
  pathParameters: { activityId },
  queryStringParameters: { applicantRole }
});

describe('GET /activities/{activityId}/applications', () => {
  it('공개 활동의 확정자와 대기자를 신청 순서대로 반환한다', async () => {
    const client = {
      send: async (command) => {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              name: '환경정화 봉사',
              publicStatus: 'PUBLIC'
            }
          };
        }
        return {
          Items: [
            {
              applicantRole: 'MEMBER',
              name: '김대기',
              status: 'WAITLISTED',
              createdAt: '2026-07-25T13:00:02.000Z'
            },
            {
              applicantRole: 'MEMBER',
              name: '이확정',
              status: 'CONFIRMED',
              createdAt: '2026-07-25T13:00:01.000Z'
            },
            {
              applicantRole: 'MEMBER',
              name: '박취소',
              status: 'CANCELLED',
              createdAt: '2026-07-25T13:00:00.000Z'
            }
          ]
        };
      }
    };

    const result = await createPublicApplicationsHandler(
      client,
      'club-activities-dev',
      'club-applications-dev'
    )(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(body.confirmed, [{ name: '이확정' }]);
    assert.deepEqual(body.waitlisted, [{ name: '김대기' }]);
    assert.equal(JSON.stringify(body).includes('password'), false);
    assert.equal(JSON.stringify(body).includes('createdAt'), false);
  });

  it('비공개 활동의 명단은 반환하지 않는다', async () => {
    let queryCalled = false;
    const client = {
      send: async (command) => {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              name: '비공개 활동',
              publicStatus: 'PRIVATE'
            }
          };
        }
        queryCalled = true;
        return { Items: [] };
      }
    };

    const result = await createPublicApplicationsHandler(
      client,
      'club-activities-dev',
      'club-applications-dev'
    )(request());

    assert.equal(result.statusCode, 404);
    assert.equal(queryCalled, false);
  });

  it('취소된 활동의 명단은 반환하지 않는다', async () => {
    let queryCalled = false;
    const client = {
      send: async (command) => {
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              name: '취소된 활동',
              publicStatus: 'PUBLIC',
              activityStatus: 'CANCELLED'
            }
          };
        }
        queryCalled = true;
        return { Items: [] };
      }
    };

    const result = await createPublicApplicationsHandler(
      client,
      'club-activities-dev',
      'club-applications-dev'
    )(request());

    assert.equal(result.statusCode, 404);
    assert.equal(queryCalled, false);
  });

  it('잘못된 신청 구분은 DynamoDB 호출 전에 거부한다', async () => {
    const client = {
      send: async () => {
        throw new Error('호출되면 안 됩니다');
      }
    };

    const result = await createPublicApplicationsHandler(
      client,
      'club-activities-dev',
      'club-applications-dev'
    )(request({ applicantRole: 'INVALID' }));

    assert.equal(result.statusCode, 400);
  });

  it('DynamoDB 오류를 안전한 응답으로 바꾼다', async () => {
    const client = {
      send: async () => {
        throw new Error('database unavailable');
      }
    };

    const result = await createPublicApplicationsHandler(
      client,
      'club-activities-dev',
      'club-applications-dev'
    )(request());

    assert.equal(result.statusCode, 500);
    assert.equal(JSON.parse(result.body).message, '신청 현황을 불러오지 못했습니다.');
  });
});
