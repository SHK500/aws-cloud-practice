import { scryptSync, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
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
    return { error: '취소 정보를 입력해 주세요.' };
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
      normalizedName: name.toLocaleLowerCase('ko-KR'),
      password,
      confirmVacancy: body.confirmVacancy === true
    }
  };
};

const passwordMatches = (password, application) => {
  if (!application?.passwordSalt || !application?.passwordHash) return false;

  try {
    const expected = Buffer.from(application.passwordHash, 'hex');
    const actual = scryptSync(password, application.passwordSalt, expected.length);
    return expected.length > 0
      && expected.length === actual.length
      && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
};

const findEarliestWaitlistedMember = async (
  documentClient,
  applicationsTable,
  activityId
) => {
  const waiting = [];
  let lastEvaluatedKey;

  do {
    const result = await documentClient.send(new QueryCommand({
      TableName: applicationsTable,
      KeyConditionExpression: 'activityId = :activityId',
      FilterExpression: 'applicantRole = :member AND #status = :waitlisted',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':activityId': activityId,
        ':member': 'MEMBER',
        ':waitlisted': 'WAITLISTED'
      },
      ExclusiveStartKey: lastEvaluatedKey
    }));

    waiting.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return waiting.sort((a, b) => {
    const timeOrder = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return timeOrder || String(a.applicationId || '').localeCompare(String(b.applicationId || ''));
  })[0];
};

const activeApplicationCondition =
  'applicationId = :applicationId AND #status = :expectedStatus';

const applicationNames = { '#status': 'status' };

const cancelWaitlistedTransaction = ({
  activitiesTable,
  applicationsTable,
  application,
  cancelledAt
}) => new TransactWriteCommand({
  TransactItems: [
    {
      Update: {
        TableName: applicationsTable,
        Key: {
          activityId: application.activityId,
          applicantKey: application.applicantKey
        },
        UpdateExpression: 'SET #status = :cancelled, cancelledAt = :cancelledAt',
        ConditionExpression: activeApplicationCondition,
        ExpressionAttributeNames: applicationNames,
        ExpressionAttributeValues: {
          ':applicationId': application.applicationId,
          ':expectedStatus': 'WAITLISTED',
          ':cancelled': 'CANCELLED',
          ':cancelledAt': cancelledAt
        }
      }
    },
    {
      Update: {
        TableName: activitiesTable,
        Key: { activityId: application.activityId },
        UpdateExpression: 'SET memberWaitlistCount = memberWaitlistCount - :one',
        ConditionExpression: 'memberWaitlistCount >= :one',
        ExpressionAttributeValues: { ':one': 1 }
      }
    }
  ]
});

const cancelAndPromoteTransaction = ({
  activitiesTable,
  applicationsTable,
  application,
  replacement,
  cancelledAt
}) => new TransactWriteCommand({
  TransactItems: [
    {
      Update: {
        TableName: applicationsTable,
        Key: {
          activityId: application.activityId,
          applicantKey: application.applicantKey
        },
        UpdateExpression: 'SET #status = :cancelled, cancelledAt = :cancelledAt',
        ConditionExpression: activeApplicationCondition,
        ExpressionAttributeNames: applicationNames,
        ExpressionAttributeValues: {
          ':applicationId': application.applicationId,
          ':expectedStatus': 'CONFIRMED',
          ':cancelled': 'CANCELLED',
          ':cancelledAt': cancelledAt
        }
      }
    },
    {
      Update: {
        TableName: applicationsTable,
        Key: {
          activityId: replacement.activityId,
          applicantKey: replacement.applicantKey
        },
        UpdateExpression: 'SET #status = :confirmed, promotedAt = :promotedAt',
        ConditionExpression: activeApplicationCondition,
        ExpressionAttributeNames: applicationNames,
        ExpressionAttributeValues: {
          ':applicationId': replacement.applicationId,
          ':expectedStatus': 'WAITLISTED',
          ':confirmed': 'CONFIRMED',
          ':promotedAt': cancelledAt
        }
      }
    },
    {
      Update: {
        TableName: activitiesTable,
        Key: { activityId: application.activityId },
        UpdateExpression: 'SET memberWaitlistCount = memberWaitlistCount - :one',
        ConditionExpression: 'memberWaitlistCount >= :one AND confirmedCount >= :one',
        ExpressionAttributeValues: { ':one': 1 }
      }
    }
  ]
});

const cancelWithVacancyTransaction = ({
  activitiesTable,
  applicationsTable,
  application,
  cancelledAt
}) => {
  const isMember = application.applicantRole === 'MEMBER';
  const countField = isMember ? 'confirmedCount' : 'reporterCount';

  return new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: applicationsTable,
          Key: {
            activityId: application.activityId,
            applicantKey: application.applicantKey
          },
          UpdateExpression: 'SET #status = :replacementNeeded, cancelledAt = :cancelledAt',
          ConditionExpression: activeApplicationCondition,
          ExpressionAttributeNames: applicationNames,
          ExpressionAttributeValues: {
            ':applicationId': application.applicationId,
            ':expectedStatus': 'CONFIRMED',
            ':replacementNeeded': 'REPLACEMENT_NEEDED',
            ':cancelledAt': cancelledAt
          }
        }
      },
      {
        Update: {
          TableName: activitiesTable,
          Key: { activityId: application.activityId },
          UpdateExpression: 'SET #count = #count - :one',
          ConditionExpression: '#count >= :one',
          ExpressionAttributeNames: { '#count': countField },
          ExpressionAttributeValues: { ':one': 1 }
        }
      }
    ]
  });
};

