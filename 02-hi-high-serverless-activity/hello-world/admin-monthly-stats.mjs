import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand
} from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  },
  body: JSON.stringify(body)
});

const parseQuery = (event) => {
  const query = event?.queryStringParameters || {};
  const month = String(query.month || '').trim();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return { error: '조회 월은 YYYY-MM 형식이어야 합니다.' };
  }

  return { value: { month } };
};

const scanAll = async (documentClient, input) => {
  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await documentClient.send(new ScanCommand({
      ...input,
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
};

const normalizeName = (application) => String(
  application.normalizedName || application.name || ''
).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');

const buildLeaderboard = (applications, activityById) => {
  const people = new Map();

  for (const application of applications) {
    if (application.status !== 'CONFIRMED'
      || application.attendanceStatus === 'ABSENT'
      || !activityById.has(application.activityId)) {
      continue;
    }

    const identity = normalizeName(application);
    if (!identity) continue;

    if (!people.has(identity)) {
      people.set(identity, {
        name: application.name,
        activities: new Set(),
        latestActivityDate: ''
      });
    }

    const person = people.get(identity);
    const activity = activityById.get(application.activityId);
    person.activities.add(application.activityId);
    if (String(activity.activityDate) >= person.latestActivityDate) {
      person.latestActivityDate = String(activity.activityDate);
      person.name = application.name;
    }
  }

  const participants = [...people.values()]
    .map((person) => ({
      name: person.name,
      count: person.activities.size
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko-KR'));

  let previousCount = null;
  let previousRank = 0;
  return participants.map((participant, index) => {
    if (participant.count !== previousCount) previousRank = index + 1;
    previousCount = participant.count;
    return { rank: previousRank, ...participant };
  });
};

export const createAdminMonthlyStatsHandler = (
  documentClient = dynamo,
  activitiesTable = process.env.ACTIVITIES_TABLE,
  applicationsTable = process.env.APPLICATIONS_TABLE,
  now = () => new Date()
) => async (event) => {
  if (!activitiesTable || !applicationsTable) {
    console.error('Required table environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseQuery(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });
  const { month } = parsed.value;

  try {
    const [activities, applications] = await Promise.all([
      scanAll(documentClient, {
        TableName: activitiesTable,
        ProjectionExpression: 'activityId, #name, activityDate, startTime, activityStatus',
        ExpressionAttributeNames: { '#name': 'name' }
      }),
      scanAll(documentClient, {
        TableName: applicationsTable,
        ProjectionExpression: 'activityId, applicationId, applicantRole, #name, normalizedName, #status, attendanceStatus',
        ExpressionAttributeNames: { '#name': 'name', '#status': 'status' }
      })
    ]);

    const nowTimestamp = now().getTime();
    const monthlyActivities = activities.filter((activity) => {
      const activityDate = String(activity.activityDate || '');
      const startTime = String(activity.startTime || '23:59').slice(0, 5);
      const startTimestamp = Date.parse(`${activityDate}T${startTime}:00+09:00`);
      return activityDate.startsWith(`${month}-`)
        && activity.activityStatus !== 'CANCELLED'
        && Number.isFinite(startTimestamp)
        && startTimestamp <= nowTimestamp;
    });
    const activityById = new Map(monthlyActivities.map((activity) => [activity.activityId, activity]));
    const relevantConfirmed = applications.filter((application) =>
      activityById.has(application.activityId)
      && application.status === 'CONFIRMED'
    );
    const leaderboard = buildLeaderboard(applications, activityById);
    const attendedCount = relevantConfirmed.filter((item) => item.attendanceStatus !== 'ABSENT').length;
    const absentCount = relevantConfirmed.filter((item) => item.attendanceStatus === 'ABSENT').length;

    console.info('Admin monthly stats viewed', {
      adminEmail: event?.requestContext?.authorizer?.claims?.email || 'unknown',
      month,
      participantCount: leaderboard.length
    });

    return jsonResponse(200, {
      month,
      activityCount: monthlyActivities.length,
      confirmedCount: relevantConfirmed.length,
      attendedCount,
      absentCount,
      mvp: leaderboard.filter((participant) => participant.rank === 1),
      leaderboard
    });
  } catch (error) {
    console.error('Failed to load admin monthly stats', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '월간 활동 통계를 불러오지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminMonthlyStatsHandler();
