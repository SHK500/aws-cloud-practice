import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';
import { config } from './config.js';
import './styles.css';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: { email: true }
    }
  }
});

const state = {
  activities: [],
  adminActivities: [],
  adminApplications: [],
  selectedRole: 'MEMBER',
  selectedType: 'ALL',
  selectedActivity: null,
  editingActivityId: null,
  replacementTarget: null,
  deletingActivityId: null
};

const ids = [
  'memberView', 'adminView', 'activityStatus', 'activityList', 'roleFilters', 'typeFilters',
  'refreshActivitiesButton', 'adminOpenButton', 'homeButton', 'backToMemberButton',
  'applicationDialog', 'applicationForm', 'applicationDialogTitle', 'applicationDialogDescription',
  'applicationName', 'applicationPassword', 'applicationFormMessage', 'cancelDialog', 'cancelForm',
  'cancelDialogDescription', 'cancelName', 'cancelPassword', 'cancelFormMessage', 'resultDialog',
  'resultIcon', 'resultTitle', 'resultMessage', 'resultDetails', 'toast', 'adminLoginPanel',
  'adminLoginForm', 'adminEmail', 'adminPassword', 'adminLoginMessage', 'adminDashboard',
  'adminCount', 'replacementCount', 'adminActivityFilter', 'adminStatusFilter', 'adminRoleFilter',
  'adminRefreshButton', 'adminLogoutButton', 'adminMessage', 'adminApplicationsBody',
  'adminApplicationsPanel', 'adminActivitiesPanel', 'newActivityButton', 'adminActivitiesMessage',
  'adminActivitiesList', 'activityDialog', 'activityForm', 'activityDialogTitle', 'activityName',
  'activityType', 'activityDate', 'activityStartTime', 'activityPlace', 'activityMemberCapacity',
  'activityReporterCapacity', 'activityMemberOpenAt', 'activityPublicStatus',
  'activityMemberRecruitmentStatus', 'activityReporterRecruitmentStatus', 'activityFormMessage',
  'newPasswordDialog', 'newPasswordForm', 'newAdminPassword', 'newAdminPasswordConfirm',
  'newPasswordMessage', 'cancelNewPasswordButton'
  , 'exportCsvButton', 'replacementDialog', 'replacementForm', 'replacementDescription',
  'replacementName', 'replacementPassword', 'replacementFormMessage', 'activityDeleteDialog',
  'activityDeleteForm', 'activityDeleteDescription', 'activityDeleteConfirmation',
  'activityDeleteFormMessage'
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const roleLabel = (role) => role === 'REPORTER' ? '기자단' : '일반 부원';
const typeLabel = (type) => ({ VOLUNTEER: '봉사', BUCKET: '버킷', 봉사: '봉사', 버킷: '버킷' })[type] || type || '활동';
const statusLabel = (status) => ({ CONFIRMED: '확정', WAITLISTED: '대기', CANCELLED: '취소', REPLACEMENT_NEEDED: '대타 필요' })[status] || status || '-';
const recruitmentLabel = (status) => status === 'CLOSED' ? '모집 마감' : '모집 중';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const formatDate = (value) => {
  if (!value) return '날짜 미정';
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
    .format(new Date(`${value}T00:00:00+09:00`));
};

const formatDateTime = (value) => {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(value));
};

const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `요청을 처리하지 못했습니다. (${response.status})`);
  return data;
};

const adminRequest = async (path, options = {}) => {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
  return apiRequest(path, { ...options, headers: { ...(options.headers || {}), Authorization: idToken } });
};

const showToast = (message) => {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.setTimeout(() => elements.toast.classList.remove('show'), 2600);
};

const showResult = ({ title, message, status, icon = '✓', urgent = false }) => {
  elements.resultIcon.textContent = icon;
  elements.resultIcon.classList.toggle('urgent', urgent);
  elements.resultTitle.textContent = title;
  elements.resultMessage.textContent = message;
  elements.resultDetails.innerHTML = status
    ? `<span>처리 상태</span><strong>${escapeHtml(statusLabel(status))}</strong>` : '';
  elements.resultDialog.showModal();
};