export const createCancellationHandler = (
  documentClient = dynamo,
  activitiesTable = process.env.ACTIVITIES_TABLE,
  applicationsTable = process.env.APPLICATIONS_TABLE,
  now = () => new Date()
) => async (event) => {
  if (!activitiesTable || !applicationsTable) {
    console.error('Required table environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const parsed = parseRequest(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });

  const {
    activityId,
    applicantRole,
    normalizedName,
    password,
    confirmVacancy
  } = parsed.value;
  const applicantKey = `${applicantRole}#${normalizedName}`;

  let application;
  try {
    const result = await documentClient.send(new GetCommand({
      TableName: applicationsTable,
      Key: { activityId, applicantKey },
      ConsistentRead: true
    }));
    application = result.Item;
  } catch (error) {
    console.error('Failed to load application for cancellation', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '취소 내역을 확인하는 중 오류가 발생했습니다.' });
  }

  if (!application || !passwordMatches(password, application)) {
    return jsonResponse(404, {
      message: '이름과 신청 비밀번호가 일치하는 신청 내역을 찾을 수 없습니다.'
    });
  }

  if (['CANCELLED', 'REPLACEMENT_NEEDED'].includes(application.status)) {
    return jsonResponse(200, {
      message: application.status === 'REPLACEMENT_NEEDED'
        ? '이미 취소되었으며 임원진의 대타 모집이 필요한 상태입니다.'
        : '이미 취소된 신청입니다.',
      status: application.status,
      alreadyCancelled: true,
      replacementNeeded: application.status === 'REPLACEMENT_NEEDED'
    });
  }

  const cancelledAt = now().toISOString();

  try {
    if (application.status === 'WAITLISTED') {
      if (applicantRole !== 'MEMBER') {
        return jsonResponse(409, { message: '처리할 수 없는 신청 상태입니다.' });
      }

      await documentClient.send(cancelWaitlistedTransaction({
        activitiesTable,
        applicationsTable,
        application,
        cancelledAt
      }));
      return jsonResponse(200, {
        message: '대기 신청이 취소되었습니다.',
        status: 'CANCELLED',
        replacementNeeded: false,
        promotedWaitingApplicant: false
      });
    }

    if (application.status !== 'CONFIRMED') {
      return jsonResponse(409, { message: '처리할 수 없는 신청 상태입니다.' });
    }

    const replacement = applicantRole === 'MEMBER'
      ? await findEarliestWaitlistedMember(documentClient, applicationsTable, activityId)
      : undefined;

    if (replacement) {
      await documentClient.send(cancelAndPromoteTransaction({
        activitiesTable,
        applicationsTable,
        application,
        replacement,
        cancelledAt
      }));
      return jsonResponse(200, {
        message: '신청이 취소되었고 첫 번째 대기자가 자동으로 확정되었습니다.',
        status: 'CANCELLED',
        replacementNeeded: false,
        promotedWaitingApplicant: true
      });
    }

    if (!confirmVacancy) {
      return jsonResponse(200, {
        message: '현재 대기자가 없습니다. 취소하면 활동 인원에 공석이 발생하고 임원진에게 대타 모집 필요 상태로 표시됩니다. 정말 취소하시겠습니까?',
        confirmationRequired: true,
        replacementNeeded: true
      });
    }

    await documentClient.send(cancelWithVacancyTransaction({
      activitiesTable,
      applicationsTable,
      application,
      cancelledAt
    }));
    return jsonResponse(200, {
      message: '신청이 취소되었습니다. 현재 대기자가 없어 대타 모집이 필요합니다. 반드시 임원진에게 연락해 주세요.',
      status: 'REPLACEMENT_NEEDED',
      confirmationRequired: false,
      replacementNeeded: true,
      promotedWaitingApplicant: false
    });
  } catch (error) {
    if (error?.name === 'TransactionCanceledException') {
      return jsonResponse(409, {
        message: '다른 신청이 동시에 변경되었습니다. 활동 목록을 새로고침한 뒤 다시 시도해 주세요.'
      });
    }

    console.error('Failed to cancel application', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '신청 취소 중 오류가 발생했습니다.' });
  }
};

export const lambdaHandler = createCancellationHandler();
