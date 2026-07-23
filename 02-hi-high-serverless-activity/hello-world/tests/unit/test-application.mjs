import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApplicationHandler } from '../../application.mjs';

const request = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    applicantRole: 'MEMBER',
    name: '홍길동',
    password: '1234',
    ...overrides
  })
});

const transactionError = (firstCode, secondCode) => {
  const error = new Error('transaction cancelled');
  error.name = 'TransactionCanceledException';
  error.CancellationReasons = [
    { Code: firstCode },
    { Code: secondCode }
  ];
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
    const client = {
      send: async (command) => {
        commands.push(command);
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 201);
    assert.equal(body.status, 'CONFIRMED');
    assert.equal(commands.length, 1);
    const items = commands[0].input.TransactItems;
    assert.equal(items[0].Update.TableName, 'club-activities-dev');
    assert.equal(items[1].Put.TableName, 'club-applications-dev');
    assert.equal(items[1].Put.Item.status, 'CONFIRMED');
    assert.notEqual(items[1].Put.Item.passwordHash, '1234');
    assert.match(items[0].Update.ConditionExpression, /#openAt <= :requestTime/);
  });

  it('정원이 가득 차면 대기 신청으로 저장한다', async () => {
    let calls = 0;
    const client = {
      send: async (command) => {
        calls += 1;
        if (calls === 1) {
          throw transactionError('ConditionalCheckFailed', 'None');
        }
        assert.equal(command.input.TransactItems[1].Put.Item.status, 'WAITLISTED');
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 202);
    assert.equal(body.status, 'WAITLISTED');
    assert.equal(calls, 2);
  });

  it('같은 활동에 같은 이름과 신청 구분이 있으면 중복을 거부한다', async () => {
    const client = {
      send: async () => {
        throw transactionError('None', 'ConditionalCheckFailed');
      }
    };

    const result = await handlerWith(client)(request());

    assert.equal(result.statusCode, 409);
    assert.equal(JSON.parse(result.body).message, '이미 신청한 활동입니다.');
  });

  it('기자단 정원이 가득 차면 대기자로 받지 않고 거부한다', async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        throw transactionError('ConditionalCheckFailed', 'None');
      }
    };

    const result = await handlerWith(client)(request({ applicantRole: 'REPORTER' }));

    assert.equal(result.statusCode, 409);
    assert.equal(calls, 1);
    assert.match(JSON.parse(result.body).message, /기자단 모집/);
  });

  it('비밀번호가 숫자 4자리가 아니면 DynamoDB를 호출하지 않는다', async () => {
    const client = {
      send: async () => {
        throw new Error('호출되면 안 됩니다');
      }
    };

    const result = await handlerWith(client)(request({ password: '12ab' }));

    assert.equal(result.statusCode, 400);
  });
});