const getRoleAvailability = (activity) => {
  if (state.selectedRole === 'REPORTER') {
    const count = activity.reporterCount || 0;
    const capacity = activity.reporterCapacity || 0;
    const manuallyClosed = activity.reporterRecruitmentStatus === 'CLOSED';
    const available = !manuallyClosed && capacity > count;
    return { count, capacity, available, label: available ? '신청 가능' : '모집 마감', action: available ? '신청하기' : '모집 마감' };
  }

  const count = activity.confirmedCount || 0;
  const capacity = activity.memberCapacity || 0;
  const openAt = activity.memberOpenAt ? new Date(activity.memberOpenAt) : null;
  const started = openAt && Date.now() >= openAt.getTime();
  const manuallyClosed = activity.memberRecruitmentStatus === 'CLOSED';
  const available = Boolean(started) && !manuallyClosed;
  return {
    count, capacity, available, openAt,
    label: manuallyClosed ? '모집 마감' : !started ? '신청 시작 전' : count >= capacity ? '대기 신청 가능' : '신청 가능',
    action: manuallyClosed ? '모집 마감' : !started ? '신청 시작 전' : count >= capacity ? '대기 신청' : '신청하기'
  };
};

const renderActivities = () => {
  const filtered = state.activities.filter((activity) => state.selectedType === 'ALL' || typeLabel(activity.type) === typeLabel(state.selectedType));
  elements.activityStatus.classList.toggle('hidden', filtered.length > 0);
  if (!filtered.length) {
    elements.activityStatus.textContent = '현재 조건에 맞는 공개 활동이 없습니다.';
    elements.activityList.innerHTML = '';
    return;
  }

  elements.activityList.innerHTML = filtered.map((activity) => {
    const availability = getRoleAvailability(activity);
    const percent = availability.capacity ? Math.min(100, Math.round((availability.count / availability.capacity) * 100)) : 0;
    const openText = availability.openAt && Date.now() < availability.openAt.getTime()
      ? `<p class="open-time">${escapeHtml(formatDateTime(availability.openAt))} 신청 시작</p>` : '';
    return `<article class="activity-card">
      <div class="card-topline"><span class="type-badge ${typeLabel(activity.type) === '버킷' ? 'bucket' : ''}">${escapeHtml(typeLabel(activity.type))}</span><span class="availability ${availability.available ? '' : 'closed'}">${escapeHtml(availability.label)}</span></div>
      <h3>${escapeHtml(activity.name)}</h3>
      <dl class="activity-meta"><div><dt>일정</dt><dd>${escapeHtml(formatDate(activity.activityDate))} ${escapeHtml(activity.startTime || '')}</dd></div><div><dt>장소</dt><dd>${escapeHtml(activity.place || '추후 공지')}</dd></div><div><dt>구분</dt><dd>${escapeHtml(roleLabel(state.selectedRole))}</dd></div></dl>
      <div class="capacity-row"><span>신청 현황</span><strong>${availability.count} / ${availability.capacity}명</strong></div>
      <div class="progress" aria-hidden="true"><span style="width:${percent}%"></span></div>${openText}
      <div class="card-actions"><button class="primary-button" type="button" data-apply="${escapeHtml(activity.activityId)}" ${availability.available ? '' : 'disabled'}>${escapeHtml(availability.action)}</button><button class="secondary-button" type="button" data-cancel="${escapeHtml(activity.activityId)}">신청 취소</button></div>
    </article>`;
  }).join('');
};

