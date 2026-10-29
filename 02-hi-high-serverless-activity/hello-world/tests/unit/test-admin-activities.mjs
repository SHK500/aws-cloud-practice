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
  () => 'ABC123',
  'club-applications-dev'
);

describe('admin activities API', () => {
  it('returns public and private activities to an authenticated admin', async () => {
    const client = {
      send: async () => ({
        Items: [
          {
            activityId: 'ACT-2',
            ...validActivity,
            publicStatus: 'PRIVATE',
            createdAt: '2026-07-22T01:00:00.000Z'
          },
          {
            activityId: 'ACT-1',
            ...validActivity,
            activityDate: '2026-07-30',
            createdAt: '2026-07-21T01:00:00.000Z'
          }
        ]
      })
    };

    const result = await handlerWith(client)(event('GET'));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 200);
    assert.equal(body.count, 2);
    assert.equal(body.activities[0].activityId, 'ACT-2');
    assert.equal(body.activities[0].publicStatus, 'PRIVATE');
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

  it('allows an activity with zero reporter capacity', async () => {
    let command;
    const client = { send: async (value) => { command = value; return {}; } };

    const result = await handlerWith(client)(event('POST', {
      ...validActivity,
      reporterCapacity: 0
    }));
    const body = JSON.parse(result.body);

    assert.equal(result.statusCode, 201);
    assert.equal(command.input.Item.reporterCapacity, 0);
    assert.equal(body.activity.reporterCapacity, 0);
  });

  it('rejects invalid input before calling DynamoDB', async () => {
    const client = { send: async () => { throw new Error('must not be called'); } };
    const result = await handlerWith(client)(event('POST', {
      ...validActivity,
      memberCapacity: 0
    }));
    assert.equal(result.statusCode, 400);
  });

  it('updates metadata and preserves counters when there is no waitlist', async () => {
    const commands = [];
    const client = {
      send: async (value) => {
        commands.push(value);
        if (value.constructor.name === 'GetCommand') {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              ...validActivity,
              confirmedCount: 14,
              reporterCount: 0,
              memberWaitlistCount: 0
            }
          };
        }
        if (value.constructor.name === 'QueryCommand') return { Items: [] };
        return {};
      }
    };

    const result = await handlerWith(client)(event('PUT', {
      ...validActivity,
      memberCapacity: 20
    }, 'ACT-TEST-001'));
    const body = JSON.parse(result.body);
    const activityUpdate = commands[2].input.TransactItems[0].Update;

    assert.equal(result.statusCode, 200);
    assert.equal(body.promotedWaitlistedMembers, 0);
    assert.equal(
      activityUpdate.ExpressionAttributeValues[':updatedConfirmedCount'],
      14
    );
    assert.equal(
      activityUpdate.ExpressionAttributeValues[':updatedWaitlistCount'],
      0
    );
  });

  it('returns conflict when capacity is below the current confirmed count', async () => {
    const client = {
      send: async () => ({
        Item: {
          activityId: 'ACT-TEST-001',
          ...validActivity,
          confirmedCount: 21,
          reporterCount: 0,
          memberWaitlistCount: 0
        }
      })
    };

    const result = await handlerWith(client)(event('PUT', validActivity, 'ACT-TEST-001'));
    assert.equal(result.statusCode, 409);
  });

  it('promotes the earliest waitlisted members when capacity increases', async () => {
    const commands = [];
    const client = {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              activityId: 'ACT-TEST-001',
              ...validActivity,
              memberCapacity: 14,
              confirmedCount: 14,
              reporterCount: 0,
              memberWaitlistCount: 3
            }
          };
        }
        if (command.constructor.name === 'QueryCommand') {
          return {
            Items: [
              {
                activityId: 'ACT-TEST-001',
                applicantKey: 'MEMBER#third',
                applicationId: 'application-3',
                createdAt: '2026-07-22T00:03:00.000Z'
              },
              {
                activityId: 'ACT-TEST-001',
                applicantKey: 'MEMBER#first',
                applicationId: 'application-1',
                createdAt: '2026-07-22T00:01:00.000Z'
              },
              {
                activityId: 'ACT-TEST-001',
                applicantKey: 'MEMBER#second',
                applicationId: 'application-2',
                createdAt: '2026-07-22T00:02:00.000Z'
              }
            ]
          };
        }
        return {};
      }
    };

    const result = await handlerWith(client)(event('PUT', {
      ...validActivity,
      memberCapacity: 16
    }, 'ACT-TEST-001'));
    const body = JSON.parse(result.body);
    const transaction = commands[2].input.TransactItems;

    assert.equal(result.statusCode, 200);
    assert.equal(body.promotedWaitlistedMembers, 2);
    assert.equal(body.activity.confirmedCount, 16);
    assert.equal(body.activity.memberWaitlistCount, 1);
    assert.equal(transaction.length, 3);
    assert.equal(transaction[1].Update.Key.applicantKey, 'MEMBER#first');
    assert.equal(transaction[2].Update.Key.applicantKey, 'MEMBER#second');
    assert.equal(
      transaction[0].Update.ExpressionAttributeValues[':updatedConfirmedCount'],
      16
    );
    assert.equal(
      transaction[0].Update.ExpressionAttributeValues[':updatedWaitlistCount'],
      1
    );
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
