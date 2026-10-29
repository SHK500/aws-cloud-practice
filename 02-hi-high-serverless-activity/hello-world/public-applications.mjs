import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  },
  body: JSON.stringify(body)
});

const allowedRoles = new Set(['MEMBER', 'REPORTER']);

export const createPublicApplicationsHandler = (
  documentClient = dynamo,
  activitiesTable = process.env.ACTIVITIES_TABLE,
  applicationsTable = process.env.APPLICATIONS_TABLE
) => async (event = {}) => {
  if (!activitiesTable || !applicationsTable) {
    console.error('Required DynamoDB table environment variables are missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const activityId = String(event.pathParameters?.activityId || '').trim();
  const applicantRole = String(
    event.queryStringParameters?.applicantRole || 'MEMBER'
  ).trim().toUpperCase();

  if (!activityId) {
    return jsonResponse(400, { message: '활동 ID가 필요합니다.' });
  }
  if (!allowedRoles.has(applicantRole)) {
    return jsonResponse(400, { message: '올바른 신청 구분이 아닙니다.' });
  }

  try {
    const activityResult = await documentClient.send(new GetCommand({
      TableName: activitiesTable,
      Key: { activityId },
      ProjectionExpression: 'activityId, #name, publicStatus, activityStatus',
      ExpressionAttributeNames: { '#name': 'name' }
    }));

    const activity = activityResult.Item;
    if (!activity || activity.publicStatus !== 'PUBLIC' || activity.activityStatus === 'CANCELLED') {
      return jsonResponse(404, { message: '공개된 활동을 찾을 수 없습니다.' });
    }

    const applications = [];
    let lastEvaluatedKey;

    do {
      const result = await documentClient.send(new QueryCommand({
        TableName: applicationsTable,
        KeyConditionExpression: 'activityId = :activityId',
        FilterExpression: 'applicantRole = :applicantRole AND (#status = :confirmed OR #status = :waitlisted)',
        ProjectionExpression: 'applicantRole, #name, #status, createdAt',
        ExpressionAttributeNames: {
          '#name': 'name',
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':activityId': activityId,
          ':applicantRole': applicantRole,
          ':confirmed': 'CONFIRMED',
          ':waitlisted': 'WAITLISTED'
        },
        ExclusiveStartKey: lastEvaluatedKey
      }));

      applications.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const byApplicationTime = (a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.name || '').localeCompare(String(b.name || ''), 'ko');

    const confirmed = applications
      .filter((application) => application.status === 'CONFIRMED')
      .sort(byApplicationTime)
      .map((application) => ({ name: application.name }));

    const waitlisted = applications
      .filter((application) => application.status === 'WAITLISTED')
      .sort(byApplicationTime)
      .map((application) => ({ name: application.name }));

    return jsonResponse(200, {
      activityId,
      activityName: activity.name,
      applicantRole,
      confirmed,
      waitlisted
    });
  } catch (error) {
    console.error('Failed to load public applications', {
      name: error.name,
      message: error.message,
      activityId
    });
    return jsonResponse(500, { message: '신청 현황을 불러오지 못했습니다.' });
  }
};

export const lambdaHandler = createPublicApplicationsHandler();