const loadActivities = async () => {
  elements.activityStatus.classList.remove('hidden');
  elements.activityStatus.textContent = '활동을 불러오는 중입니다.';
  try {
    const data = await apiRequest('/activities');
    state.activities = data.activities || [];
    renderActivities();
  } catch (error) {
    elements.activityList.innerHTML = '';
    elements.activityStatus.textContent = `${error.message} 잠시 후 다시 시도해 주세요.`;
  }
};

const publicActivityById = (activityId) => state.activities.find((item) => item.activityId === activityId);

const openApplication = (activityId) => {
  state.selectedActivity = publicActivityById(activityId);
  if (!state.selectedActivity) return;
  elements.applicationDialogTitle.textContent = state.selectedActivity.name;
  elements.applicationDialogDescription.textContent = `${roleLabel(state.selectedRole)} · ${typeLabel(state.selectedActivity.type)} 신청`;
  elements.applicationFormMessage.textContent = '';
  elements.applicationForm.reset();
  elements.applicationDialog.showModal();
  elements.applicationName.focus();
};

const openCancellation = (activityId) => {
  state.selectedActivity = publicActivityById(activityId);
  if (!state.selectedActivity) return;
  elements.cancelDialogDescription.textContent = `${state.selectedActivity.name} · ${roleLabel(state.selectedRole)} 신청을 취소합니다.`;
  elements.cancelFormMessage.textContent = '';
  elements.cancelForm.reset();
  elements.cancelDialog.showModal();
  elements.cancelName.focus();
};

const submitApplication = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true; button.textContent = '신청 처리 중…'; elements.applicationFormMessage.textContent = '';
  try {
    const data = await apiRequest('/applications', { method: 'POST', body: JSON.stringify({ activityId: state.selectedActivity.activityId, applicantRole: state.selectedRole, name: elements.applicationName.value, password: elements.applicationPassword.value }) });
    elements.applicationDialog.close();
    showResult({ title: data.status === 'WAITLISTED' ? '대기 신청이 접수되었어요' : '신청이 확정되었어요', message: data.message, status: data.status, icon: data.status === 'WAITLISTED' ? '⌛' : '✓' });
    await loadActivities();
  } catch (error) { elements.applicationFormMessage.textContent = error.message; }
  finally { button.disabled = false; button.textContent = '신청하기'; }
};

const requestCancellation = (confirmVacancy = false) => apiRequest('/applications/cancel', { method: 'POST', body: JSON.stringify({ activityId: state.selectedActivity.activityId, applicantRole: state.selectedRole, name: elements.cancelName.value, password: elements.cancelPassword.value, confirmVacancy }) });

const submitCancellation = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true; button.textContent = '취소 내역 확인 중…'; elements.cancelFormMessage.textContent = '';
  try {
    let data = await requestCancellation(false);
    if (data.confirmationRequired) {
      if (!window.confirm(data.message)) return;
      data = await requestCancellation(true);
    }
    elements.cancelDialog.close();
    showResult({ title: data.replacementNeeded ? '취소되었어요. 임원진에게 연락해 주세요' : '신청이 취소되었어요', message: data.message, status: data.status, icon: data.replacementNeeded ? '!' : '✓', urgent: data.replacementNeeded });
    await loadActivities();
  } catch (error) { elements.cancelFormMessage.textContent = error.message; }
  finally { button.disabled = false; button.textContent = '취소 내역 확인'; }
};

const setActiveFilter = (container, target, attribute) => container.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset[attribute] === target));

const showAdminDashboard = async () => {
  elements.adminLoginPanel.classList.add('hidden');
  elements.adminDashboard.classList.remove('hidden');
  await Promise.all([loadAdminActivities(), loadAdminApplications()]);
};

const openAdminView = async () => {
  elements.memberView.classList.add('hidden'); elements.adminView.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' });
  try { await getCurrentUser(); await showAdminDashboard(); }
  catch { elements.adminDashboard.classList.add('hidden'); elements.adminLoginPanel.classList.remove('hidden'); }
};

const closeAdminView = () => { elements.adminView.classList.add('hidden'); elements.memberView.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); };

