import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand
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

const parseRequest = (event) => {
  const activityId = String(event?.pathParameters?.activityId || '').trim().toUpperCase();
  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return { error: '올바른 활동 ID가 아닙니다.' };
  }

  try {
    const rawBody = event?.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event?.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    if (typeof body?.cancelled !== 'boolean') {
      return { error: '활동 취소 여부를 입력해 주세요.' };
    }
    return { value: { activityId, cancelled: body.cancelled } };
  } catch {
    return { error: '요청 본문은 올바른 JSON 형식이어야 합니다.' };
  }
};

export const createAdminActivityStatusHandler = (
  documentClient = dynamo,
  activitiesTable = process.env.ACTIVITIES_TABLE,
  now = () => new Date()
) => async (event) => {
  if (!activitiesTable) {
    console.error('ACTIVITIES_TABLE environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseRequest(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });
  const { activityId, cancelled } = parsed.value;
  const changedAt = now().toISOString();
  const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';

  try {
    const command = cancelled
      ? new UpdateCommand({
          TableName: activitiesTable,
          Key: { activityId },
          UpdateExpression: 'SET activityStatus = :cancelled, activityCancelledAt = :changedAt, activityCancelledBy = :adminEmail, updatedAt = :changedAt, updatedBy = :adminEmail',
          ConditionExpression: 'attribute_exists(activityId)',
          ExpressionAttributeValues: {
            ':cancelled': 'CANCELLED',
            ':changedAt': changedAt,
            ':adminEmail': adminEmail
          },
          ReturnValues: 'ALL_NEW'
        })
      : new UpdateCommand({
          TableName: activitiesTable,
          Key: { activityId },
          UpdateExpression: 'SET activityStatus = :active, updatedAt = :changedAt, updatedBy = :adminEmail REMOVE activityCancelledAt, activityCancelledBy',
          ConditionExpression: 'attribute_exists(activityId)',
          ExpressionAttributeValues: {
            ':active': 'ACTIVE',
            ':changedAt': changedAt,
            ':adminEmail': adminEmail
          },
          ReturnValues: 'ALL_NEW'
        });

    const result = await documentClient.send(command);
    console.info('Admin activity status updated', {
      adminEmail,
      activityId,
      activityStatus: cancelled ? 'CANCELLED' : 'ACTIVE'
    });

    return jsonResponse(200, {
      message: cancelled
        ? '활동을 취소했습니다. 공개 신청과 MVP 집계에서 제외됩니다.'
        : '활동 취소를 해제했습니다.',
      activity: result.Attributes
    });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return jsonResponse(404, { message: '활동을 찾을 수 없습니다.' });
    }
    console.error('Failed to update activity cancellation status', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '활동 상태를 변경하지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminActivityStatusHandler();
