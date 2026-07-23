import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scryptSync } from 'node:crypto';
import { createCancellationHandler } from '../../cancellation.mjs';

const salt = 'fixed-test-salt';
const passwordHash = scryptSync('1234', salt, 64).toString('hex');

const application = (overrides = {}) => ({
  activityId: 'ACT-TEST-001',
  applicantKey: 'MEMBER#홍길동',
  applicationId: 'application-1',
  applicantRole: 'MEMBER',
  name: '홍길동',
  normalizedName: '홍길동',
  passwordSalt: salt,
  passwordHash,
  createdAt: '2026-07-21T01:00:00.000Z',
  status: 'CONFIRMED',
  ...overrides
});

const request = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    applicantRole: 'MEMBER',
    name: '홍길동',
    password: '1234',
    ...overrides
  })
});

const handlerWith = (client) => createCancellationHandler(
  client,
  'club-activities-dev',
  'club-applications-dev',
  () => new Date('2026-07-21T08:00:00.000Z')
);

describe('POST /applications/cancel', () => {
  it('비밀번호가 틀리면 신청 존재 여부를 노출하지 않는다', async () => {
    const client = {
      send: async () => ({ Item: application() })
    };

    const result = await handlerWith(client)(request({ password: '9999' }));

    assert.equal(result.statusCode, 404);
    assert.match(JSON.parse(result.body).message, /찾을 수 없습니다/);
  });

  it('확정 일반 부원이 취소하면 가장 빠른 대기자를 승격한다', async () => {
    const waiting = application({
      applicantKey: 'MEMBER#김대기',
      applicationId: 'application-2',
      name: '김대기',
      normalizedName: '김대기',
      createdAt: '2026-07-21T02:00:00.000Z',
      status: 'WAITLISTED'
    });
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.input?.Key) return { Item: application() };
        if (command.input?.KeyConditionExpression) return { Items: [waiting] };
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);
    const transaction = commands[2].input.TransactItems;

    assert.equal(result.statusCode, 200);
    assert.equal(body.promotedWaitingApplicant, true);
    assert.equal(transaction.length, 3);
    assert.equal(
      transaction[1].Update.ExpressionAttributeValues[':confirmed'],
      'CONFIRMED'
    );
  });

  it('대기자가 없으면 실제 취소 전에 확인을 요구한다', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.input?.Key) return { Item: application() };
        if (command.input?.KeyConditionExpression) return { Items: [] };
        throw new Error('트랜잭션이 실행되면 안 됩니다');
      }
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.confirmationRequired, true);
    assert.equal(commands.length, 2);
  });

  it('공석 발생에 동의하면 대타 필요 상태로 취소한다', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.input?.Key) return { Item: application() };
        if (command.input?.KeyConditionExpression) return { Items: [] };
        return {};
      }
    };

    const result = await handlerWith(client)(request({ confirmVacancy: true }));
    const body = JSON.parse(result.body);
    const transaction = commands[2].input.TransactItems;

    assert.equal(result.statusCode, 200);
    assert.equal(body.status, 'REPLACEMENT_NEEDED');
    assert.equal(body.replacementNeeded, true);
    assert.match(body.message, /임원진에게 연락/);
    assert.equal(
      transaction[0].Update.ExpressionAttributeValues[':replacementNeeded'],
      'REPLACEMENT_NEEDED'
    );
  });

  it('대기 신청을 취소하면 대기 인원만 감소한다', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.input?.Key) {
          return { Item: application({ status: 'WAITLISTED' }) };
        }
        return {};
      }
    };

    const result = await handlerWith(client)(request());
    const transaction = commands[1].input.TransactItems;

    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).status, 'CANCELLED');
    assert.match(transaction[1].Update.UpdateExpression, /memberWaitlistCount/);
  });

  it('이미 취소된 요청은 안전하게 같은 결과를 돌려준다', async () => {
    const client = {
      send: async () => ({ Item: application({ status: 'CANCELLED' }) })
    };

    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.alreadyCancelled, true);
  });
});
