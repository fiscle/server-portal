const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let me = null;
let currentPath = '';
let fileScope = 'mine';
let socket = null;
let registrationStatus = { firstUser: true };
let userPage = 1;
let userQuery = '';
let invitePage = 1;
let remoteAdminPage = 1;
let remoteAdminQuery = '';
let remoteAdminGroup = '';
let remoteAdminReauthToken = '';
let auditPage = 1;
let auditQuery = '';
let auditUsername = '';
let auditAction = '';
let auditFrom = '';
let auditTo = '';
let features = { resources: true };
const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 13, theme: { background: '#111827' } });
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `show${error ? ' error' : ''}`;
  clearTimeout(element.timer);
  element.timer = setTimeout(() => element.className = '', 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : {};
  if (response.status === 401 && $('#app-view') && !$('#app-view').hidden) {
    redirectToLogin(data.error || '登录已超时，请重新登录');
    throw new Error(data.error || '登录已超时，请重新登录');
  }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function submitJson(url, method, form) {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
}

function redirectToLogin(message = '登录已超时，请重新登录') {
  if (socket) {
    socket.close();
    socket = null;
  }
  me = null;
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
  try { $('#modal').close(); } catch (_) {}
  $('[data-auth-tab="login"]').click();
  refreshCaptcha('login');
  toast(message, true);
}

async function refreshCaptcha(formName) {
  const form = $(`#${formName}-form`);
  const field = $(`[data-captcha-field="${formName}"]`);
  if (field && field.hidden) return;
  const button = form.querySelector(`[data-captcha-for="${formName}"]`);
  const image = button.querySelector('img');
  const token = form.querySelector('[name="captchaToken"]');
  const code = form.querySelector('[name="captchaCode"]');
  button.classList.add('loading');
  button.disabled = true;
  try {
    const data = await api('/api/captcha');
    image.src = data.image;
    token.value = data.token;
    code.value = '';
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function setCaptchaRequired(formName, required) {
  const field = $(`[data-captcha-field="${formName}"]`);
  const form = $(`#${formName}-form`);
  if (!field || !form) return;
  field.hidden = !required;
  const input = form.querySelector('[name="captchaCode"]');
  const token = form.querySelector('[name="captchaToken"]');
  input.required = required;
  if (!required) {
    input.value = '';
    token.value = '';
  }
}

async function updateCaptchaPolicy(formName, force = false) {
  try {
    const data = await api(`/api/captcha-policy?type=${encodeURIComponent(formName)}`);
    setCaptchaRequired(formName, data.required);
    if (data.required || force) await refreshCaptcha(formName);
  } catch (_) {}
}

$$('[data-captcha-for]').forEach(button => {
  button.onclick = () => refreshCaptcha(button.dataset.captchaFor);
});

$$('[data-auth-tab]').forEach(button => button.onclick = () => {
  $$('[data-auth-tab]').forEach(item => item.classList.toggle('active', item === button));
  $('#login-form').hidden = button.dataset.authTab !== 'login';
  $('#register-form').hidden = button.dataset.authTab !== 'register';
});

$('#login-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await submitJson('/api/login', 'POST', event.target);
    await boot();
  } catch (error) {
    toast(error.message, true);
    setCaptchaRequired('login', true);
    await refreshCaptcha('login');
  }
};

$('#register-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const data = await submitJson('/api/register', 'POST', event.target);
    toast(data.message);
    $('[data-auth-tab="login"]').click();
    await updateCaptchaPolicy('login');
    await updateCaptchaPolicy('register');
  } catch (error) {
    toast(error.message, true);
    setCaptchaRequired('register', true);
    await refreshCaptcha('register');
  }
};

async function loadRegistrationStatus() {
  try {
    registrationStatus = await api('/api/registration-status');
    $('#invite-code-field').hidden = registrationStatus.firstUser;
    $('#invite-code-field input').required = !registrationStatus.firstUser;
    $('#register-hint').textContent = registrationStatus.firstUser
      ? `首位注册者将成为管理员，并获得 ${registrationStatus.adminInviteCount || 6} 个推荐码`
      : `请输入有效推荐码；注册成功后可获得 ${registrationStatus.userInviteCount || 3} 个推荐码`;
  } catch (_) {}
}

async function boot() {
  try {
    const profile = await api('/api/me');
    me = profile.user;
    features = profile.features || features;
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#side-name').textContent = me.displayName;
    $('#side-role').textContent = me.role === 'admin' ? '系统管理员' : '普通用户';
    $('#hello-name').textContent = me.displayName;
    if (me.role !== 'admin') {
      $('[data-page="users"]').style.display = 'none';
      $('[data-page="audit"]').style.display = 'none';
    }
    if (!features.resources) $('[data-page="resources"]').style.display = 'none';
    loadDashboard();
    loadMyInvites();
  } catch (_) {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
  }
}

const titles = { dashboard: ['工作台 / 总览', '总览'], users: ['系统管理 / 用户管理', '用户管理'], remote: ['系统管理 / 远程管理', '远程管理'], files: ['系统管理 / 文件管理', '文件管理'], resources: ['系统管理 / 服务器资源', '服务器资源'], audit: ['系统管理 / 日志查询', '日志查询'] };
function go(page) {
  $$('.page').forEach(item => item.classList.toggle('active', item.id === `page-${page}`));
  $$('[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === page));
  $('#breadcrumb').textContent = titles[page][0];
  $('#page-title').textContent = titles[page][1];
  $('.sidebar').classList.remove('open');
  if (page === 'users') loadUsers();
  if (page === 'audit') loadAuditLogs();
  if (page === 'files') {
    if (me.role !== 'admin') fileScope = 'mine';
    loadFiles();
  }
  if (page === 'resources') loadResources();
  if (page === 'remote') {
    loadRemoteSessions();
    setTimeout(() => { fit.fit(); terminal.focus(); }, 50);
  }
}
$$('[data-page]').forEach(button => button.onclick = () => go(button.dataset.page));
$$('[data-go]').forEach(button => button.onclick = () => go(button.dataset.go));
$('#menu-toggle').onclick = () => $('.sidebar').classList.toggle('open');
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

function applySidebarState(collapsed) {
  $('#app-view').classList.toggle('sidebar-collapsed', collapsed);
  $('#sidebar-collapse').title = collapsed ? '展开菜单' : '收起菜单';
  setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
}
applySidebarState(localStorage.getItem('sidebarCollapsed') === '1');
$('#sidebar-collapse').onclick = () => {
  const collapsed = !$('#app-view').classList.contains('sidebar-collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  applySidebarState(collapsed);
};

async function loadDashboard() {
  try {
    if (me.role === 'admin') $('#stat-users').textContent = (await api('/api/users?page=1&pageSize=10')).pagination.total;
    else $('#stat-users').textContent = '我的';
    $('#stat-files').textContent = (await api('/api/files?scope=mine')).items.length;
  } catch (_) {}
}

async function loadUsers(page = userPage) {
  if (me.role !== 'admin') return;
  try {
    const data = await api(`/api/users?page=${page}&pageSize=20&q=${encodeURIComponent(userQuery)}`);
    const users = data.users;
    userPage = data.pagination.page;
    $('#user-total').textContent = `共 ${data.pagination.total} 位用户`;
    $('#users-table').innerHTML = `<table><thead><tr><th>用户</th><th>角色</th><th>用户组</th><th>推荐人</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map(user => `<tr>
      <td><b>${escapeHtml(user.displayName)}</b><br><small>@${escapeHtml(user.username)}</small></td>
      <td><span class="badge ${user.role}">${user.role === 'admin' ? '管理员' : '普通用户'}</span></td>
      <td>${user.groupPath ? `<span class="badge">${escapeHtml(user.groupPath)}</span>` : '<span class="muted">未分组</span>'}</td>
      <td>${user.inviter ? `${escapeHtml(user.inviter.displayName)}<br><small>@${escapeHtml(user.inviter.username)} · ${escapeHtml(user.inviteCode || '')}</small>` : '<span class="badge">首位注册</span>'}</td>
      <td><span class="badge ${user.active ? 'on' : ''}">${user.active ? '正常' : '已停用'}</span></td>
      <td>${new Date(user.createdAt).toLocaleString()}</td>
      <td><button class="link-btn referral-chain" data-id="${user.id}">推荐链路</button><button class="link-btn edit-user" data-id="${user.id}">编辑</button><button class="link-btn danger delete-user" data-id="${user.id}">删除</button></td></tr>`).join('')}</tbody></table>`;
    if (!users.length) $('#users-table').innerHTML = '<div class="empty">没有找到匹配用户</div>';
    $$('.edit-user').forEach(button => button.onclick = () => editUser(users.find(user => user.id === button.dataset.id)));
    $$('.delete-user').forEach(button => button.onclick = () => deleteUser(users.find(user => user.id === button.dataset.id)));
    $$('.referral-chain').forEach(button => button.onclick = () => showReferralChain(button.dataset.id));
    renderUserPagination(data.pagination);
    await loadInvites();
  } catch (error) { toast(error.message, true); }
}

function renderUserPagination(pagination) {
  const pages = [];
  const start = Math.max(1, pagination.page - 2);
  const end = Math.min(pagination.totalPages, pagination.page + 2);
  for (let page = start; page <= end; page += 1) pages.push(page);
  $('#users-pagination').innerHTML = `<button data-user-page="${pagination.page - 1}"${pagination.page <= 1 ? ' disabled' : ''}>上一页</button>
    ${start > 1 ? '<span>…</span>' : ''}
    ${pages.map(page => `<button data-user-page="${page}" class="${page === pagination.page ? 'active' : ''}">${page}</button>`).join('')}
    ${end < pagination.totalPages ? '<span>…</span>' : ''}
    <button data-user-page="${pagination.page + 1}"${pagination.page >= pagination.totalPages ? ' disabled' : ''}>下一页</button>`;
  $$('[data-user-page]').forEach(button => button.onclick = () => loadUsers(Number(button.dataset.userPage)));
}

$('#user-search-button').onclick = () => {
  userQuery = $('#user-search').value.trim();
  loadUsers(1);
};
$('#user-search').onkeydown = event => {
  if (event.key === 'Enter') {
    userQuery = event.target.value.trim();
    loadUsers(1);
  }
};
$('#user-search-clear').onclick = () => {
  $('#user-search').value = '';
  userQuery = '';
  loadUsers(1);
};

async function showReferralChain(userId) {
  try {
    const data = await api(`/api/users/${userId}/referral-chain?offset=0&limit=30`);
    showModal('用户推荐链路', `<p class="chain-summary">链路共 ${data.pagination.total} 层，按当前用户向首位注册者方向展示</p><div class="referral-chain-scroll"><div id="referral-chain-items" class="referral-chain-view"></div><button id="chain-load-more" class="secondary chain-load-more" hidden>继续加载</button></div>`);
    appendReferralNodes(data, 0);
    const more = $('#chain-load-more');
    more.hidden = !data.pagination.hasMore;
    more.dataset.offset = String(data.chain.length);
    more.onclick = async () => {
      more.disabled = true;
      more.textContent = '加载中...';
      try {
        const offset = Number(more.dataset.offset);
        const next = await api(`/api/users/${userId}/referral-chain?offset=${offset}&limit=30`);
        appendReferralNodes(next, offset);
        more.dataset.offset = String(offset + next.chain.length);
        more.hidden = !next.pagination.hasMore;
      } catch (error) { toast(error.message, true); }
      finally { more.disabled = false; more.textContent = '继续加载'; }
    };
  } catch (error) { toast(error.message, true); }
}

function appendReferralNodes(data, startIndex) {
  const container = $('#referral-chain-items');
  container.insertAdjacentHTML('beforeend', data.chain.map((item, localIndex) => {
    const index = startIndex + localIndex;
    const isLast = index === data.pagination.total - 1;
    return `<div class="referral-node">
      <span class="referral-index">${index + 1}</span>
      <div><b>${escapeHtml(item.user.displayName)}</b> <small>@${escapeHtml(item.user.username)}</small>
      <p>${index === 0 ? '当前用户' : isLast ? '链路起点' : '上级推荐人'} · ${new Date(item.registeredAt).toLocaleString()}</p>
      ${item.inviteCode ? `<code>使用推荐码：${escapeHtml(item.inviteCode)}</code>` : '<code>首位管理员注册，无推荐码</code>'}</div>
    </div>${!isLast ? '<div class="referral-arrow">↑ 由上级推荐</div>' : ''}`;
  }).join(''));
  if (data.cycleDetected) container.insertAdjacentHTML('beforeend', '<p class="chain-warning">检测到异常循环关系，链路已停止。</p>');
  if (data.truncated) container.insertAdjacentHTML('beforeend', '<p class="chain-warning">链路超过 5000 层，已按安全上限截断。</p>');
}

async function loadMyInvites() {
  try {
    const invites = (await api('/api/invites/mine')).invites;
    const available = invites.filter(item => item.status === 'available');
    $('#mine-invite-count').textContent = `${available.length} 个可用`;
    $('#mine-invites').innerHTML = invites.length ? invites.map(item => `<div class="code-card">
      <code>${escapeHtml(item.code)}</code>
      <small>${item.status === 'used' ? `已由 ${escapeHtml(item.usedBy?.displayName || '用户')} 使用` : item.status === 'disabled' ? '已停用' : '可分享使用'}</small>
      ${item.status === 'available' ? `<button class="link-btn copy-code" data-code="${escapeHtml(item.code)}">复制推荐码</button>` : ''}
    </div>`).join('') : '<div class="empty">暂无推荐码</div>';
    $$('.copy-code').forEach(button => button.onclick = async () => {
      try {
        await copyText(button.dataset.code);
        toast('推荐码已复制');
      } catch (_) {
        showCopyFallback(button.dataset.code);
      }
    });
  } catch (_) {}
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'absolute';
  input.style.left = '-9999px';
  input.style.top = `${window.scrollY}px`;
  document.body.appendChild(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

function showCopyFallback(code) {
  showModal('复制推荐码', `<p>浏览器阻止了自动复制，请按 Ctrl+C 复制。</p><input id="copy-code-fallback" value="${escapeHtml(code)}" readonly>`);
  const input = $('#copy-code-fallback');
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
}

async function loadInvites(page = invitePage) {
  const data = await api(`/api/invites?page=${page}&pageSize=50`);
  const invites = data.invites;
  invitePage = data.pagination.page;
  $('#invites-table').innerHTML = `<table><thead><tr><th>推荐码</th><th>所属用户</th><th>状态</th><th>关联注册用户</th><th>创建/使用时间</th><th>操作</th></tr></thead><tbody>${invites.map(item => `<tr>
    <td><code>${escapeHtml(item.code)}</code></td>
    <td>${escapeHtml(item.owner?.displayName || '未知')}<br><small>@${escapeHtml(item.owner?.username || '-')}</small></td>
    <td><span class="badge ${item.status === 'available' ? 'on' : item.status === 'disabled' ? 'off' : ''}">${item.status === 'available' ? '可用' : item.status === 'used' ? '已使用' : '已停用'}</span></td>
    <td>${item.usedBy ? `${escapeHtml(item.usedBy.displayName)}<br><small>@${escapeHtml(item.usedBy.username)}</small>` : '—'}</td>
    <td>${new Date(item.createdAt).toLocaleString()}${item.usedAt ? `<br><small>使用：${new Date(item.usedAt).toLocaleString()}</small>` : ''}</td>
    <td>${item.status !== 'used' ? `<button class="link-btn toggle-invite" data-id="${item.id}" data-active="${item.active}">${item.active ? '停用' : '启用'}</button>` : '—'}</td>
  </tr>`).join('')}</tbody></table>`;
  $$('.toggle-invite').forEach(button => button.onclick = async () => {
    try {
      const data = await api(`/api/invites/${button.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      toast(data.message);
      loadUsers();
    } catch (error) { toast(error.message, true); }
  });
  $('#invites-pagination').innerHTML = `<span>共 ${data.pagination.total} 个</span><button id="invite-prev"${data.pagination.page <= 1 ? ' disabled' : ''}>‹</button><span>${data.pagination.page} / ${data.pagination.totalPages}</span><button id="invite-next"${data.pagination.page >= data.pagination.totalPages ? ' disabled' : ''}>›</button>`;
  $('#invite-prev').onclick = () => loadInvites(data.pagination.page - 1);
  $('#invite-next').onclick = () => loadInvites(data.pagination.page + 1);
  $('#create-invites').onclick = () => {
    openCreateInviteForm();
  };
}

async function openCreateInviteForm() {
  try {
    const users = (await api('/api/user-options')).users;
    showModal('生成推荐码', `<form id="invite-form"><label>所属用户<select name="ownerUserId">${users.map(user => `<option value="${user.id}">${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</option>`).join('')}</select></label><label>生成数量<input name="count" type="number" min="1" max="20" value="1" required></label><button class="primary">确认生成</button></form>`);
    $('#invite-form').onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target));
      payload.count = Number(payload.count);
      try { const data = await api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); $('#modal').close(); toast(data.message); loadUsers(); } catch (error) { toast(error.message, true); }
    };
  } catch (error) { toast(error.message, true); }
}

function showModal(title, body) {
  $('#modal').classList.remove('wide');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal').showModal();
}
function showWideModal(title, body) {
  $('#modal').classList.add('wide');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal').showModal();
}
$('.dialog-close').onclick = () => $('#modal').close();

function remoteAdminHeaders(extra = {}) {
  return { ...extra, 'X-Remote-Reauth-Token': remoteAdminReauthToken };
}

function requestRemoteReauth({ purpose, sessionId = '', title = '远程会话二次验证', description = '为了保护服务器 Shell，请输入当前账号密码后继续。' }) {
  return new Promise((resolve, reject) => {
    showModal(title, `<form id="remote-reauth-form">
      <p class="form-help">${escapeHtml(description)}</p>
      <label>当前账号密码<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <button class="primary">确认继续</button>
    </form>`);
    const modal = $('#modal');
    let settled = false;
    const cleanup = () => modal.removeEventListener('close', onClose);
    const onClose = () => {
      cleanup();
      if (!settled) reject(new Error('已取消二次认证'));
    };
    modal.addEventListener('close', onClose);
    $('#remote-reauth-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const password = new FormData(event.target).get('password');
        const data = await api('/api/remote-reauth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose, sessionId, password })
        });
        settled = true;
        cleanup();
        modal.close();
        resolve(data.token);
      } catch (error) {
        toast(error.message, true);
      }
    };
  });
}

function editUser(user) {
  showModal('编辑用户', `<form id="edit-user-form">
    <label>姓名<input name="displayName" value="${escapeHtml(user.displayName)}"></label>
    <label>用户组<input name="groupPath" value="${escapeHtml(user.groupPath || '')}" placeholder="例如：运维/一线"></label>
    <label>角色<select name="role"><option value="user"${user.role === 'user' ? ' selected' : ''}>普通用户</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>管理员</option></select></label>
    <label>状态<select name="active"><option value="true"${user.active ? ' selected' : ''}>正常</option><option value="false"${!user.active ? ' selected' : ''}>停用</option></select></label>
    <label>重置密码<input name="newPassword" type="password" placeholder="留空则不修改"></label>
    <button class="primary">保存更改</button></form>`);
  $('#edit-user-form').onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.active = data.active === 'true';
    try { await api(`/api/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); $('#modal').close(); toast('用户已更新'); loadUsers(); } catch (error) { toast(error.message, true); }
  };
}

async function deleteUser(user) {
  if (!user) return;
  if (me && user.id === me.id) {
    toast('不能删除当前登录账号', true);
    return;
  }
  if (!confirm(`确认删除用户 ${user.displayName}（@${user.username}）？\n\n删除后该用户不能登录，也不会再出现在用户列表中；推荐链路历史会保留。`)) return;
  try {
    const data = await api(`/api/users/${user.id}`, { method: 'DELETE' });
    toast(data.message || '用户已删除');
    await loadUsers();
    await loadDashboard();
  } catch (error) {
    toast(error.message, true);
  }
}

$('#change-password').onclick = () => {
  showModal('修改我的密码', `<form id="password-form"><label>当前密码<input name="currentPassword" type="password" required></label><label>新密码<input name="newPassword" type="password" minlength="8" required></label><button class="primary">确认修改</button></form>`);
  $('#password-form').onsubmit = async event => {
    event.preventDefault();
    try { const data = await submitJson('/api/me/password', 'PUT', event.target); $('#modal').close(); toast(data.message); } catch (error) { toast(error.message, true); }
  };
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtDuration(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days} 天 ` : ''}${hours} 小时 ${minutes} 分`;
}

const auditActionLabels = {
  REGISTER: '用户注册',
  LOGIN: '登录成功',
  LOGIN_FAILED: '登录失败',
  LOGOUT: '退出登录',
  PASSWORD_CHANGED: '修改密码',
  INVITES_CREATED: '生成推荐码',
  INVITE_ENABLED: '启用推荐码',
  INVITE_DISABLED: '停用推荐码',
  USER_UPDATED: '修改用户',
  USER_PASSWORD_RESET: '重置用户密码',
  USER_DELETED: '删除用户',
  REMOTE_SESSION_CREATED: '新增远程会话',
  REMOTE_SESSION_UPDATED: '修改远程会话',
  REMOTE_SESSION_DELETED: '删除远程会话',
  SSH_CONNECTED: '远程连接成功',
  SSH_FAILED: '远程连接失败',
  FILES_UPLOADED: '文件上传',
  FILE_DOWNLOADED: '文件下载',
  FILE_DELETED: '文件删除',
  FOLDER_CREATED: '新建文件夹'
};

function auditLabel(action) {
  return auditActionLabels[action] || action || '-';
}

function toIsoFromLocal(value, endOfMinute = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (endOfMinute) date.setSeconds(59, 999);
  return date.toISOString();
}

async function loadAuditLogs(page = auditPage) {
  if (me.role !== 'admin') return;
  try {
    const params = new URLSearchParams({
      page,
      pageSize: 30,
      q: auditQuery,
      username: auditUsername,
      action: auditAction,
      from: auditFrom,
      to: auditTo
    });
    const data = await api(`/api/admin/audit-logs?${params.toString()}`);
    auditPage = data.pagination.page;
    const actionSelect = $('#audit-action');
    if (actionSelect) {
      const current = actionSelect.value || auditAction;
      actionSelect.innerHTML = `<option value="">全部动作</option>${data.actions.map(action => `<option value="${escapeHtml(action)}"${action === current ? ' selected' : ''}>${escapeHtml(auditLabel(action))}</option>`).join('')}`;
    }
    $('#audit-total').textContent = `共 ${data.pagination.total} 条`;
    $('#audit-table').innerHTML = data.logs.length ? `<table><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>详情</th><th>来源</th></tr></thead><tbody>${data.logs.map(item => `<tr>
      <td>${item.createdAt ? new Date(item.createdAt).toLocaleString() : '-'}</td>
      <td>${escapeHtml(item.username || '-')}</td>
      <td><span class="badge">${escapeHtml(auditLabel(item.action))}</span><br><small>${escapeHtml(item.action || '')}</small></td>
      <td class="audit-detail">${escapeHtml(item.detail || '-')}</td>
      <td>${escapeHtml(item.ip || '-')}<br><small title="${escapeHtml(item.userAgent || '')}">${escapeHtml(item.userAgent || '').slice(0, 80) || '-'}</small></td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">没有找到匹配日志</div>';
    $('#audit-pagination').innerHTML = `<span>第 ${data.pagination.page} / ${data.pagination.totalPages} 页</span><button data-audit-page="${data.pagination.page - 1}"${data.pagination.page <= 1 ? ' disabled' : ''}>上一页</button><button data-audit-page="${data.pagination.page + 1}"${data.pagination.page >= data.pagination.totalPages ? ' disabled' : ''}>下一页</button>`;
    $$('[data-audit-page]').forEach(button => button.onclick = () => loadAuditLogs(Number(button.dataset.auditPage)));
  } catch (error) {
    toast(error.message, true);
  }
}

function resourceCard(title, value, sub, percent = null) {
  const safePercent = percent === null ? null : Math.max(0, Math.min(100, Number(percent) || 0));
  return `<article class="resource-card"><small>${title}</small><b>${value}</b><span>${sub}</span>${safePercent === null ? '' : `<div class="meter"><i style="width:${safePercent}%"></i></div>`}</article>`;
}

async function loadResources() {
  try {
    const data = await api('/api/server-resources');
    $('#resource-summary').textContent = `${data.host.hostname} · ${data.host.platform} ${data.host.release} · 采集时间 ${new Date(data.collectedAt).toLocaleString()}`;
    $('#resource-cards').innerHTML = [
      resourceCard('CPU 负载', `${data.cpu.loadPercent}%`, `${data.cpu.cores} 核 · 1分钟负载 ${data.cpu.loadAverage[0].toFixed(2)}`, data.cpu.loadPercent),
      resourceCard('内存使用', `${data.memory.percent}%`, `${fmtBytes(data.memory.used)} / ${fmtBytes(data.memory.total)}`, data.memory.percent),
      resourceCard('文件磁盘', data.disk.error ? '不可用' : `${data.disk.percent}%`, data.disk.error || `${fmtBytes(data.disk.used)} / ${fmtBytes(data.disk.size)}`, data.disk.error ? null : data.disk.percent),
      resourceCard('用户文件', `${data.userFiles.files} 个`, `总大小 ${fmtBytes(data.userFiles.size)} · ${data.userFiles.directories} 个目录`)
    ].join('');
    $('#resource-detail').innerHTML = `<table><tbody>
      <tr><th>主机名</th><td>${escapeHtml(data.host.hostname)}</td></tr>
      <tr><th>系统</th><td>${escapeHtml(`${data.host.platform} ${data.host.release} ${data.host.arch}`)}</td></tr>
      <tr><th>服务器运行时间</th><td>${fmtDuration(data.host.uptimeSeconds)}</td></tr>
      <tr><th>CPU 型号</th><td>${escapeHtml(data.cpu.model)}</td></tr>
      <tr><th>平均负载</th><td>${data.cpu.loadAverage.map(item => item.toFixed(2)).join(' / ')}</td></tr>
      <tr><th>磁盘路径</th><td>${escapeHtml(data.disk.path || '-')}</td></tr>
      <tr><th>用户文件目录</th><td>${escapeHtml(data.userFiles.path || '-')}</td></tr>
      <tr><th>用户文件统计</th><td>${data.userFiles.files} 个文件，${data.userFiles.directories} 个目录，总大小 ${fmtBytes(data.userFiles.size)}</td></tr>
    </tbody></table>`;
  } catch (error) {
    $('#resource-cards').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    $('#resource-detail').innerHTML = '';
    toast(error.message, true);
  }
}

async function loadFiles(path = currentPath) {
  try {
    const data = await api(`/api/files?scope=${encodeURIComponent(fileScope)}&path=${encodeURIComponent(path)}`);
    currentPath = data.path;
    $('#file-scope-toggle').hidden = me.role !== 'admin';
    $('#file-scope-toggle').textContent = fileScope === 'all' ? '只看我的文件' : '查看全部用户文件';
    $('#new-folder').disabled = fileScope === 'all' && !currentPath;
    $('#file-upload').disabled = fileScope === 'all' && !currentPath;
    $('#file-path').textContent = `${fileScope === 'all' ? '全部用户文件' : '我的文件'} / ${currentPath}`;
    const parent = currentPath.split('/').slice(0, -1).join('/');
    const rows = currentPath ? `<tr><td colspan="4"><button class="link-btn folder-open" data-path="${escapeHtml(parent)}">返回上级</button></td></tr>` : '';
    $('#files-table').innerHTML = `<table><thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead><tbody>${rows}${data.items.map(item => {
      const full = [currentPath, item.name].filter(Boolean).join('/');
      const label = item.displayName || item.name;
      return `<tr><td><div class="file-name"><span class="file-icon">${item.type === 'directory' ? '▰' : '▤'}</span>${item.type === 'directory' ? `<button class="link-btn folder-open" data-path="${escapeHtml(full)}">${escapeHtml(label)}</button>` : escapeHtml(label)}</div></td><td>${item.type === 'directory' ? '—' : fmtSize(item.size)}</td><td>${new Date(item.modifiedAt).toLocaleString()}</td><td>${item.type === 'file' ? `<a class="link-btn" href="/api/files/download?scope=${encodeURIComponent(fileScope)}&path=${encodeURIComponent(full)}">下载</a>` : ''}<button class="link-btn file-delete" data-path="${escapeHtml(full)}">删除</button></td></tr>`;
    }).join('') || (!currentPath ? `<tr><td colspan="4" class="empty">${fileScope === 'all' ? '暂无用户文件目录' : '还没有文件，拖放一个进来吧'}</td></tr>` : '')}</tbody></table>`;
    $$('.folder-open').forEach(button => button.onclick = () => loadFiles(button.dataset.path));
    $$('.file-delete').forEach(button => button.onclick = async () => {
      if (!confirm('确认删除？非空文件夹不会被删除。')) return;
      try { await api(`/api/files?scope=${encodeURIComponent(fileScope)}&path=${encodeURIComponent(button.dataset.path)}`, { method: 'DELETE' }); toast('已删除'); loadFiles(); } catch (error) { toast(error.message, true); }
    });
  } catch (error) { toast(error.message, true); }
}

async function uploadFiles(files) {
  if (!files.length) return;
  const body = new FormData();
  [...files].forEach(file => body.append('files', file));
  try { const data = await api(`/api/files/upload?scope=${encodeURIComponent(fileScope)}&path=${encodeURIComponent(currentPath)}`, { method: 'POST', body }); toast(data.message); loadFiles(); } catch (error) { toast(error.message, true); }
}
$('#file-upload').onchange = event => uploadFiles(event.target.files);
$('#file-scope-toggle').onclick = () => {
  fileScope = fileScope === 'all' ? 'mine' : 'all';
  currentPath = '';
  loadFiles('');
};
$('#refresh-resources').onclick = loadResources;
const drop = $('#drop-zone');
function isFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}
['dragenter', 'dragover'].forEach(name => {
  window.addEventListener(name, event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (!$('#page-files').classList.contains('active')) return;
    event.dataTransfer.dropEffect = 'copy';
    drop.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach(name => {
  window.addEventListener(name, event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    drop.classList.remove('drag');
  });
});
window.addEventListener('drop', event => {
  if (!isFileDrag(event) || !$('#page-files').classList.contains('active')) return;
  uploadFiles(event.dataTransfer.files);
});
$('#new-folder').onclick = () => {
  showModal('新建文件夹', `<form id="folder-form"><label>文件夹名称<input name="name" required autofocus></label><button class="primary">创建</button></form>`);
  $('#folder-form').onsubmit = async event => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    try { await api('/api/files/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: fileScope, path: currentPath, name }) }); $('#modal').close(); toast('文件夹已创建'); loadFiles(); } catch (error) { toast(error.message, true); }
  };
};

terminal.open($('#terminal'));
fit.fit();
terminal.writeln('\x1b[38;5;110m云枢安全终端\x1b[0m');
terminal.writeln('请从左侧选择已授权的远程会话。\r\n');
terminal.onData(data => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'data', data })));
window.addEventListener('resize', () => { fit.fit(); socket?.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); });

function remoteGroupLabel(groupPath) {
  return groupPath ? groupPath.split('/').map(escapeHtml).join(' / ') : '默认分组';
}

function renderSessionItems(sessions) {
  if (!sessions.length) return '<div class="empty">暂无可用会话，请联系管理员授权</div>';
  const groups = new Map();
  sessions.forEach(item => {
    const key = item.groupPath || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.entries()].map(([group, items]) => `<section class="session-group"><div class="session-group-title"><span>${remoteGroupLabel(group)}</span><em>${items.length} 个会话</em></div>${items.map(item => `<button class="session-item connect-session" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
      <i>⌘</i><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.username)}@${escapeHtml(item.host)}:${item.port}${item.connectionMode === 'jump' ? ` · 经由 ${escapeHtml(item.jumpSessionName || '跳板会话')}` : ''}</small></span><em>连接 ›</em>
    </button>`).join('')}</section>`).join('');
}

async function loadRemoteSessions() {
  try {
    const sessions = (await api('/api/remote-sessions')).sessions;
    $('#remote-session-list').innerHTML = renderSessionItems(sessions);
    $$('.connect-session').forEach(button => button.onclick = () => connectRemoteSession(button.dataset.id, button.dataset.name));
    if (me.role === 'admin') $('#add-remote-session').hidden = false;
  } catch (error) { toast(error.message, true); }
}

async function openRemoteSessionManager(page = remoteAdminPage, authenticated = false) {
  if (!authenticated) {
    remoteAdminReauthToken = await requestRemoteReauth({
      purpose: 'admin',
      title: '配置会话二次验证',
      description: '远程会话配置会影响服务器访问权限，请输入当前账号密码后继续。'
    });
  }
  remoteAdminPage = page;
  showWideModal('远程会话配置', `<div class="remote-manager">
    <div class="remote-manager-toolbar">
      <input id="remote-admin-search" placeholder="搜索会话名称、分组、主机或用户" value="${escapeHtml(remoteAdminQuery)}">
      <select id="remote-admin-group"><option value="">全部分组</option></select>
      <button class="secondary" id="remote-admin-search-button">搜索</button>
      <button class="link-btn" id="remote-admin-clear-button">清除</button>
      <button class="primary" id="remote-admin-new-button">新增会话</button>
    </div>
    <div id="remote-admin-tree" class="remote-manager-tree"></div>
    <div id="remote-admin-list" class="remote-manager-list"></div>
    <div id="remote-admin-pagination" class="pagination"></div>
  </div>`);
  await loadAdminRemoteSessions(page);
  $('#remote-admin-search-button').onclick = () => {
    remoteAdminQuery = $('#remote-admin-search').value.trim();
    remoteAdminGroup = $('#remote-admin-group').value;
    loadAdminRemoteSessions(1);
  };
  $('#remote-admin-search').onkeydown = event => {
    if (event.key === 'Enter') {
      remoteAdminQuery = event.target.value.trim();
      remoteAdminGroup = $('#remote-admin-group').value;
      loadAdminRemoteSessions(1);
    }
  };
  $('#remote-admin-group').onchange = event => {
    remoteAdminGroup = event.target.value;
    loadAdminRemoteSessions(1);
  };
  $('#remote-admin-clear-button').onclick = () => {
    remoteAdminQuery = '';
    remoteAdminGroup = '';
    $('#remote-admin-search').value = '';
    loadAdminRemoteSessions(1);
  };
  $('#remote-admin-new-button').onclick = () => openRemoteSessionForm();
}

function renderRemoteGroupTree(groups) {
  const all = [''];
  groups.forEach(group => {
    const parts = group.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) all.push(parts.slice(0, i).join('/'));
  });
  const unique = [...new Set(all)];
  return unique.map(group => `<button class="remote-group-filter ${group === remoteAdminGroup ? 'active' : ''}" data-group="${escapeHtml(group)}">${group ? escapeHtml(group) : '全部分组'}</button>`).join('');
}

async function loadAdminRemoteSessions(page = remoteAdminPage) {
  try {
    const data = await api(`/api/admin/remote-sessions?page=${page}&pageSize=10&q=${encodeURIComponent(remoteAdminQuery)}&group=${encodeURIComponent(remoteAdminGroup)}`, { headers: remoteAdminHeaders() });
    remoteAdminPage = data.pagination.page;
    const groupSelect = $('#remote-admin-group');
    if (groupSelect) {
      const options = ['<option value="">全部分组</option>', ...data.groups.map(group => `<option value="${escapeHtml(group)}"${group === remoteAdminGroup ? ' selected' : ''}>${escapeHtml(group)}</option>`)];
      groupSelect.innerHTML = options.join('');
    }
    $('#remote-admin-tree').innerHTML = renderRemoteGroupTree(data.groups);
    $$('.remote-group-filter').forEach(button => button.onclick = () => {
      remoteAdminGroup = button.dataset.group;
      loadAdminRemoteSessions(1);
    });
    const sessions = data.sessions;
    $('#remote-admin-list').innerHTML = sessions.length ? sessions.map(item => `<article class="remote-admin-card">
      <div><small>${remoteGroupLabel(item.groupPath)}</small><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.username)}@${escapeHtml(item.host)}:${item.port}${item.connectionMode === 'jump' ? `<br><small>经由：${escapeHtml(item.jumpSessionName || '未找到跳板')}</small>` : ''}</p></div>
      <div class="remote-admin-meta"><span class="badge">${item.authType === 'privateKey' ? '私钥' : '密码'}</span><span class="badge">${item.connectionMode === 'jump' ? '跳板' : '直连'}</span><span class="badge ${item.active ? 'on' : 'off'}">${item.active ? '启用' : '停用'}</span></div>
      <div class="remote-admin-users">${[...(item.allowedGroupPaths || []).map(group => `<span class="group">组：${escapeHtml(group)}</span>`), ...item.allowedUsers.map(user => `<span>${escapeHtml(user.displayName)}</span>`)].join('') || '<span>仅管理员</span>'}</div>
      <div class="remote-admin-actions"><button class="link-btn edit-remote-session" data-id="${item.id}">编辑</button><button class="link-btn danger delete-remote-session" data-id="${item.id}">删除</button></div>
    </article>`).join('') : '<div class="empty">没有找到匹配的远程会话</div>';
    $$('.edit-remote-session').forEach(button => button.onclick = () => openRemoteSessionForm(sessions.find(item => item.id === button.dataset.id)));
    $$('.delete-remote-session').forEach(button => button.onclick = async () => {
      if (!confirm('确认删除此远程会话？')) return;
      try {
        const result = await api(`/api/admin/remote-sessions/${button.dataset.id}`, { method: 'DELETE', headers: remoteAdminHeaders() });
        toast(result.message);
        await loadAdminRemoteSessions(remoteAdminPage);
        await loadRemoteSessions();
      } catch (error) { toast(error.message, true); }
    });
    $('#remote-admin-pagination').innerHTML = `<span>共 ${data.pagination.total} 条</span><button data-remote-page="${data.pagination.page - 1}"${data.pagination.page <= 1 ? ' disabled' : ''}>‹</button><span>${data.pagination.page} / ${data.pagination.totalPages}</span><button data-remote-page="${data.pagination.page + 1}"${data.pagination.page >= data.pagination.totalPages ? ' disabled' : ''}>›</button>`;
    $$('[data-remote-page]').forEach(button => button.onclick = () => loadAdminRemoteSessions(Number(button.dataset.remotePage)));
  } catch (error) { toast(error.message, true); }
}

async function openRemoteSessionForm(item = null) {
  try {
    const userOptions = await api('/api/user-options');
    const users = userOptions.users;
    const groups = userOptions.groups || [];
    const jumpSessions = (await api(`/api/admin/remote-session-options${item ? `?excludeId=${encodeURIComponent(item.id)}` : ''}`, { headers: remoteAdminHeaders() })).sessions;
    const selected = new Set(item?.allowedUserIds || []);
    const selectedGroups = new Set(item?.allowedGroupPaths || []);
    const connectionMode = item?.connectionMode === 'jump' ? 'jump' : 'direct';
    showWideModal(item ? '编辑远程会话' : '新增远程会话', `<form id="remote-session-form" class="remote-session-form" data-auth-type="${item?.authType || 'password'}" data-connection-mode="${connectionMode}">
      <div class="two"><label>分组路径<input name="groupPath" value="${escapeHtml(item?.groupPath || '')}" placeholder="例如：生产/数据库"></label><label>会话名称<input name="name" value="${escapeHtml(item?.name || '')}" placeholder="例如：控制服务器" required></label></div>
      <div class="two"><label>主机地址<input name="host" value="${escapeHtml(item?.host || '127.0.0.1')}" required><small class="form-help">访问本 Web 服务器自身请填 127.0.0.1 或 localhost；公网地址需加入直连白名单。</small></label><label>端口<input name="port" type="number" value="${item?.port || 22}" required></label></div>
      <label>登录用户名<input name="username" value="${escapeHtml(item?.username || 'qtest')}" required></label>
      <div class="two"><label>连接方式<select name="connectionMode"><option value="direct"${connectionMode !== 'jump' ? ' selected' : ''}>直接连接</option><option value="jump"${connectionMode === 'jump' ? ' selected' : ''}>通过跳板会话</option></select></label>
      <label class="jump-session-field">跳板会话<select name="jumpSessionId"><option value="">请选择跳板会话</option>${jumpSessions.map(session => `<option value="${session.id}"${item?.jumpSessionId === session.id ? ' selected' : ''}>${escapeHtml(session.groupPath ? `${session.groupPath}/` : '')}${escapeHtml(session.name)}（${escapeHtml(session.username)}@${escapeHtml(session.host)}:${session.port}）</option>`).join('')}</select></label></div>
      <label>认证方式<select name="authType"><option value="password"${item?.authType !== 'privateKey' ? ' selected' : ''}>密码</option><option value="privateKey"${item?.authType === 'privateKey' ? ' selected' : ''}>私钥</option></select></label>
      <label class="credential-password">登录密码<input name="passwordCredential" type="password" placeholder="${item ? '留空则保持原密码' : '请输入 SSH 登录密码'}"></label>
      <label class="credential-private">SSH 私钥<textarea name="privateKeyCredential" rows="6" placeholder="${item ? '留空则保持原私钥' : '-----BEGIN OPENSSH PRIVATE KEY-----'}"></textarea></label>
      <label>授权用户组<div class="user-grants group-grants">${groups.length ? groups.map(group => `<label><input type="checkbox" name="allowedGroupPaths" value="${escapeHtml(group)}"${selectedGroups.has(group) ? ' checked' : ''}> ${escapeHtml(group)}</label>`).join('') : '<p class="empty-mini">暂无用户组，可先在用户管理中设置用户组</p>'}</div><small class="form-help">授权给上级组时，子组用户也会获得会话权限，例如“运维”包含“运维/一线”。</small></label>
      <label>授权用户<div class="user-grants">${users.map(user => `<label><input type="checkbox" name="allowedUserIds" value="${user.id}"${selected.has(user.id) ? ' checked' : ''}> ${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</label>`).join('')}</div></label>
      <label>状态<select name="active"><option value="true"${item?.active !== false ? ' selected' : ''}>启用</option><option value="false"${item?.active === false ? ' selected' : ''}>停用</option></select></label>
      <div id="remote-session-error" class="form-error"></div>
      <button class="primary">${item ? '保存修改' : '创建会话'}</button>
    </form>`);
    const form = $('#remote-session-form');
    form.querySelector('[name="authType"]').onchange = event => form.dataset.authType = event.target.value;
    form.querySelector('[name="connectionMode"]').onchange = event => form.dataset.connectionMode = event.target.value;
    form.onsubmit = async event => {
      event.preventDefault();
      const errorBox = $('#remote-session-error');
      errorBox.className = 'form-error';
      errorBox.textContent = '';
      const formData = new FormData(form);
      const authType = formData.get('authType');
      const payload = {
        groupPath: formData.get('groupPath'), name: formData.get('name'), host: formData.get('host'), port: Number(formData.get('port')),
        username: formData.get('username'), authType,
        connectionMode: formData.get('connectionMode'),
        jumpSessionId: formData.get('jumpSessionId'),
        credential: formData.get(authType === 'privateKey' ? 'privateKeyCredential' : 'passwordCredential'),
        allowedUserIds: formData.getAll('allowedUserIds'),
        allowedGroupPaths: formData.getAll('allowedGroupPaths'),
        active: formData.get('active') === 'true'
      };
      try {
        await api(item ? `/api/admin/remote-sessions/${item.id}` : '/api/admin/remote-sessions', {
          method: item ? 'PATCH' : 'POST', headers: remoteAdminHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload)
        });
        toast(item ? '会话已更新' : '会话已创建');
        await openRemoteSessionManager(remoteAdminPage, true);
        await loadRemoteSessions();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.className = 'form-error show';
        toast(error.message, true);
      }
    };
  } catch (error) { toast(error.message, true); }
}

function editRemoteSession(item) { openRemoteSessionForm(item); }
$('#add-remote-session').onclick = async () => {
  try { await openRemoteSessionManager(1); } catch (error) { toast(error.message, true); }
};
async function connectRemoteSession(sessionId, name) {
  let reauthToken = '';
  try {
    reauthToken = await requestRemoteReauth({
      purpose: 'connect',
      sessionId,
      title: '远程连接二次验证',
      description: `即将连接远程会话「${name}」。为了保护服务器 Shell，请输入当前账号密码。`
    });
  } catch (error) {
    toast(error.message, true);
    return;
  }
  if (socket) socket.close();
  terminal.clear();
  terminal.writeln(`\x1b[33m正在连接会话「${name}」...\x1b[0m`);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'connect', sessionId, reauthToken, cols: terminal.cols, rows: terminal.rows }));
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'data') terminal.write(message.data);
    if (message.type === 'ready') { $('#terminal-title').textContent = `${message.name} · ${message.target}`; terminal.focus(); toast('SSH 已连接'); }
    if (message.type === 'error') { terminal.writeln(`\r\n\x1b[31m连接失败：${message.message}\x1b[0m`); toast(message.message, true); }
  };
  socket.onclose = () => { terminal.writeln('\r\n\x1b[90m连接已断开\x1b[0m'); $('#terminal-title').textContent = '尚未连接'; };
}
$('#terminal-close').onclick = () => socket?.close();

