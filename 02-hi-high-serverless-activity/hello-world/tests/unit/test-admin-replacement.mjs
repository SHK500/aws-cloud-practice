import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scryptSync } from 'node:crypto';
import { createAdminReplacementHandler } from '../../admin-replacement.mjs';

const request = (overrides = {}) => ({
  body: JSON.stringify({
    activityId: 'ACT-TEST-001',
    originalApplicationId: 'application-original',
    applicantRole: 'MEMBER',
    originalName: '홍길동',
    replacementName: '김대타',
    password: '5678',
    ...overrides
  }),
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
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
  it('replaces the vacancy atomically and increments the confirmed count', async () => {
    let command;
    const client = { send: async (value) => { command = value; return {}; } };
    const result = await handlerWith(client)(request());
    const body = JSON.parse(result.body);
    const items = command.input.TransactItems;

    assert.equal(result.statusCode, 201);
    assert.equal(body.application.name, '김대타');
    assert.equal(items.length, 3);
    assert.equal(items[0].Update.Key.applicantKey, 'MEMBER#홍길동');
    assert.equal(items[1].Put.Item.applicantKey, 'MEMBER#김대타');
    assert.equal(items[1].Put.Item.status, 'CONFIRMED');
    assert.equal(items[1].Put.Item.createdByAdmin, 'admin@example.com');
    assert.equal(
      items[1].Put.Item.passwordHash,
      scryptSync('5678', 'fixed-salt', 64).toString('hex')
    );
    assert.match(items[2].Update.UpdateExpression, /#count/);
    assert.equal(items[2].Update.ExpressionAttributeNames['#count'], 'confirmedCount');
  });

  it('uses the reporter count for reporter replacements', async () => {
    let command;
    const client = { send: async (value) => { command = value; return {}; } };
    const result = await handlerWith(client)(request({ applicantRole: 'REPORTER' }));
    assert.equal(result.statusCode, 201);
    assert.equal(command.input.TransactItems[2].Update.ExpressionAttributeNames['#count'], 'reporterCount');
  });

  it('rejects an invalid cancellation password before DynamoDB is called', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(request({ password: '12' }));
    assert.equal(result.statusCode, 400);
  });

  it('rejects using the original applicant as the substitute', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(request({ replacementName: ' 홍길동 ' }));
    assert.equal(result.statusCode, 400);
  });

  it('returns conflict when the vacancy or application changed concurrently', async () => {
    const error = new Error('transaction cancelled');
    error.name = 'TransactionCanceledException';
    const client = { send: async () => { throw error; } };
    const result = await handlerWith(client)(request());
    assert.equal(result.statusCode, 409);
  });
});
