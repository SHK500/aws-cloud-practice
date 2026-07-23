import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  },
  body: JSON.stringify(body)
});

export const createHandler = (
  documentClient = dynamo,
  tableName = process.env.ACTIVITIES_TABLE
) => async () => {
  if (!tableName) {
    console.error('ACTIVITIES_TABLE environment variable is missing');
    return jsonResponse(500, { message: '서버 설정 오류가 발생했습니다.' });
  }

  try {
    const activities = [];
    let lastEvaluatedKey;

    do {
      const result = await documentClient.send(new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey,
        FilterExpression: '#publicStatus = :publicStatus',
        ExpressionAttributeNames: {
          '#publicStatus': 'publicStatus'
        },
        ExpressionAttributeValues: {
          ':publicStatus': 'PUBLIC'
        }
      }));

      activities.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const publicActivities = activities
      .map((activity) => ({
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
        reporterCount: activity.reporterCount || 0
      }))
      .sort((a, b) => {
        const aKey = `${a.activityDate || ''}T${a.startTime || ''}`;
        const bKey = `${b.activityDate || ''}T${b.startTime || ''}`;
        return aKey.localeCompare(bKey);
      });

    return jsonResponse(200, {
      count: publicActivities.length,
      activities: publicActivities
    });
  } catch (error) {
    console.error('Failed to load activities', {
      name: error.name,
      message: error.message
    });
    return jsonResponse(500, { message: '활동 목록을 불러오지 못했습니다.' });
  }
};

export const lambdaHandler = createHandler();