const loginAdmin = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true; button.textContent = '로그인 중…'; elements.adminLoginMessage.textContent = '';
  try {
    const result = await signIn({ username: elements.adminEmail.value.trim(), password: elements.adminPassword.value });
    if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      elements.newPasswordForm.reset();
      elements.newPasswordMessage.textContent = '';
      elements.newPasswordDialog.showModal();
      elements.newAdminPassword.focus();
      return;
    }
    if (!result.isSignedIn) throw new Error('지원하지 않는 추가 인증 단계입니다. 관리자에게 문의해 주세요.');
    elements.adminPassword.value = '';
    await showAdminDashboard();
    showToast('임원진으로 로그인했습니다.');
  } catch (error) {
    elements.adminLoginMessage.textContent = ['NotAuthorizedException', 'UserNotFoundException'].includes(error.name) ? '이메일 또는 비밀번호를 확인해 주세요.' : error.message || '로그인하지 못했습니다.';
  } finally { button.disabled = false; button.textContent = '로그인'; }
};

const isValidAdminPassword = (password) => password.length >= 12
  && /[A-Z]/.test(password)
  && /[a-z]/.test(password)
  && /[0-9]/.test(password);

const submitNewPassword = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const password = elements.newAdminPassword.value;
  const passwordConfirm = elements.newAdminPasswordConfirm.value;
  elements.newPasswordMessage.textContent = '';

  if (!isValidAdminPassword(password)) {
    elements.newPasswordMessage.textContent = '12자 이상이며 대문자, 소문자, 숫자를 각각 포함해 주세요.';
    return;
  }
  if (password !== passwordConfirm) {
    elements.newPasswordMessage.textContent = '새 비밀번호 두 개가 일치하지 않습니다.';
    return;
  }

  button.disabled = true;
  button.textContent = '비밀번호 변경 중…';
  try {
    const result = await confirmSignIn({ challengeResponse: password });
    if (!result.isSignedIn) throw new Error('추가 인증이 필요합니다. 관리자에게 문의해 주세요.');
    elements.newPasswordDialog.close();
    elements.newPasswordForm.reset();
    elements.adminPassword.value = '';
    await showAdminDashboard();
    showToast('새 비밀번호가 설정되었습니다.');
  } catch (error) {
    elements.newPasswordMessage.textContent = error.name === 'InvalidPasswordException'
      ? '비밀번호 정책을 충족하지 않습니다. 다른 비밀번호를 입력해 주세요.'
      : error.message || '비밀번호를 변경하지 못했습니다.';
  } finally {
    button.disabled = false;
    button.textContent = '비밀번호 변경 후 로그인';
  }
};

const cancelNewPassword = async () => {
  try { await signOut(); } catch { /* 아직 완료된 로그인 세션이 없을 수 있습니다. */ }
  elements.newPasswordDialog.close();
  elements.newPasswordForm.reset();
  elements.adminPassword.value = '';
  elements.adminLoginMessage.textContent = '첫 로그인을 취소했습니다. 임시 비밀번호로 다시 로그인할 수 있습니다.';
};

const adminActivityById = (activityId) => state.adminActivities.find((item) => item.activityId === activityId);

const renderAdminActivityOptions = () => {
  const selected = elements.adminActivityFilter.value;
  elements.adminActivityFilter.innerHTML = '<option value="">전체 활동</option>' + state.adminActivities.map((activity) => `<option value="${escapeHtml(activity.activityId)}">${escapeHtml(activity.name)}${activity.publicStatus === 'PRIVATE' ? ' (비공개)' : ''}</option>`).join('');
  elements.adminActivityFilter.value = selected;
};

