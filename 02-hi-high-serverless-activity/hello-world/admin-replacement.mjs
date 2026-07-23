import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  },
  body: JSON.stringify(body)
});

const normalizeName = (name) => name.normalize('NFKC').trim().replace(/\s+/g, ' ');

const parseBody = (event) => {
  let body;
  try {
    const rawBody = event?.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event?.body;
    body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    return { error: '요청 본문은 올바른 JSON 형식이어야 합니다.' };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '대타 정보를 입력해 주세요.' };
  }

  const value = {
    activityId: String(body.activityId || '').trim().toUpperCase(),
    originalApplicationId: String(body.originalApplicationId || '').trim(),
    applicantRole: String(body.applicantRole || '').trim().toUpperCase(),
    originalName: normalizeName(String(body.originalName || '')),
    replacementName: normalizeName(String(body.replacementName || '')),
    password: String(body.password || '')
  };

  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(value.activityId)) return { error: '올바른 활동 ID가 아닙니다.' };
  if (!value.originalApplicationId) return { error: '원래 신청 정보를 확인할 수 없습니다.' };
  if (!['MEMBER', 'REPORTER'].includes(value.applicantRole)) return { error: '올바른 신청 구분이 아닙니다.' };
  if (value.originalName.length < 2 || value.originalName.length > 30) return { error: '원래 신청자 이름을 확인할 수 없습니다.' };
  if (value.replacementName.length < 2 || value.replacementName.length > 30) return { error: '대타 이름은 2자 이상 30자 이하로 입력해 주세요.' };
  if (!/^\d{4}$/.test(value.password)) return { error: '대타 취소 비밀번호는 숫자 4자리로 입력해 주세요.' };

  const originalNormalizedName = value.originalName.toLocaleLowerCase('ko-KR');
  const replacementNormalizedName = value.replacementName.toLocaleLowerCase('ko-KR');
  if (originalNormalizedName === replacementNormalizedName) return { error: '원래 신청자와 다른 대타 이름을 입력해 주세요.' };

  return { value: { ...value, originalNormalizedName, replacementNormalizedName } };
};

export const createAdminReplacementHandler = (
  documentClient = dynamo,
  activitiesTable = process.env.ACTIVITIES_TABLE,
  applicationsTable = process.env.APPLICATIONS_TABLE,
  now = () => new Date(),
  uuid = randomUUID,
  saltFactory = () => randomBytes(16).toString('hex')
) => async (event) => {
  if (!activitiesTable || !applicationsTable) {
    console.error('Required table environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseBody(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });

  const value = parsed.value;
  const resolvedAt = now().toISOString();
  const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';
  const replacementApplicationId = uuid();
  const salt = saltFactory();
  const originalApplicantKey = `${value.applicantRole}#${value.originalNormalizedName}`;
  const replacementApplicantKey = `${value.applicantRole}#${value.replacementNormalizedName}`;
  const countField = value.applicantRole === 'MEMBER' ? 'confirmedCount' : 'reporterCount';
  const capacityField = value.applicantRole === 'MEMBER' ? 'memberCapacity' : 'reporterCapacity';

  const replacement = {
    activityId: value.activityId,
    applicantKey: replacementApplicantKey,
    applicationId: replacementApplicationId,
    applicantRole: value.applicantRole,
    name: value.replacementName,
    normalizedName: value.replacementNormalizedName,
    passwordSalt: salt,
    passwordHash: scryptSync(value.password, salt, 64).toString('hex'),
    status: 'CONFIRMED',
    createdAt: resolvedAt,
    assignedAsReplacementAt: resolvedAt,
    replacedApplicationId: value.originalApplicationId,
    createdByAdmin: adminEmail
  };

  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: applicationsTable,
            Key: { activityId: value.activityId, applicantKey: originalApplicantKey },
            UpdateExpression: 'SET #status = :cancelled, replacementResolvedAt = :resolvedAt, replacedByApplicationId = :replacementApplicationId, replacementName = :replacementName, resolvedByAdmin = :adminEmail',
            ConditionExpression: 'applicationId = :originalApplicationId AND #status = :replacementNeeded',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':cancelled': 'CANCELLED',
              ':resolvedAt': resolvedAt,
              ':replacementApplicationId': replacementApplicationId,
              ':replacementName': value.replacementName,
              ':adminEmail': adminEmail,
              ':originalApplicationId': value.originalApplicationId,
              ':replacementNeeded': 'REPLACEMENT_NEEDED'
            }
          }
        },
        {
          Put: {
            TableName: applicationsTable,
            Item: replacement,
            ConditionExpression: 'attribute_not_exists(activityId) OR #status IN (:cancelled, :replacementNeeded)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':cancelled': 'CANCELLED',
              ':replacementNeeded': 'REPLACEMENT_NEEDED'
            }
          }
        },
        {
          Update: {
            TableName: activitiesTable,
            Key: { activityId: value.activityId },
            UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one',
            ConditionExpression: 'attribute_exists(activityId) AND attribute_exists(#capacity) AND (attribute_not_exists(#count) OR #count < #capacity)',
            ExpressionAttributeNames: { '#count': countField, '#capacity': capacityField },
            ExpressionAttributeValues: { ':zero': 0, ':one': 1 }
          }
        }
      ]
    }));

    console.info('Admin replacement assigned', {
      adminEmail,
      activityId: value.activityId,
      originalApplicationId: value.originalApplicationId,
      replacementApplicationId
    });
    return jsonResponse(201, {
      message: '대타가 확정되었고 활동 명단을 교체했습니다.',
      application: {
        activityId: replacement.activityId,
        applicationId: replacement.applicationId,
        applicantRole: replacement.applicantRole,
        name: replacement.name,
        status: replacement.status,
        createdAt: replacement.createdAt,
        assignedAsReplacementAt: replacement.assignedAsReplacementAt,
        replacedApplicationId: replacement.replacedApplicationId
      }
    });
  } catch (error) {
    if (error?.name === 'TransactionCanceledException') {
      return jsonResponse(409, {
        message: '대타 필요 상태가 이미 변경되었거나 정원이 가득 찼거나 같은 이름의 신청자가 있습니다. 목록을 새로고침해 주세요.'
      });
    }
    console.error('Failed to assign admin replacement', { name: error.name, message: error.message });
    return jsonResponse(500, { message: '대타 확정 중 오류가 발생했습니다.' });
  }
};

export const lambdaHandler = createAdminReplacementHandler();
