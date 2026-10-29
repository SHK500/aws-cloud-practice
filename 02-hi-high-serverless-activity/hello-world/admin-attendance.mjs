import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const allowedAttendanceStatuses = new Set(['ATTENDED', 'ABSENT']);

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  },
  body: JSON.stringify(body)
});

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
  const attendanceStatus = typeof body?.attendanceStatus === 'string'
    ? body.attendanceStatus.trim().toUpperCase()
    : '';

  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return { error: '올바른 활동 ID를 입력해 주세요.' };
  }
  if (!applicantKey || applicantKey.length > 200 || !applicationId) {
    return { error: '출석 처리할 신청 정보가 올바르지 않습니다.' };
  }
  if (!allowedAttendanceStatuses.has(attendanceStatus)) {
    return { error: '출석 상태는 참여 또는 불참이어야 합니다.' };
  }

  return { value: { activityId, applicantKey, applicationId, attendanceStatus } };
};

export const createAdminAttendanceHandler = (
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

  const { activityId, applicantKey, applicationId, attendanceStatus } = parsed.value;
  const updatedAt = now().toISOString();
  const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';

  try {
    const result = await documentClient.send(new UpdateCommand({
      TableName: applicationsTable,
      Key: { activityId, applicantKey },
      UpdateExpression: 'SET attendanceStatus = :attendanceStatus, attendanceUpdatedAt = :updatedAt, attendanceUpdatedBy = :adminEmail',
      ConditionExpression: 'applicationId = :applicationId AND #status = :confirmed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':attendanceStatus': attendanceStatus,
        ':updatedAt': updatedAt,
        ':adminEmail': adminEmail,
        ':applicationId': applicationId,
        ':confirmed': 'CONFIRMED'
      },
      ReturnValues: 'ALL_NEW'
    }));

    console.info('Admin attendance updated', {
      adminEmail,
      activityId,
      applicationId,
      attendanceStatus
    });

    return jsonResponse(200, {
      message: attendanceStatus === 'ATTENDED'
        ? '참여로 기록했습니다.'
        : '불참으로 기록했습니다.',
      application: {
        activityId: result.Attributes.activityId,
        applicantKey: result.Attributes.applicantKey,
        applicationId: result.Attributes.applicationId,
        attendanceStatus: result.Attributes.attendanceStatus,
        attendanceUpdatedAt: result.Attributes.attendanceUpdatedAt
      }
    });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return jsonResponse(409, {
        message: '확정 상태인 신청자만 출석 처리할 수 있습니다. 목록을 새로고침해 주세요.'
      });
    }

    console.error('Failed to update admin attendance', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '출석 상태를 저장하지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminAttendanceHandler();