const loadAdminApplications = async () => {
  elements.adminMessage.textContent = '신청자 목록을 불러오는 중입니다.'; elements.adminApplicationsBody.innerHTML = '';
  try {
    const query = new URLSearchParams();
    if (elements.adminActivityFilter.value) query.set('activityId', elements.adminActivityFilter.value);
    if (elements.adminStatusFilter.value) query.set('status', elements.adminStatusFilter.value);
    if (elements.adminRoleFilter.value) query.set('applicantRole', elements.adminRoleFilter.value);
    const data = await adminRequest(`/admin/applications${query.toString() ? `?${query}` : ''}`);
    state.adminApplications = data.applications || [];
    renderAdminApplications();
  } catch (error) { elements.adminMessage.textContent = error.message; }
};

const renderAdminApplications = () => {
  const applications = state.adminApplications;
  elements.adminCount.textContent = String(applications.length);
  elements.replacementCount.textContent = String(applications.filter((item) => item.status === 'REPLACEMENT_NEEDED').length);
  elements.adminMessage.textContent = applications.length ? `신청 ${applications.length}건을 조회했습니다.` : '조건에 맞는 신청이 없습니다.';
  elements.adminApplicationsBody.innerHTML = applications.map((application) => {
    const activity = adminActivityById(application.activityId) || publicActivityById(application.activityId);
    const replacementAction = application.status === 'REPLACEMENT_NEEDED'
      ? `<button class="secondary-button compact-button" type="button" data-assign-replacement="${escapeHtml(application.applicationId)}">대타 확정</button>`
      : '-';
    return `<tr><td><strong>${escapeHtml(activity?.name || application.activityId)}</strong></td><td>${escapeHtml(roleLabel(application.applicantRole))}</td><td>${escapeHtml(application.name)}</td><td><span class="status-pill ${escapeHtml(application.status.toLowerCase())}">${escapeHtml(statusLabel(application.status))}</span></td><td>${escapeHtml(formatDateTime(application.createdAt))}</td><td>${replacementAction}</td></tr>`;
  }).join('');
};

const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

const loadAllApplicationsForExport = async () => {
  const applications = [];
  let nextToken = '';
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (elements.adminActivityFilter.value) query.set('activityId', elements.adminActivityFilter.value);
    if (elements.adminStatusFilter.value) query.set('status', elements.adminStatusFilter.value);
    if (elements.adminRoleFilter.value) query.set('applicantRole', elements.adminRoleFilter.value);
    if (nextToken) query.set('nextToken', nextToken);
    const data = await adminRequest(`/admin/applications?${query}`);
    applications.push(...(data.applications || []));
    nextToken = data.nextToken || '';
  } while (nextToken);
  return applications;
};

const exportApplicationsCsv = async () => {
  const button = elements.exportCsvButton;
  button.disabled = true;
  button.textContent = '파일 만드는 중…';
  try {
    const applications = await loadAllApplicationsForExport();
    if (!applications.length) throw new Error('다운로드할 신청자가 없습니다.');
    const headers = ['활동 ID', '활동명', '신청 구분', '이름', '상태', '접수 시각', '취소 시각', '대기 승격 시각', '대타 확정 시각'];
    const rows = applications.map((application) => {
      const activity = adminActivityById(application.activityId) || publicActivityById(application.activityId);
      return [
        application.activityId,
        activity?.name || '',
        roleLabel(application.applicantRole),
        application.name,
        statusLabel(application.status),
        application.createdAt || '',
        application.cancelledAt || '',
        application.promotedAt || '',
        application.assignedAsReplacementAt || application.replacementResolvedAt || ''
      ].map(csvCell).join(',');
    });
    const csv = `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.join('\r\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const selectedActivity = adminActivityById(elements.adminActivityFilter.value);
    const safeName = (selectedActivity?.name || '전체활동').replace(/[\\/:*?"<>|]/g, '_');
    link.href = url;
    link.download = `신청자명단_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`신청자 ${applications.length}명의 CSV를 만들었습니다.`);
  } catch (error) {
    showToast(error.message || 'CSV 파일을 만들지 못했습니다.');
  } finally {
    button.disabled = false;
    button.textContent = 'CSV 다운로드';
  }
};

