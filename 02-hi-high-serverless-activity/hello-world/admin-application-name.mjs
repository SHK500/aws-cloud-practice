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

const normalizeName = (name) => name
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ');

const parseRequest = (event) => {
  let body;

  try {
    const rawBody = event?.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event?.body;
    body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    return { error: '요청 본문은 올바른 JSON 형식이어야 합니다.' };
  }

  const activityId = typeof body?.activityId === 'string'
    ? body.activityId.trim().toUpperCase()
    : '';
  const applicantKey = typeof body?.applicantKey === 'string'
    ? body.applicantKey.trim()
    : '';
  const applicationId = typeof body?.applicationId === 'string'
    ? body.applicationId.trim()
    : '';
  const name = typeof body?.name === 'string' ? normalizeName(body.name) : '';

  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return { error: '올바른 활동 ID를 입력해 주세요.' };
  }
  if (!applicantKey || applicantKey.length > 200 || !applicationId) {
    return { error: '수정할 신청 정보가 올바르지 않습니다.' };
  }
  if (name.length < 2 || name.length > 30) {
    return { error: '이름은 2자 이상 30자 이하로 입력해 주세요.' };
  }

  return {
    value: {
      activityId,
      applicantKey,
      applicationId,
      name,
      normalizedName: name.toLocaleLowerCase('ko-KR')
    }
  };
};

export const createAdminApplicationNameHandler = (
  documentClient = dynamo,
  applicationsTable = process.env.APPLICATIONS_TABLE,
  now = () => new Date()
) => async (event) => {
  if (!applicationsTable) {
    console.error('APPLICATIONS_TABLE environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseRequest(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });

  const { activityId, applicantKey, applicationId, name, normalizedName } = parsed.value;
  const updatedAt = now().toISOString();

  try {
    const result = await documentClient.send(new UpdateCommand({
      TableName: applicationsTable,
      Key: { activityId, applicantKey },
      UpdateExpression: 'SET #name = :name, normalizedName = :normalizedName, nameUpdatedAt = :updatedAt',
      ConditionExpression: 'applicationId = :applicationId',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':name': name,
        ':normalizedName': normalizedName,
        ':updatedAt': updatedAt,
        ':applicationId': applicationId
      },
      ReturnValues: 'ALL_NEW'
    }));

    const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';
    console.info('Admin application name updated', {
      adminEmail,
      activityId,
      applicationId,
      name
    });

    return jsonResponse(200, {
      message: '신청자 이름을 수정했습니다.',
      application: {
        activityId: result.Attributes.activityId,
        applicantKey: result.Attributes.applicantKey,
        applicationId: result.Attributes.applicationId,
        applicantRole: result.Attributes.applicantRole,
        name: result.Attributes.name,
        status: result.Attributes.status,
        createdAt: result.Attributes.createdAt
      }
    });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return jsonResponse(409, {
        message: '신청 정보가 이미 변경되었거나 존재하지 않습니다. 목록을 새로고침해 주세요.'
      });
    }

    console.error('Failed to update admin application name', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '신청자 이름을 수정하지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminApplicationNameHandler();
