const timestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const newestActivityFirst = (a, b) => {
  const aCreatedAt = timestamp(a.createdAt);
  const bCreatedAt = timestamp(b.createdAt);

  if (aCreatedAt !== undefined && bCreatedAt !== undefined && aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }
  if (aCreatedAt !== undefined && bCreatedAt === undefined) return -1;
  if (aCreatedAt === undefined && bCreatedAt !== undefined) return 1;

  const aSchedule = `${a.activityDate || ''}T${a.startTime || ''}`;
  const bSchedule = `${b.activityDate || ''}T${b.startTime || ''}`;
  const scheduleOrder = bSchedule.localeCompare(aSchedule);
  if (scheduleOrder !== 0) return scheduleOrder;

  return String(b.activityId || '').localeCompare(String(a.activityId || ''));
};