const openReplacementForm = (applicationId) => {
  const application = state.adminApplications.find((item) => item.applicationId === applicationId);
  if (!application || application.status !== 'REPLACEMENT_NEEDED') return;
  state.replacementTarget = application;
  const activity = adminActivityById(application.activityId) || publicActivityById(application.activityId);
  elements.replacementDescription.textContent = `${activity?.name || application.activityId}의 ${application.name}님을 대신할 ${roleLabel(application.applicantRole)}을 등록합니다.`;
  elements.replacementForm.reset();
  elements.replacementFormMessage.textContent = '';
  elements.replacementDialog.showModal();
  elements.replacementName.focus();
};

const submitReplacement = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const target = state.replacementTarget;
  if (!target) return;
  button.disabled = true;
  button.textContent = '대타 확정 중…';
  elements.replacementFormMessage.textContent = '';
  try {
    const data = await adminRequest('/admin/applications/replacement', {
      method: 'POST',
      body: JSON.stringify({
        activityId: target.activityId,
        originalApplicationId: target.applicationId,
        applicantRole: target.applicantRole,
        originalName: target.name,
        replacementName: elements.replacementName.value,
        password: elements.replacementPassword.value
      })
    });
    elements.replacementDialog.close();
    state.replacementTarget = null;
    showToast(data.message || '대타를 확정했습니다.');
    await Promise.all([loadAdminApplications(), loadAdminActivities(), loadActivities()]);
  } catch (error) {
    elements.replacementFormMessage.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '대타 확정하기';
  }
};

const renderAdminActivities = () => {
  elements.adminActivitiesMessage.textContent = state.adminActivities.length ? `활동 ${state.adminActivities.length}개를 관리할 수 있습니다.` : '등록된 활동이 없습니다.';
  elements.adminActivitiesList.innerHTML = state.adminActivities.map((activity) => `<article class="admin-activity-card">
    <div class="admin-activity-main"><div class="admin-activity-badges"><span class="type-badge ${activity.type === 'BUCKET' ? 'bucket' : ''}">${escapeHtml(typeLabel(activity.type))}</span><span class="manage-pill ${activity.publicStatus === 'PUBLIC' ? 'public' : 'private'}">${activity.publicStatus === 'PUBLIC' ? '공개' : '비공개'}</span></div><h3>${escapeHtml(activity.name)}</h3><p>${escapeHtml(formatDate(activity.activityDate))} ${escapeHtml(activity.startTime)} · ${escapeHtml(activity.place)}</p></div>
    <div class="admin-activity-counts"><span>일반 <strong>${activity.confirmedCount || 0}/${activity.memberCapacity}</strong> · ${escapeHtml(recruitmentLabel(activity.memberRecruitmentStatus))}</span><span>기자단 <strong>${activity.reporterCount || 0}/${activity.reporterCapacity}</strong> · ${escapeHtml(recruitmentLabel(activity.reporterRecruitmentStatus))}</span></div>
    <div class="admin-activity-actions">
      <button class="secondary-button" type="button" data-edit-activity="${escapeHtml(activity.activityId)}">수정</button>
      <button class="danger-outline-button" type="button" data-delete-activity="${escapeHtml(activity.activityId)}">삭제</button>
    </div>
  </article>`).join('');
};

const loadAdminActivities = async () => {
  elements.adminActivitiesMessage.textContent = '활동 목록을 불러오는 중입니다.';
  try {
    const data = await adminRequest('/admin/activities');
    state.adminActivities = data.activities || [];
    renderAdminActivities(); renderAdminActivityOptions();
  } catch (error) { elements.adminActivitiesMessage.textContent = error.message; }
};

const toDateTimeLocal = (value) => value ? value.slice(0, 16) : '';
const toKoreanIso = (value) => value ? `${value.length === 16 ? `${value}:00` : value}+09:00` : '';

