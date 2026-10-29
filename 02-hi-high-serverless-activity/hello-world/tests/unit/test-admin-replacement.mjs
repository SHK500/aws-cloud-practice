import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scryptSync } from 'node:crypto';
import { createAdminReplacementHandler } from '../../admin-replacement.mjs';

const request = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    originalApplicationId: 'application-original',
    applicantRole: 'MEMBER',
    originalName: '김성현',
    replacementName: '김대타',
    password: '5678',
    ...overrides
  }),
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
});

const original = (role = 'MEMBER') => ({
  activityId: 'ACT-TEST-001',
  applicantKey: `${role}#김성현`,
  applicationId: 'application-original',
  applicantRole: role,
  normalizedName: '김성현',
  status: 'REPLACEMENT_NEEDED'
});

const handlerWith = (client) => createAdminReplacementHandler(
  client,
  'club-activities-dev',
  'club-applications-dev',
  () => new Date('2026-07-22T12:00:00.000Z'),
  () => 'replacement-uuid',
  () => 'fixed-salt'
);

describe('POST /admin/applications/replacement', () => {
  it('공석에 대타를 원자적으로 배정하고 확정 인원을 늘린다', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'QueryCommand') return { Items: [original()] };
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);
    const items = commands[1].input.TransactItems;

    assert.equal(result.statusCode, 201);
    assert.equal(body.application.name, '김대타');
    assert.equal(items.length, 3);
    assert.equal(items[0].Update.Key.applicantKey, 'MEMBER#김성현');
    assert.match(items[1].Put.Item.applicantKey, /^MEMBER#김대타#[a-f0-9]{32}$/);
    assert.equal(items[1].Put.Item.status, 'CONFIRMED');
    assert.equal(items[1].Put.Item.createdByAdmin, 'admin@example.com');
    assert.equal(items[1].Put.Item.passwordHash, scryptSync('5678', 'fixed-salt', 64).toString('hex'));
    assert.equal(items[2].Update.ExpressionAttributeNames['#count'], 'confirmedCount');
  });

  it('기자단 대타는 기자단 확정 인원을 늘린다', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'QueryCommand') return { Items: [original('REPORTER')] };
        return {};
      }
    };

    const result = await handlerWith(client)(request({ applicantRole: 'REPORTER' }));
    assert.equal(result.statusCode, 201);
    assert.equal(commands[1].input.TransactItems[2].Update.ExpressionAttributeNames['#count'], 'reporterCount');
  });

  it('잘못된 취소 비밀번호는 DynamoDB 호출 전에 거부한다', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(request({ password: '12' }));
    assert.equal(result.statusCode, 400);
  });

  it('원래 신청자를 대타로 지정하지 못하게 한다', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(request({ replacementName: ' 김성현 ' }));
    assert.equal(result.statusCode, 400);
  });

  it('대타 필요 상태가 동시에 변경되면 충돌을 반환한다', async () => {
    const error = new Error('transaction cancelled');
    error.name = 'TransactionCanceledException';
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls === 1) return { Items: [original()] };
        throw error;
      }
    };

    const result = await handlerWith(client)(request());
    assert.equal(result.statusCode, 409);
  });
});
