import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
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

const isRealDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const isTime = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match) && Number(match[1]) < 24 && Number(match[2]) < 60;
};

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
    return { error: '활동 정보를 입력해 주세요.' };
  }

  const value = {
    name: String(body.name || '').normalize('NFKC').trim().replace(/\s+/g, ' '),
    type: String(body.type || '').trim().toUpperCase(),
    activityDate: String(body.activityDate || '').trim(),
    startTime: String(body.startTime || '').trim(),
    place: String(body.place || '').normalize('NFKC').trim().replace(/\s+/g, ' '),
    memberCapacity: Number(body.memberCapacity),
    reporterCapacity: Number(body.reporterCapacity),
    memberOpenAt: String(body.memberOpenAt || '').trim(),
    publicStatus: String(body.publicStatus || '').trim().toUpperCase(),
    memberRecruitmentStatus: String(body.memberRecruitmentStatus || '').trim().toUpperCase(),
    reporterRecruitmentStatus: String(body.reporterRecruitmentStatus || '').trim().toUpperCase()
  };

  if (value.name.length < 2 || value.name.length > 80) {
    return { error: '활동명은 2자 이상 80자 이하로 입력해 주세요.' };
  }
  if (!['VOLUNTEER', 'BUCKET'].includes(value.type)) {
    return { error: '활동 유형은 봉사 또는 버킷이어야 합니다.' };
  }
  if (!isRealDate(value.activityDate)) {
    return { error: '올바른 활동 날짜를 입력해 주세요.' };
  }
  if (!isTime(value.startTime)) {
    return { error: '올바른 활동 시간을 입력해 주세요.' };
  }
  if (value.place.length < 1 || value.place.length > 100) {
    return { error: '장소는 1자 이상 100자 이하로 입력해 주세요.' };
  }
  if (!Number.isInteger(value.memberCapacity) || value.memberCapacity < 1 || value.memberCapacity > 500) {
    return { error: '일반 부원 정원은 1명 이상 500명 이하로 입력해 주세요.' };
  }
  if (!Number.isInteger(value.reporterCapacity) || value.reporterCapacity < 1 || value.reporterCapacity > 100) {
    return { error: '기자단 정원은 1명 이상 100명 이하로 입력해 주세요.' };
  }
  if (!value.memberOpenAt || Number.isNaN(Date.parse(value.memberOpenAt))) {
    return { error: '올바른 일반 신청 시작 시각을 입력해 주세요.' };
  }
  if (!['PUBLIC', 'PRIVATE'].includes(value.publicStatus)) {
    return { error: '공개 상태를 선택해 주세요.' };
  }
  if (!['OPEN', 'CLOSED'].includes(value.memberRecruitmentStatus)) {
    return { error: '일반 부원 모집 상태를 선택해 주세요.' };
  }
  if (!['OPEN', 'CLOSED'].includes(value.reporterRecruitmentStatus)) {
    return { error: '기자단 모집 상태를 선택해 주세요.' };
  }

  return { value };
};

const adminActivity = (activity) => ({
  activityId: activity.activityId,
  name: activity.name,
  type: activity.type,
  activityDate: activity.activityDate,
  startTime: activity.startTime,
  place: activity.place,
  memberCapacity: activity.memberCapacity,
  reporterCapacity: activity.reporterCapacity,
  memberOpenAt: activity.memberOpenAt,
  publicStatus: activity.publicStatus,
  memberRecruitmentStatus: activity.memberRecruitmentStatus || 'OPEN',
  reporterRecruitmentStatus: activity.reporterRecruitmentStatus || 'OPEN',
  confirmedCount: activity.confirmedCount || 0,
  reporterCount: activity.reporterCount || 0,
  memberWaitlistCount: activity.memberWaitlistCount || 0,
  createdAt: activity.createdAt,
  updatedAt: activity.updatedAt
});

const listActivities = async (documentClient, tableName) => {
  const activities = [];
  let lastEvaluatedKey;
  do {
    const result = await documentClient.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey
    }));
    activities.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return activities
    .map(adminActivity)
    .sort((a, b) => `${a.activityDate}T${a.startTime}`.localeCompare(`${b.activityDate}T${b.startTime}`));
};

const createActivityId = (activityDate, randomFactory) =>
  `ACT-${activityDate.replaceAll('-', '')}-${randomFactory()}`;

