import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '신청 정보를 입력해 주세요.' };
  }

  const activityId = typeof body.activityId === 'string'
    ? body.activityId.trim().toUpperCase()
    : '';
  const applicantRole = typeof body.applicantRole === 'string'
    ? body.applicantRole.trim().toUpperCase()
    : '';
  const name = typeof body.name === 'string' ? normalizeName(body.name) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return { error: '올바른 활동 ID를 입력해 주세요.' };
  }
  if (!['MEMBER', 'REPORTER'].includes(applicantRole)) {
    return { error: '신청 구분은 MEMBER 또는 REPORTER여야 합니다.' };
  }
  if (name.length < 2 || name.length > 30) {
    return { error: '이름은 2자 이상 30자 이하로 입력해 주세요.' };
  }
  if (!/^\d{4}$/.test(password)) {
    return { error: '신청 비밀번호는 숫자 4자리로 입력해 주세요.' };
  }

  return {
    value: {
      activityId,
      applicantRole,
      name,
      normalizedName: name.toLocaleLowerCase('ko-KR'),
      password
    }
  };
};

const roleFields = {
  MEMBER: {
    capacity: 'memberCapacity',
    confirmedCount: 'confirmedCount',
    waitlistCount: 'memberWaitlistCount',
    openAt: 'memberOpenAt',
    recruitmentStatus: 'memberRecruitmentStatus'
  },
  REPORTER: {
    capacity: 'reporterCapacity',
    confirmedCount: 'reporterCount',
    waitlistCount: 'reporterWaitlistCount',
    recruitmentStatus: 'reporterRecruitmentStatus'
  }
};

const cancellationReasons = (error) =>
  error?.CancellationReasons || error?.cancellationReasons || [];

const isDuplicateFailure = (error) =>
  error?.name === 'TransactionCanceledException'
  && cancellationReasons(error)[1]?.Code === 'ConditionalCheckFailed';

const isActivityConditionFailure = (error) =>
  error?.name === 'TransactionCanceledException'
  && cancellationReasons(error)[0]?.Code === 'ConditionalCheckFailed';

const transactionFor = ({
  activitiesTable,
  applicationsTable,
  application,
  fields,
  status,
  requestTimeKst
}) => {
  const isConfirmed = status === 'CONFIRMED';
  const countField = isConfirmed ? fields.confirmedCount : fields.waitlistCount;
  const capacityCondition = isConfirmed
    ? 'attribute_exists(activityId) AND #publicStatus = :publicStatus AND attribute_exists(#capacity) AND (attribute_not_exists(#confirmedCount) OR #confirmedCount < #capacity)'
    : 'attribute_exists(activityId) AND #publicStatus = :publicStatus AND attribute_exists(#capacity) AND ((attribute_not_exists(#confirmedCount) AND #capacity = :zero) OR #confirmedCount >= #capacity)';
  const recruitmentCondition = `${capacityCondition} AND (attribute_not_exists(#recruitmentStatus) OR #recruitmentStatus = :open)`;
  const activityCondition = fields.openAt
    ? `${recruitmentCondition} AND attribute_exists(#openAt) AND #openAt <= :requestTime`
    : recruitmentCondition;
  const expressionAttributeNames = {
    '#publicStatus': 'publicStatus',
    '#capacity': fields.capacity,
    '#confirmedCount': fields.confirmedCount,
    '#count': countField,
    '#recruitmentStatus': fields.recruitmentStatus
  };
  const expressionAttributeValues = {
    ':publicStatus': 'PUBLIC',
    ':open': 'OPEN',
    ':zero': 0,
    ':one': 1
  };

  if (fields.openAt) {
    expressionAttributeNames['#openAt'] = fields.openAt;
    expressionAttributeValues[':requestTime'] = requestTimeKst;
  }

  return new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: activitiesTable,
          Key: { activityId: application.activityId },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one',
          ConditionExpression: activityCondition,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues
        }
      },
      {
        Put: {
          TableName: applicationsTable,
          Item: { ...application, status },
          ConditionExpression: 'attribute_not_exists(activityId) OR #existingStatus IN (:cancelled, :replacementNeeded)',
          ExpressionAttributeNames: {
            '#existingStatus': 'status'
          },
          ExpressionAttributeValues: {
            ':cancelled': 'CANCELLED',
            ':replacementNeeded': 'REPLACEMENT_NEEDED'
          }
        }
      }
    ]
  });
};

const toKoreanIsoString = (date) => {
  const koreanTime = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return koreanTime.toISOString().replace('Z', '+09:00');
};

export const createApplicationHandler = (
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

  const parsed = parseRequest(event);
  if (parsed.error) {
    return jsonResponse(400, { message: parsed.error });
  }

  const {
    activityId,
    applicantRole,
    name,
    normalizedName,
    password
  } = parsed.value;
  const salt = saltFactory();
  const applicationId = uuid();
  const requestedAt = now();
  const application = {
    activityId,
    applicantKey: `${applicantRole}#${normalizedName}`,
    applicationId,
    applicantRole,
    name,
    normalizedName,
    passwordSalt: salt,
    passwordHash: scryptSync(password, salt, 64).toString('hex'),
    createdAt: requestedAt.toISOString()
  };
  const fields = roleFields[applicantRole];

  try {
    await documentClient.send(transactionFor({
      activitiesTable,
      applicationsTable,
      application,
      fields,
      status: 'CONFIRMED',
      requestTimeKst: toKoreanIsoString(requestedAt)
    }));

    console.info('Application accepted', {
      activityId,
      applicantRole,
      applicationId,
      status: 'CONFIRMED'
    });
    return jsonResponse(201, {
      message: '신청이 확정되었습니다.',
      applicationId,
      status: 'CONFIRMED'
    });
  } catch (error) {
    if (isDuplicateFailure(error)) {
      return jsonResponse(409, { message: '이미 신청한 활동입니다.' });
    }
    if (!isActivityConditionFailure(error)) {
      console.error('Failed to create confirmed application', {
        name: error.name,
        message: error.message
      });
      return jsonResponse(500, { message: '신청 처리 중 오류가 발생했습니다.' });
    }
    if (applicantRole === 'REPORTER') {
      return jsonResponse(409, {
        message: '기자단 모집이 완료되었거나 현재 신청할 수 없는 활동입니다.'
      });
    }
  }

  try {
    await documentClient.send(transactionFor({
      activitiesTable,
      applicationsTable,
      application,
      fields,
      status: 'WAITLISTED',
      requestTimeKst: toKoreanIsoString(requestedAt)
    }));

    console.info('Application accepted', {
      activityId,
      applicantRole,
      applicationId,
      status: 'WAITLISTED'
    });
    return jsonResponse(202, {
      message: '정원이 가득 차 대기자로 신청되었습니다.',
      applicationId,
      status: 'WAITLISTED'
    });
  } catch (error) {
    if (isDuplicateFailure(error)) {
      return jsonResponse(409, { message: '이미 신청한 활동입니다.' });
    }
    if (isActivityConditionFailure(error)) {
      return jsonResponse(409, {
        message: '신청할 수 없는 활동이거나 모집 상태가 변경되었습니다. 활동 목록을 새로고침해 주세요.'
      });
    }

    console.error('Failed to create waitlisted application', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '신청 처리 중 오류가 발생했습니다.' });
  }
};

export const lambdaHandler = createApplicationHandler();
