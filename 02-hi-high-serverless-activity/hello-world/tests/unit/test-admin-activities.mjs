import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminActivitiesHandler } from '../../admin-activities.mjs';

const validActivity = {
  name: '환경정화 봉사',
  type: 'VOLUNTEER',
  activityDate: '2026-08-01',
  startTime: '10:00',
  place: '학교 정문',
  memberCapacity: 20,
  reporterCapacity: 2,
  memberOpenAt: '2026-07-25T20:00:00+09:00',
  publicStatus: 'PUBLIC',
  memberRecruitmentStatus: 'OPEN',
  reporterRecruitmentStatus: 'OPEN'
};

const event = (httpMethod, body, activityId) => ({
  httpMethod,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: activityId ? { activityId } : undefined,
  requestContext: { authorizer: { claims: { email: 'admin@example.com' } } }
});

const handlerWith = (client) => createAdminActivitiesHandler(
  client,
  'club-activities-dev',
  () => new Date('2026-07-22T01:00:00.000Z'),
  () => 'ABC123'
);

describe('admin activities API', () => {
  it('returns public and private activities to an authenticated admin', async () => {
    const client = {
      send: async () => ({
        Items: [
          { activityId: 'ACT-2', ...validActivity, publicStatus: 'PRIVATE' },
          { activityId: 'ACT-1', ...validActivity, activityDate: '2026-07-30' }
        ]
      })
    };

    const result = await handlerWith(client)(event('GET'));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.count, 2);
    assert.equal(body.activities[1].publicStatus, 'PRIVATE');
  });

  it('creates an activity with empty counters and audit metadata', async () => {
    let command;
    const client = { send: async (value) => { command = value; return {}; } };

    const result = await handlerWith(client)(event('POST', validActivity));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 201);
    assert.equal(body.activity.activityId, 'ACT-20260801-ABC123');
    assert.equal(command.input.Item.confirmedCount, 0);
    assert.equal(command.input.Item.createdBy, 'admin@example.com');
    assert.match(command.input.ConditionExpression, /attribute_not_exists/);
  });

  it('rejects invalid input before calling DynamoDB', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(event('POST', {
      ...validActivity,
      memberCapacity: 0
    }));
    assert.equal(result.statusCode, 400);
  });

  it('updates metadata without overwriting attendance counters', async () => {
    let command;
    const client = {
      send: async (value) => {
        command = value;
        return { Attributes: { activityId: 'ACT-TEST-001', ...validActivity } };
      }
    };

    const result = await handlerWith(client)(event('PUT', validActivity, 'ACT-TEST-001'));

    assert.equal(result.statusCode, 200);
    assert.doesNotMatch(command.input.UpdateExpression, /confirmedCount\s*=/);
    assert.match(command.input.ConditionExpression, /confirmedCount <= :memberCapacity/);
  });

  it('returns conflict when capacity is below the current confirmed count', async () => {
    const error = new Error('condition failed');
    error.name = 'ConditionalCheckFailedException';
    const client = { send: async () => { throw error; } };

    const result = await handlerWith(client)(event('PUT', validActivity, 'ACT-TEST-001'));
    assert.equal(result.statusCode, 409);
  });

  it('permanently deletes a private closed activity and its application records', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.input?.ConsistentRead) {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              ...validActivity,
              publicStatus: 'PRIVATE',
              memberRecruitmentStatus: 'CLOSED',
              reporterRecruitmentStatus: 'CLOSED'
            }
          };
        }
        if (command.input?.KeyConditionExpression) {
          return {
            Items: [
              { activityId: 'ACT-TEST-001', applicantKey: 'MEMBER#tester-one' },
              { activityId: 'ACT-TEST-001', applicantKey: 'REPORTER#tester-two' }
            ]
          };
        }
        return {};
      }
    };
    const handler = createAdminActivitiesHandler(
      client,
      'club-activities-dev',
      () => new Date('2026-07-22T01:00:00.000Z'),
      () => 'ABC123',
      'club-applications-dev'
    );

    const result = await handler(event('DELETE', {
      confirmationName: validActivity.name
    }, 'ACT-TEST-001'));
    const body = JSON.parse(result.body);
    const transaction = commands.at(-1).input.TransactItems;

    assert.equal(result.statusCode, 200);
    assert.equal(body.deletedApplicationCount, 2);
    assert.equal(transaction.length, 3);
    assert.equal(transaction[0].Delete.TableName, 'club-applications-dev');
    assert.equal(transaction[2].Delete.TableName, 'club-activities-dev');
  });

  it('refuses permanent deletion until the activity is private and closed', async () => {
    const client = {
      send: async (command) => {
        if (command.input?.ConsistentRead) return { Item: { activityId: 'ACT-TEST-001', ...validActivity } };
        throw new Error('must not continue');
      }
    };
    const handler = createAdminActivitiesHandler(
      client,
      'club-activities-dev',
      () => new Date(),
      () => 'ABC123',
      'club-applications-dev'
    );
    const result = await handler(event('DELETE', {
      confirmationName: validActivity.name
    }, 'ACT-TEST-001'));
    assert.equal(result.statusCode, 409);
  });

  it('refuses deletion when the confirmation name does not match', async () => {
    const client = {
      send: async () => ({
        Item: {
          activityId: 'ACT-TEST-001',
          ...validActivity,
          publicStatus: 'PRIVATE',
          memberRecruitmentStatus: 'CLOSED',
          reporterRecruitmentStatus: 'CLOSED'
        }
      })
    };
    const handler = createAdminActivitiesHandler(
      client,
      'club-activities-dev',
      () => new Date(),
      () => 'ABC123',
      'club-applications-dev'
    );
    const result = await handler(event('DELETE', {
      confirmationName: 'different activity'
    }, 'ACT-TEST-001'));
    assert.equal(result.statusCode, 400);
  });
});
