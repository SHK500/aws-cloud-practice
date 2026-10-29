import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scryptSync } from 'node:crypto';
import { createApplicationHandler } from '../../application.mjs';

const request = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    applicantRole: 'MEMBER',
    name: '김성현',
    password: '1234',
    ...overrides
  })
});

const transactionError = (firstCode, secondCode) => {
  const error = new Error('transaction cancelled');
  error.name = 'TransactionCanceledException';
  error.CancellationReasons = [{ Code: firstCode }, { Code: secondCode }];
  return error;
};

const handlerWith = (client) => createApplicationHandler(
  client,
  'club-activities-dev',
  'club-applications-dev',
  () => new Date('2026-07-21T07:00:00.000Z'),
  () => 'application-uuid',
  () => 'fixed-salt'
);

describe('POST /applications', () => {
  it('정원이 남아 있으면 확정 신청을 원자적으로 저장한다', async () => {
    const commands = [];
    const client = { send: async (command) => { commands.push(command); return {}; } };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 201);
    assert.equal(body.status, 'CONFIRMED');
    assert.equal(commands.length, 2);
    assert.equal(commands[0].constructor.name, 'GetCommand');
    const items = commands[1].input.TransactItems;
    assert.equal(items[0].Update.TableName, 'club-activities-dev');
    assert.match(items[0].Update.ConditionExpression, /#activityStatus/);
    assert.equal(items[0].Update.ExpressionAttributeValues[':active'], 'ACTIVE');
    assert.equal(items[1].Put.TableName, 'club-applications-dev');
    assert.equal(items[1].Put.Item.status, 'CONFIRMED');
    assert.notEqual(items[1].Put.Item.passwordHash, '1234');
    assert.match(items[1].Put.Item.applicantKey, /^MEMBER#김성현#[a-f0-9]{32}$/);
  });

  it('정원이 가득 차면 대기 신청으로 저장한다', async () => {
    let calls = 0;
    const client = {
      send: async (command) => {
        calls += 1;
        if (calls === 1) return {};
        if (calls === 2) throw transactionError('ConditionalCheckFailed', 'None');
        assert.equal(command.input.TransactItems[1].Put.Item.status, 'WAITLISTED');
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    assert.equal(result.statusCode, 202);
    assert.equal(JSON.parse(result.body).status, 'WAITLISTED');
    assert.equal(calls, 3);
  });

  it('같은 이름과 같은 비밀번호는 중복으로 거부한다', async () => {
    const client = {
      send: async (command) => {
        if (command.constructor.name === 'GetCommand') return {};
        throw transactionError('None', 'ConditionalCheckFailed');
      }
    };

    const result = await handlerWith(client)(request());
    assert.equal(result.statusCode, 409);
    assert.equal(JSON.parse(result.body).message, '이미 신청한 활동입니다.');
  });

  it('기존 기록이 같은 이름이어도 비밀번호가 다르면 동명이인으로 신청한다', async () => {
    const legacySalt = 'legacy-salt';
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              status: 'CONFIRMED',
              passwordSalt: legacySalt,
              passwordHash: scryptSync('1541', legacySalt, 64).toString('hex')
            }
          };
        }
        return {};
      }
    };

    const result = await handlerWith(client)(request({ password: '1333' }));
    assert.equal(result.statusCode, 201);
    assert.equal(commands.length, 2);
  });

  it('기존 기록의 같은 이름과 같은 비밀번호는 중복으로 거부한다', async () => {
    const legacySalt = 'legacy-salt';
    const client = {
      send: async () => ({
        Item: {
          status: 'CONFIRMED',
          passwordSalt: legacySalt,
          passwordHash: scryptSync('1234', legacySalt, 64).toString('hex')
        }
      })
    };

    const result = await handlerWith(client)(request());
    assert.equal(result.statusCode, 409);
  });

  it('기자단 정원이 가득 차면 대기자로 받지 않는다', async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls === 1) return {};
        throw transactionError('ConditionalCheckFailed', 'None');
      }
    };

    const result = await handlerWith(client)(request({ applicantRole: 'REPORTER' }));
    assert.equal(result.statusCode, 409);
    assert.equal(calls, 2);
    assert.match(JSON.parse(result.body).message, /기자단 모집/);
  });

  it('비밀번호가 숫자 4자리가 아니면 DynamoDB를 호출하지 않는다', async () => {
    const client = { send: async () => { throw new Error('호출하면 안 됩니다'); } };
    const result = await handlerWith(client)(request({ password: '12ab' }));
    assert.equal(result.statusCode, 400);
  });
});