const openActivityForm = (activity = null) => {
  state.editingActivityId = activity?.activityId || null;
  elements.activityDialogTitle.textContent = activity ? '활동 수정' : '새 활동 등록';
  elements.activityForm.reset(); elements.activityFormMessage.textContent = '';
  elements.activityName.value = activity?.name || '';
  elements.activityType.value = activity?.type || 'VOLUNTEER';
  elements.activityDate.value = activity?.activityDate || '';
  elements.activityStartTime.value = activity?.startTime || '';
  elements.activityPlace.value = activity?.place || '';
  elements.activityMemberCapacity.value = activity?.memberCapacity ?? 20;
  elements.activityReporterCapacity.value = activity?.reporterCapacity ?? 2;
  elements.activityMemberOpenAt.value = toDateTimeLocal(activity?.memberOpenAt);
  elements.activityPublicStatus.value = activity?.publicStatus || 'PUBLIC';
  elements.activityMemberRecruitmentStatus.value = activity?.memberRecruitmentStatus || 'OPEN';
  elements.activityReporterRecruitmentStatus.value = activity?.reporterRecruitmentStatus || 'OPEN';
  elements.activityDialog.showModal(); elements.activityName.focus();
};

const submitActivity = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true; button.textContent = '저장 중…'; elements.activityFormMessage.textContent = '';
  const body = {
    name: elements.activityName.value, type: elements.activityType.value,
    activityDate: elements.activityDate.value, startTime: elements.activityStartTime.value,
    place: elements.activityPlace.value, memberCapacity: Number(elements.activityMemberCapacity.value),
    reporterCapacity: Number(elements.activityReporterCapacity.value),
    memberOpenAt: toKoreanIso(elements.activityMemberOpenAt.value), publicStatus: elements.activityPublicStatus.value,
    memberRecruitmentStatus: elements.activityMemberRecruitmentStatus.value,
    reporterRecruitmentStatus: elements.activityReporterRecruitmentStatus.value
  };
  try {
    const editing = Boolean(state.editingActivityId);
    const path = editing ? `/admin/activities/${encodeURIComponent(state.editingActivityId)}` : '/admin/activities';
    const data = await adminRequest(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
    elements.activityDialog.close(); showToast(data.message || '활동을 저장했습니다.');
    await Promise.all([loadAdminActivities(), loadActivities()]);
  } catch (error) { elements.activityFormMessage.textContent = error.message; }
  finally { button.disabled = false; button.textContent = '저장하기'; }
};

const openActivityDeleteForm = (activityId) => {
  const activity = adminActivityById(activityId);
  if (!activity) return;
  state.deletingActivityId = activityId;
  elements.activityDeleteForm.reset();
  const isReady = activity.publicStatus === 'PRIVATE'
    && activity.memberRecruitmentStatus === 'CLOSED'
    && activity.reporterRecruitmentStatus === 'CLOSED';
  elements.activityDeleteDescription.textContent = isReady
    ? `“${activity.name}” 활동을 영구 삭제하려면 아래에 활동명을 그대로 입력하세요.`
    : `먼저 “${activity.name}” 활동을 수정하여 비공개로 전환하고 일반 부원·기자단 모집을 모두 마감해야 합니다.`;
  elements.activityDeleteFormMessage.textContent = isReady
    ? ''
    : '현재 상태에서는 삭제할 수 없습니다. 이 창을 닫고 활동을 먼저 수정해 주세요.';
  elements.activityDeleteConfirmation.placeholder = activity.name;
  elements.activityDeleteDialog.showModal();
  elements.activityDeleteConfirmation.focus();
};