function applyRemotePanelState(collapsed) {
  $('.remote-grid').classList.toggle('sessions-collapsed', collapsed);
  $('#remote-panel-collapse').title = collapsed ? '显示会话面板' : '隐藏会话面板';
  const titleCollapse = $('#remote-panel-title-collapse');
  if (titleCollapse) titleCollapse.hidden = collapsed;
  setTimeout(() => { fit.fit(); window.dispatchEvent(new Event('resize')); }, 220);
}
applyRemotePanelState(localStorage.getItem('remotePanelCollapsed') === '1');
function toggleRemotePanel() {
  const collapsed = !$('.remote-grid').classList.contains('sessions-collapsed');
  localStorage.setItem('remotePanelCollapsed', collapsed ? '1' : '0');
  applyRemotePanelState(collapsed);
}
$('#remote-panel-collapse').onclick = toggleRemotePanel;
if ($('#remote-panel-title-collapse')) $('#remote-panel-title-collapse').onclick = toggleRemotePanel;

if ($('#audit-search-button')) $('#audit-search-button').onclick = () => {
  auditQuery = $('#audit-search').value.trim();
  auditUsername = $('#audit-username').value.trim();
  auditAction = $('#audit-action').value;
  auditFrom = toIsoFromLocal($('#audit-from').value);
  auditTo = toIsoFromLocal($('#audit-to').value, true);
  loadAuditLogs(1);
};
if ($('#audit-search')) $('#audit-search').onkeydown = event => {
  if (event.key === 'Enter') $('#audit-search-button').click();
};
if ($('#audit-username')) $('#audit-username').onkeydown = event => {
  if (event.key === 'Enter') $('#audit-search-button').click();
};
if ($('#audit-action')) $('#audit-action').onchange = event => {
  auditAction = event.target.value;
  loadAuditLogs(1);
};
if ($('#audit-refresh')) $('#audit-refresh').onclick = () => loadAuditLogs(auditPage);
if ($('#audit-clear')) $('#audit-clear').onclick = () => {
  auditQuery = '';
  auditUsername = '';
  auditAction = '';
  auditFrom = '';
  auditTo = '';
  $('#audit-search').value = '';
  $('#audit-username').value = '';
  $('#audit-action').value = '';
  $('#audit-from').value = '';
  $('#audit-to').value = '';
  loadAuditLogs(1);
};

loadRegistrationStatus();
updateCaptchaPolicy('login');
updateCaptchaPolicy('register');
boot();