const parseDeleteConfirmation = (event) => {
  try {
    const rawBody = event?.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event?.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const confirmationName = String(body?.confirmationName || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
    return confirmationName
      ? { confirmationName }
      : { error: '삭제할 활동명을 정확히 입력해 주세요.' };
  } catch {
    return { error: '요청 본문은 올바른 JSON 형식이어야 합니다.' };
  }
};

const listApplicationKeys = async (documentClient, applicationsTable, activityId) => {
  const keys = [];
  let lastEvaluatedKey;
  do {
    const result = await documentClient.send(new QueryCommand({
      TableName: applicationsTable,
      KeyConditionExpression: 'activityId = :activityId',
      ExpressionAttributeValues: { ':activityId': activityId },
      ProjectionExpression: 'activityId, applicantKey',
      ExclusiveStartKey: lastEvaluatedKey
    }));
    keys.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return keys;
};

export const createAdminActivitiesHandler = (
  documentClient = dynamo,
  tableName = process.env.ACTIVITIES_TABLE,
  now = () => new Date(),
  randomFactory = () => randomBytes(3).toString('hex').toUpperCase(),
  applicationsTable = process.env.APPLICATIONS_TABLE
) => async (event) => {
  if (!tableName) {
    console.error('ACTIVITIES_TABLE environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  const method = String(event?.httpMethod || '').toUpperCase();
  const adminEmail = event?.requestContext?.authorizer?.claims?.email || 'unknown';

  if (method === 'GET') {
    try {
      const activities = await listActivities(documentClient, tableName);
      console.info('Admin activities viewed', { adminEmail, count: activities.length });
      return jsonResponse(200, { count: activities.length, activities });
    } catch (error) {
      console.error('Failed to load admin activities', { name: error.name, message: error.message });
      return jsonResponse(500, { message: '활동 목록을 불러오지 못했습니다.' });
    }
  }

  if (method === 'DELETE') {
    if (!applicationsTable) {
      console.error('APPLICATIONS_TABLE environment variable is missing');
      return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
    }

    const activityId = String(event?.pathParameters?.activityId || '').trim().toUpperCase();
    if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
      return jsonResponse(400, { message: '올바른 활동 ID가 아닙니다.' });
    }
    const confirmation = parseDeleteConfirmation(event);
    if (confirmation.error) return jsonResponse(400, { message: confirmation.error });

    try {
      const activityResult = await documentClient.send(new GetCommand({
        TableName: tableName,
        Key: { activityId },
        ConsistentRead: true
      }));
      const activity = activityResult.Item;
      if (!activity) return jsonResponse(404, { message: '삭제할 활동을 찾을 수 없습니다.' });
      if (activity.name !== confirmation.confirmationName) {
        return jsonResponse(400, { message: '입력한 활동명이 일치하지 않습니다.' });
      }
      if (activity.publicStatus !== 'PRIVATE'
        || activity.memberRecruitmentStatus !== 'CLOSED'
        || activity.reporterRecruitmentStatus !== 'CLOSED') {
        return jsonResponse(409, {
          message: '안전한 삭제를 위해 활동을 비공개로 전환하고 일반 부원·기자단 모집을 모두 마감해 주세요.'
        });
      }

      const applicationKeys = await listApplicationKeys(documentClient, applicationsTable, activityId);
      if (applicationKeys.length > 99) {
        return jsonResponse(409, {
          message: '신청 기록이 100건 이상인 활동은 영구 삭제할 수 없습니다. 비공개 상태로 보관해 주세요.'
        });
      }

      await documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...applicationKeys.map((key) => ({
            Delete: { TableName: applicationsTable, Key: key }
          })),
          {
            Delete: {
              TableName: tableName,
              Key: { activityId },
              ConditionExpression: '#name = :name AND #publicStatus = :private AND memberRecruitmentStatus = :closed AND reporterRecruitmentStatus = :closed',
              ExpressionAttributeNames: { '#name': 'name', '#publicStatus': 'publicStatus' },
              ExpressionAttributeValues: {
                ':name': confirmation.confirmationName,
                ':private': 'PRIVATE',
                ':closed': 'CLOSED'
              }
            }
          }
        ]
      }));

      console.info('Admin activity permanently deleted', {
        adminEmail,
        activityId,
        deletedApplicationCount: applicationKeys.length
      });
      return jsonResponse(200, {
        message: '활동과 관련 신청 기록을 영구 삭제했습니다.',
        activityId,
        deletedApplicationCount: applicationKeys.length
      });
    } catch (error) {
      if (error?.name === 'TransactionCanceledException') {
        return jsonResponse(409, { message: '삭제 중 활동 상태가 변경되었습니다. 목록을 새로고침해 주세요.' });
      }
      console.error('Failed to permanently delete activity', { name: error.name, message: error.message });
      return jsonResponse(500, { message: '활동을 삭제하는 중 오류가 발생했습니다.' });
    }
  }

  if (!['POST', 'PUT'].includes(method)) {
    return jsonResponse(405, { message: '지원하지 않는 요청 방식입니다.' });
  }

  const parsed = parseBody(event);
  if (parsed.error) return jsonResponse(400, { message: parsed.error });
  const timestamp = now().toISOString();

  if (method === 'POST') {
    const activityId = createActivityId(parsed.value.activityDate, randomFactory);
    const item = {
      activityId,
      ...parsed.value,
      confirmedCount: 0,
      reporterCount: 0,
      memberWaitlistCount: 0,
      reporterWaitlistCount: 0,
      createdAt: timestamp,
      createdBy: adminEmail,
      updatedAt: timestamp,
      updatedBy: adminEmail
    };

    try {
      await documentClient.send(new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(activityId)'
      }));
      console.info('Admin activity created', { adminEmail, activityId });
      return jsonResponse(201, {
        message: '활동이 등록되었습니다.',
        activity: adminActivity(item)
      });
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        return jsonResponse(409, { message: '활동 ID가 중복되었습니다. 다시 시도해 주세요.' });
      }
      console.error('Failed to create admin activity', { name: error.name, message: error.message });
      return jsonResponse(500, { message: '활동을 등록하지 못했습니다.' });
    }
  }

  const activityId = String(event?.pathParameters?.activityId || '').trim().toUpperCase();
  if (!/^ACT-[A-Z0-9-]{3,80}$/.test(activityId)) {
    return jsonResponse(400, { message: '올바른 활동 ID가 아닙니다.' });
  }

  const names = {
    '#name': 'name',
    '#type': 'type',
    '#publicStatus': 'publicStatus'
  };
  const values = {
    ':name': parsed.value.name,
    ':type': parsed.value.type,
    ':activityDate': parsed.value.activityDate,
    ':startTime': parsed.value.startTime,
    ':place': parsed.value.place,
    ':memberCapacity': parsed.value.memberCapacity,
    ':reporterCapacity': parsed.value.reporterCapacity,
    ':memberOpenAt': parsed.value.memberOpenAt,
    ':publicStatus': parsed.value.publicStatus,
    ':memberRecruitmentStatus': parsed.value.memberRecruitmentStatus,
    ':reporterRecruitmentStatus': parsed.value.reporterRecruitmentStatus,
    ':updatedAt': timestamp,
    ':updatedBy': adminEmail
  };

  try {
    const result = await documentClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { activityId },
      UpdateExpression: 'SET #name = :name, #type = :type, activityDate = :activityDate, startTime = :startTime, place = :place, memberCapacity = :memberCapacity, reporterCapacity = :reporterCapacity, memberOpenAt = :memberOpenAt, #publicStatus = :publicStatus, memberRecruitmentStatus = :memberRecruitmentStatus, reporterRecruitmentStatus = :reporterRecruitmentStatus, updatedAt = :updatedAt, updatedBy = :updatedBy',
      ConditionExpression: 'attribute_exists(activityId) AND (attribute_not_exists(confirmedCount) OR confirmedCount <= :memberCapacity) AND (attribute_not_exists(reporterCount) OR reporterCount <= :reporterCapacity)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    console.info('Admin activity updated', { adminEmail, activityId });
    return jsonResponse(200, {
      message: '활동이 수정되었습니다.',
      activity: adminActivity(result.Attributes)
    });
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return jsonResponse(409, {
        message: '활동을 찾을 수 없거나 현재 확정 인원보다 정원을 작게 설정했습니다.'
      });
    }
    console.error('Failed to update admin activity', { name: error.name, message: error.message });
    return jsonResponse(500, { message: '활동을 수정하지 못했습니다.' });
  }
};

export const lambdaHandler = createAdminActivitiesHandler();
