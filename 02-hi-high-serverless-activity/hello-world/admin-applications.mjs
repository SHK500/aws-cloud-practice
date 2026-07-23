import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
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

const allowedStatuses = new Set([
  'CONFIRMED',
  'WAITLISTED',
  'CANCELLED',
  'REPLACEMENT_NEEDED'
]);

const allowedRoles = new Set(['MEMBER', 'REPORTER']);

const decodeNextToken = (token) => {
  if (!token) return undefined;

  try {
    const key = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!key?.activityId || !key?.applicantKey) throw new Error('invalid key');
    return key;
  } catch {
    throw new Error('INVALID_NEXT_TOKEN');
  }
};

const encodeNextToken = (key) => key
  ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
  : null;

const parseQuery = (event) => {
  const query = event?.queryStringParameters || {};
  const activityId = String(query.activityId || '').trim().toUpperCase();
  const status = String(query.status || '').trim().toUpperCase();
  const applicantRole = String(query.applicantRole || '').trim().toUpperCase();
  const requestedLimit = Number.parseInt(query.limit || '50', 10);

  if (activityId && !/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return { error: '올바른 활동 ID를 입력해 주세요.' };
  }
  if (status && !allowedStatuses.has(status)) {
    return { error: '올바른 신청 상태를 입력해 주세요.' };
  }
  if (applicantRole && !allowedRoles.has(applicantRole)) {
    return { error: '신청 구분은 MEMBER 또는 REPORTER여야 합니다.' };
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return { error: 'limit은 1 이상 100 이하의 정수여야 합니다.' };
  }

  try {
    return {
      value: {
        activityId,
        status,
        applicantRole,
        limit: requestedLimit,
        exclusiveStartKey: decodeNextToken(query.nextToken)
      }
    };
  } catch {
    return { error: 'nextToken이 올바르지 않습니다.' };
  }
};

const publicAdminItem = (item) => ({
  activityId: item.activityId,
  applicationId: item.applicationId,
  applicantRole: item.applicantRole,
  name: item.name,
  status: item.status,
  createdAt: item.createdAt,
  cancelledAt: item.cancelledAt,
  promotedAt: item.promotedAt,
  replacementResolvedAt: item.replacementResolvedAt,
  replacedByApplicationId: item.replacedByApplicationId,
  assignedAsReplacementAt: item.assignedAsReplacementAt,
  replacedApplicationId: item.replacedApplicationId
});

export const createAdminApplicationsHandler = (
  documentClient = dynamo,
  applicationsTable = process.env.APPLICATIONS_TABLE
) => async (event) => {
  if (!applicationsTable) {
    console.error('APPLICATIONS_TABLE environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseQuery(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });

  const {
    activityId,
    status,
    applicantRole,
    limit,
    exclusiveStartKey
  } = parsed.value;

  const commonInput = {
    TableName: applicationsTable,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
    ProjectionExpression: 'activityId, applicantKey, applicationId, applicantRole, #name, #status, createdAt, cancelledAt, promotedAt, replacementResolvedAt, replacedByApplicationId, assignedAsReplacementAt, replacedApplicationId',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#status': 'status'
    }
  };

  const command = activityId
    ? new QueryCommand({
        ...commonInput,
        KeyConditionExpression: 'activityId = :activityId',
        ExpressionAttributeValues: { ':activityId': activityId }
      })
    : new ScanCommand(commonInput);

  try {
    const result = await documentClient.send(command);
    const applications = (result.Items || [])
      .filter((item) => !status || item.status === status)
      .filter((item) => !applicantRole || item.applicantRole === applicantRole)
      .map(publicAdminItem)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';
    console.info('Admin applications viewed', {
      adminEmail,
      activityId: activityId || 'ALL',
      status: status || 'ALL',
      returnedCount: applications.length
    });

    return jsonResponse(200, {
      count: applications.length,
      applications,
      nextToken: encodeNextToken(result.LastEvaluatedKey)
    });
  } catch (error) {
    console.error('Failed to load admin applications', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '신청자 목록을 불러오지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminApplicationsHandler();