const submitActivityDelete = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const activity = adminActivityById(state.deletingActivityId);
  if (!activity) return;
  button.disabled = true;
  button.textContent = '삭제 중…';
  elements.activityDeleteFormMessage.textContent = '';
  try {
    const data = await adminRequest(`/admin/activities/${encodeURIComponent(activity.activityId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmationName: elements.activityDeleteConfirmation.value })
    });
    elements.activityDeleteDialog.close();
    state.deletingActivityId = null;
    showToast(data.message || '활동을 영구 삭제했습니다.');
    await Promise.all([loadAdminActivities(), loadAdminApplications(), loadActivities()]);
  } catch (error) {
    elements.activityDeleteFormMessage.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '활동과 신청 기록 영구 삭제';
  }
};

const switchAdminTab = (tab) => {
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.classList.toggle('active', button.dataset.adminTab === tab));
  elements.adminApplicationsPanel.classList.toggle('hidden', tab !== 'applications');
  elements.adminActivitiesPanel.classList.toggle('hidden', tab !== 'activities');
};

elements.roleFilters.addEventListener('click', (event) => { const role = event.target.closest('[data-role]')?.dataset.role; if (role) { state.selectedRole = role; setActiveFilter(elements.roleFilters, role, 'role'); renderActivities(); } });
elements.typeFilters.addEventListener('click', (event) => { const type = event.target.closest('[data-type]')?.dataset.type; if (type) { state.selectedType = type; setActiveFilter(elements.typeFilters, type, 'type'); renderActivities(); } });
elements.activityList.addEventListener('click', (event) => { const applyId = event.target.closest('[data-apply]')?.dataset.apply; const cancelId = event.target.closest('[data-cancel]')?.dataset.cancel; if (applyId) openApplication(applyId); if (cancelId) openCancellation(cancelId); });
elements.adminActivitiesList.addEventListener('click', (event) => {
  const editId = event.target.closest('[data-edit-activity]')?.dataset.editActivity;
  const deleteId = event.target.closest('[data-delete-activity]')?.dataset.deleteActivity;
  if (editId) openActivityForm(adminActivityById(editId));
  if (deleteId) openActivityDeleteForm(deleteId);
});
elements.adminApplicationsBody.addEventListener('click', (event) => { const applicationId = event.target.closest('[data-assign-replacement]')?.dataset.assignReplacement; if (applicationId) openReplacementForm(applicationId); });
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
document.querySelector('.admin-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-admin-tab]')?.dataset.adminTab; if (tab) switchAdminTab(tab); });
elements.applicationForm.addEventListener('submit', submitApplication);
elements.cancelForm.addEventListener('submit', submitCancellation);
elements.activityForm.addEventListener('submit', submitActivity);
elements.activityDeleteForm.addEventListener('submit', submitActivityDelete);
elements.replacementForm.addEventListener('submit', submitReplacement);
elements.newPasswordForm.addEventListener('submit', submitNewPassword);
elements.cancelNewPasswordButton.addEventListener('click', cancelNewPassword);
elements.newActivityButton.addEventListener('click', () => openActivityForm());
elements.refreshActivitiesButton.addEventListener('click', loadActivities);
elements.adminOpenButton.addEventListener('click', openAdminView);
elements.backToMemberButton.addEventListener('click', closeAdminView);
elements.homeButton.addEventListener('click', closeAdminView);
elements.adminLoginForm.addEventListener('submit', loginAdmin);
elements.adminRefreshButton.addEventListener('click', loadAdminApplications);
elements.exportCsvButton.addEventListener('click', exportApplicationsCsv);
elements.adminActivityFilter.addEventListener('change', loadAdminApplications);
elements.adminStatusFilter.addEventListener('change', loadAdminApplications);
elements.adminRoleFilter.addEventListener('change', loadAdminApplications);
elements.adminLogoutButton.addEventListener('click', async () => { await signOut(); state.adminApplications = []; state.adminActivities = []; elements.adminDashboard.classList.add('hidden'); elements.adminLoginPanel.classList.remove('hidden'); showToast('로그아웃했습니다.'); });

loadActivities();
