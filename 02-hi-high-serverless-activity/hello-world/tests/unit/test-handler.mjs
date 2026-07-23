import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { createHandler } from '../../app.mjs';

describe('GET /activities', function () {
  before(function () {
    process.env.ACTIVITIES_TABLE = 'club-activities-dev';
  });

  it('공개 활동 목록을 반환한다', async function () {
    const fakeClient = {
      send: async () => ({
        Items: [{
          activityId: 'ACT-TEST-001',
          name: 'Environment Cleanup',
          type: 'VOLUNTEER',
          activityDate: '2026-08-01',
          startTime: '10:00',
          publicStatus: 'PUBLIC',
          memberCapacity: 20,
          reporterCapacity: 2,
          confirmedCount: 0,
          reporterCount: 0
        }]
      })
    };

    const result = await createHandler(fakeClient)();
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.count, 1);
    assert.equal(body.activities[0].activityId, 'ACT-TEST-001');
  });

  it('DynamoDB 오류를 안전한 응답으로 바꾼다', async function () {
    const fakeClient = {
      send: async () => { throw new Error('database unavailable'); }
    };

    const result = await createHandler(fakeClient)();
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 500);
    assert.equal(body.message, '활동 목록을 불러오지 못했습니다.');
  });
});
