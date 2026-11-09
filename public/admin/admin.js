// Admin page for the Central User Service (plain JS, no build step).
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ROLE = { nsm: 'NSM', zsm: 'ZSM', rm: 'RM', tm: 'TM', 'bu-head': 'BU Head', admin: 'Admin' };
  const KEY = 'cus_admin_session';

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(KEY)); } catch { /* none */ }
  let divisions = [];

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) { signOut(); throw new Error(data.error || 'Session expired'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function flash(text, isError) {
    const el = $('#flash');
    el.textContent = text;
    el.className = `flash${isError ? ' err' : ''}`;
    el.hidden = false;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { el.hidden = true; }, isError ? 9000 : 5000);
  }
  const guard = (fn) => (...a) => fn(...a).catch((e) => flash(e.message, true));

  // ── Sign in ──
  let otpSent = false;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#loginMsg');
    msg.textContent = '';
    $('#loginBtn').disabled = true;
    const body = { client_id: 'admin-console', mobileno: $('#loginMobile').value };
    try {
      if (!otpSent) {
        const r = await api('/api/auth/otp/request', { method: 'POST', body });
        otpSent = true;
        $('#otpRow').hidden = false;
        $('#loginOtp').focus();
        $('#loginBtn').textContent = 'Verify & sign in';
        msg.style.color = 'var(--good)';
        msg.textContent = `OTP sent to ${r.email}`;
      } else {
        const r = await api('/api/auth/otp/verify', { method: 'POST', body: { ...body, otp: $('#loginOtp').value } });
        session = { token: r.token, user: r.user };
        sessionStorage.setItem(KEY, JSON.stringify(session));
        start();
      }
    } catch (err) {
      msg.style.color = '';
      msg.textContent = err.message;
    } finally {
      $('#loginBtn').disabled = false;
    }
  });

  function signOut() {
    session = null;
    sessionStorage.removeItem(KEY);
    otpSent = false;
    $('#otpRow').hidden = true;
    $('#loginOtp').value = '';
    $('#loginBtn').textContent = 'Send OTP';
    $('#app').hidden = true;
    $('#login').hidden = false;
  }
  $('#logout').addEventListener('click', signOut);

  // ── Tabs ──
  const loaders = {};
  function show(tab) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    loaders[tab]?.();
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  async function loadDivisions() {
    divisions = (await api('/api/admin/divisions')).divisions;
    const opts = divisions.map((d) => `<option value="${esc(d.division_code)}">${esc(d.division_name)} (${esc(d.division_code)})</option>`).join('');
    $('#uDivision').innerHTML = `<option value="">All divisions</option>${opts}`;
    $('#userForm [name=division_code]').innerHTML = `<option value="">—</option>${opts}`;
  }

  // ── Overview ──
  loaders.overview = guard(async () => {
    const s = await api('/api/admin/summary');
    const sum = (k) => s.divisions.reduce((a, d) => a + Number(d[k] || 0), 0);
    $('#kpis').innerHTML = [
      ['Divisions', s.divisions.length], ['NSM', sum('nsm')], ['ZSM', sum('zsm')], ['RM', sum('rm')], ['TM', sum('tm')],
      ['Client apps', s.activeClients], ['Logins (7 days)', s.last7days.logins], ['Failed attempts (7 days)', s.last7days.failures],
    ].map(([l, v]) => `<div class="kpi"><small>${l}</small><b>${v}</b></div>`).join('');
    $('#ovTable').innerHTML = `<tr><th>Division</th><th class="num">NSM</th><th class="num">ZSM</th><th class="num">RM</th><th class="num">TM</th><th class="num">Inactive</th><th class="num">Field rows</th><th>Last sync</th></tr>` +
      s.divisions.map((d) => `<tr><td><b>${esc(d.division_name)}</b><small>${esc(d.division_code)}</small></td>
        <td class="num">${d.nsm}</td><td class="num">${d.zsm}</td><td class="num">${d.rm}</td><td class="num">${d.tm}</td>
        <td class="num">${d.inactive}</td><td class="num">${d.field_rows}</td><td>${fmt(d.last_sync)}</td></tr>`).join('');
  });

  // ── Users ──
  const PAGE = 100;
  let uOffset = 0;
  let uRows = [];
  loaders.users = guard(async () => {
    const p = new URLSearchParams({ q: $('#uQ').value, division_code: $('#uDivision').value, usertype: $('#uType').value, status: $('#uStatus').value, limit: PAGE, offset: uOffset });
    const r = await api(`/api/admin/users?${p}`);
    uRows = r.users;
    $('#uCount').textContent = `${r.total} user${r.total === 1 ? '' : 's'}${r.total > PAGE ? ` · showing ${uOffset + 1}–${uOffset + r.users.length}` : ''}`;
    $('#uTable').innerHTML = `<tr><th>Name</th><th>Role</th><th>Division</th><th>Mobile / email</th><th>Location</th><th>Status</th><th>Last login</th><th></th></tr>` +
      r.users.map((u, i) => `<tr>
        <td><b>${esc(u.name)}</b><small>${esc(u.empcode || '—')} · ${u.source}</small></td>
        <td><span class="pill role">${ROLE[u.usertype] || u.usertype}</span>${u.extra_roles ? ` <span class="pill" title="Additional roles">+${u.extra_roles} role${u.extra_roles === 1 ? '' : 's'}</span>` : ''}${u.is_service_admin ? ' <span class="pill warn" title="Can use this admin page">Service admin</span>' : ''}</td>
        <td>${esc(u.division_name || '—')}</td>
        <td>${esc(u.mobileno)}<small>${esc(u.email || 'no email')}</small></td>
        <td>${esc(u.location || '—')}</td>
        <td>${u.is_active ? '<span class="pill good">Active</span>' : `<span class="pill bad">${u.disabled_by_admin ? 'Disabled by admin' : 'Inactive'}</span>`}</td>
        <td>${fmt(u.last_login_at)}</td>
        <td><button class="small ghost" data-edit="${i}">Edit</button>
            <button class="small ${u.is_active ? 'danger' : ''}" data-toggle="${i}">${u.is_active ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
    $('#uPager').innerHTML = (uOffset > 0 ? '<button class="small ghost" data-page="-1">← Previous</button>' : '') +
      (uOffset + PAGE < r.total ? '<button class="small ghost" data-page="1">Next →</button>' : '');
  });
  let searchTimer;
  $('#uQ').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { uOffset = 0; loaders.users(); }, 300); });
  ['#uDivision', '#uType', '#uStatus'].forEach((s) => $(s).addEventListener('change', () => { uOffset = 0; loaders.users(); }));
  $('#uPager').addEventListener('click', (e) => { const d = e.target.dataset.page; if (d) { uOffset = Math.max(0, uOffset + Number(d) * PAGE); loaders.users(); } });
  $('#uTable').addEventListener('click', guard(async (e) => {
    const t = e.target;
    if (t.dataset.edit !== undefined) return await openUser(uRows[t.dataset.edit]);
    if (t.dataset.toggle !== undefined) {
      const u = uRows[t.dataset.toggle];
      if (u.is_active && !confirm(`Disable ${u.name}? They will not be able to sign in to any app.`)) return;
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } });
      flash(`${u.name} ${u.is_active ? 'disabled' : 'enabled'}.`);
      loaders.users();
    }
  }));

  // ── Additional roles (user dialog) ──
  let appList = [];
  const roleOpts = (sel) => Object.entries(ROLE).map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  const divOpts = (sel) => '<option value="">Division…</option>' + divisions
    .map((d) => `<option value="${esc(d.division_code)}"${d.division_code === sel ? ' selected' : ''}>${esc(d.division_name)} (${esc(d.division_code)})</option>`).join('');
  function addRoleRow(r = {}) {
    const row = document.createElement('div');
    row.className = 'roleRow';
    const ticked = new Set(r.client_ids || []);
    row.innerHTML = `<select data-k="usertype" aria-label="Role">${roleOpts(r.usertype || 'bu-head')}</select>
      <select data-k="division_code" aria-label="Division">${divOpts(r.division_code)}</select>
      <input data-k="sap_code" placeholder="SAP codes (optional)" value="${esc(r.sap_code || '')}" />
      <button type="button" class="small danger" data-remove>Remove</button>
      <div class="apps">${appList.map((c) => `<label><input type="checkbox" value="${esc(c.client_id)}"${ticked.has(c.client_id) ? ' checked' : ''} /> ${esc(c.name)}</label>`).join('') || '<span class="mut">No client apps registered.</span>'}</div>`;
    row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
    $('#rolesBox').append(row);
  }
  $('#roleAdd').addEventListener('click', () => addRoleRow());
  const rolesInForm = () => [...document.querySelectorAll('#rolesBox .roleRow')].map((row) => ({
    usertype: row.querySelector('[data-k=usertype]').value,
    division_code: row.querySelector('[data-k=division_code]').value,
    sap_code: row.querySelector('[data-k=sap_code]').value,
    client_ids: [...row.querySelectorAll('.apps input:checked')].map((i) => i.value),
  }));

  let editing = null;
  async function openUser(u) {
    editing = u || null;
    const f = $('#userForm');
    f.reset();
    $('#userMsg').textContent = '';
    $('#userDlgTitle').textContent = u ? `Edit ${u.name}` : 'Add user';
    $('#userDlgNote').textContent = u && u.source === 'infinity'
      ? 'This account comes from Infinity: the next sync overwrites name, role, division, mobile, email and location. Change them in Infinity for a lasting fix.'
      : 'Field users normally come from the Infinity sync; add people by hand only if they are missing there.';
    if (u) for (const k of ['name', 'usertype', 'division_code', 'empcode', 'mobileno', 'email', 'location', 'sap_code']) f.elements[k].value = u[k] || '';
    f.elements.is_service_admin.checked = !!u?.is_service_admin;
    $('#rolesBox').innerHTML = '';
    appList = (await api('/api/admin/clients')).clients.filter((c) => c.is_active && c.client_id !== 'admin-console');
    if (u) for (const r of (await api(`/api/admin/users/${u.id}/roles`)).roles) addRoleRow(r);
    $('#userDlg').showModal();
  }
  $('#uAdd').addEventListener('click', guard(() => openUser(null)));
  $('#userCancel').addEventListener('click', () => $('#userDlg').close());
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.is_service_admin = e.target.elements.is_service_admin.checked;
    const roles = rolesInForm();
    try {
      let id = editing?.id;
      if (editing) await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
      else id = (await api('/api/admin/users', { method: 'POST', body })).id;
      await api(`/api/admin/users/${id}/roles`, { method: 'PUT', body: { roles } });
      $('#userDlg').close();
      flash(`${body.name} saved.`);
      loaders.users();
    } catch (err) {
      $('#userMsg').textContent = err.message;
    }
  });

  // ── Divisions & sync ──
  loaders.divisions = guard(async () => {
    await loadDivisions();
    $('#dTable').innerHTML = `<tr><th>Division</th><th>Infinity division id</th><th></th></tr>` +
      divisions.map((d) => `<tr><td><b>${esc(d.division_name)}</b><small>${esc(d.division_code)}</small></td>
        <td>${esc(d.infinity_division_id || '— not set')}</td>
        <td><button class="small" data-synapse="${esc(d.division_code)}">Sync from Synapse</button>
            <button class="small ghost" data-sync="${esc(d.division_code)}" ${d.infinity_division_id ? '' : 'disabled title="Set the Infinity division id first"'}>Sync from Infinity</button>
            <button class="small ghost" data-rebuild="${esc(d.division_code)}">Rebuild accounts</button>
            <button class="small link" data-editdiv="${esc(d.division_code)}">Edit</button></td></tr>`).join('');
    const h = (await api('/api/admin/sync-history')).history;
    $('#sTable').innerHTML = `<tr><th>When</th><th>Type</th><th>Division</th><th>Status</th><th class="num">Records</th><th class="num">Skipped</th><th class="num">Deactivated</th><th>By / error</th></tr>` +
      h.map((s) => `<tr><td>${fmt(s.run_at)}</td><td>${esc(s.sync_type)}</td><td>${esc(s.division_code || '—')}</td>
        <td><span class="pill ${s.status === 'success' ? 'good' : 'bad'}">${esc(s.status)}</span></td>
        <td class="num">${s.record_count ?? '—'}</td><td class="num" title="${esc((s.details?.skipped || []).map((x) => `${x.empcode} ${x.name}: ${x.reason}`).join('\n'))}">${s.skipped_count ?? '—'}</td>
        <td class="num">${s.deactivated_count ?? '—'}</td><td>${esc(s.error_message || s.run_by_name || '')}</td></tr>`).join('');
  });
  $('#dTable').addEventListener('click', guard(async (e) => {
    const t = e.target;
    const code = t.dataset.synapse || t.dataset.sync || t.dataset.rebuild;
    if (t.dataset.editdiv) {
      const d = divisions.find((x) => x.division_code === t.dataset.editdiv);
      const f = $('#dForm');
      for (const k of ['division_code', 'division_name', 'infinity_division_id']) f.elements[k].value = d[k] || '';
      return f.elements.division_name.focus();
    }
    if (!code) return;
    const mode = t.dataset.synapse ? 'synapse' : t.dataset.sync ? 'infinity' : 'rebuild';
    const what = { synapse: `Sync division ${code} from Synapse now?`, infinity: `Sync division ${code} from the Infinity API now?`, rebuild: `Rebuild the accounts of division ${code} from the stored field structure?` };
    if (!confirm(what[mode])) return;
    t.disabled = true;
    t.textContent = 'Working…';
    try {
      const r = await api('/api/admin/sync', { method: 'POST', body: { division_code: code, mode } });
      flash(`${code}: ${r.users} accounts updated · ${r.skipped.length} skipped · ${r.deactivated} deactivated${r.field_rows != null ? ` · ${r.field_rows} field rows` : ''}.`);
    } finally {
      loaders.divisions();
    }
  }));
  $('#syncAll').addEventListener('click', guard(async (e) => {
    if (!confirm('Sync every sales division from Synapse now? New divisions are added; people who left are deactivated.')) return;
    e.target.disabled = true;
    e.target.textContent = 'Syncing…';
    try {
      const { results } = await api('/api/admin/sync/synapse-all', { method: 'POST' });
      const failed = results.filter((r) => r.error);
      flash(`${results.length - failed.length} division(s) synced · ${results.reduce((a, r) => a + (r.users || 0), 0)} accounts${failed.length ? ` · failed: ${failed.map((r) => `${r.division_code} (${r.error})`).join(', ')}` : ''}`, failed.length > 0);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Sync all divisions from Synapse';
      loaders.divisions();
    }
  }));
  $('#dForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/api/admin/divisions', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    flash('Division saved.');
    loaders.divisions();
  }));

  // ── Client apps ──
  let clients = [];
  let editingClient = null;
  const showKey = (clientId, key) => {
    $('#keyClient').textContent = clientId;
    $('#keyValue').textContent = key;
    $('#keyDlg').showModal();
  };
  $('#keyCopy').addEventListener('click', () => navigator.clipboard?.writeText($('#keyValue').textContent).then(() => flash('API key copied.')));
  $('#keyClose').addEventListener('click', () => $('#keyDlg').close());

  loaders.clients = guard(async () => {
    clients = (await api('/api/admin/clients')).clients;
    $('#cTable').innerHTML = `<tr><th>App</th><th>Roles</th><th>Divisions</th><th>Origins</th><th>Token</th><th>API key</th><th>Status</th><th></th></tr>` +
      clients.map((c, i) => `<tr><td><b>${esc(c.name)}</b><small>${esc(c.client_id)}</small></td>
        <td>${c.allowed_usertypes.map((t) => ROLE[t] || t).join(', ')}</td><td>${esc(c.allowed_divisions.join(', ') || 'All')}</td>
        <td>${esc(c.allowed_origins.join(', ') || '—')}</td><td>${esc(c.token_ttl)}</td>
        <td>${c.has_api_key ? `<code>${esc(c.api_key_prefix)}…</code>` : '—'}</td>
        <td>${c.is_active ? '<span class="pill good">Active</span>' : '<span class="pill bad">Disabled</span>'}</td>
        <td>${c.client_id === 'admin-console' ? '<small>built-in</small>' : `<button class="small ghost" data-cedit="${i}">Edit</button>
            <button class="small ghost" data-rotate="${i}">New API key</button>
            <button class="small ${c.is_active ? 'danger' : ''}" data-ctoggle="${i}">${c.is_active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('');
  });
  function resetClientForm() {
    editingClient = null;
    $('#cForm').reset();
    $('#cForm').elements.client_id.disabled = false;
    $('#cFormTitle').textContent = 'Register a client app';
    $('#cSave').textContent = 'Register';
    $('#cCancel').hidden = true;
  }
  $('#cCancel').addEventListener('click', resetClientForm);
  $('#cTable').addEventListener('click', guard(async (e) => {
    const t = e.target;
    const c = clients[t.dataset.cedit ?? t.dataset.rotate ?? t.dataset.ctoggle];
    if (!c) return;
    if (t.dataset.cedit !== undefined) {
      editingClient = c;
      const f = $('#cForm');
      f.elements.client_id.value = c.client_id;
      f.elements.client_id.disabled = true;
      f.elements.name.value = c.name;
      f.elements.allowed_usertypes.value = c.allowed_usertypes.join(',');
      f.elements.allowed_divisions.value = c.allowed_divisions.join(',');
      f.elements.allowed_origins.value = c.allowed_origins.join(',');
      f.elements.token_ttl.value = c.token_ttl;
      $('#cFormTitle').textContent = `Edit ${c.name}`;
      $('#cSave').textContent = 'Save changes';
      $('#cCancel').hidden = false;
      return f.scrollIntoView({ behavior: 'smooth' });
    }
    if (t.dataset.rotate !== undefined) {
      if (!confirm(`Issue a new API key for ${c.name}? The current key stops working immediately.`)) return;
      const r = await api(`/api/admin/clients/${c.client_id}/rotate-key`, { method: 'POST' });
      showKey(r.client_id, r.api_key);
      return loaders.clients();
    }
    if (c.is_active && !confirm(`Disable ${c.name}? Nobody can sign in to it until it is enabled again.`)) return;
    await api(`/api/admin/clients/${c.client_id}`, { method: 'PATCH', body: { is_active: !c.is_active } });
    loaders.clients();
  }));
  $('#cForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (editingClient) {
      delete body.client_id;
      await api(`/api/admin/clients/${editingClient.client_id}`, { method: 'PATCH', body });
      flash(`${body.name} saved.`);
    } else {
      const r = await api('/api/admin/clients', { method: 'POST', body });
      showKey(r.client_id, r.api_key);
    }
    resetClientForm();
    loaders.clients();
  }));

  // ── Login history ──
  loaders.history = guard(async () => {
    if (!clients.length) clients = (await api('/api/admin/clients')).clients;
    const sel = $('#hClient');
    if (sel.options.length === 1) sel.innerHTML += clients.map((c) => `<option value="${esc(c.client_id)}">${esc(c.name)}</option>`).join('');
    const p = new URLSearchParams({ q: $('#hQ').value, client_id: sel.value, status: $('#hStatus').value });
    const h = (await api(`/api/admin/login-history?${p}`)).history;
    $('#hTable').innerHTML = `<tr><th>When</th><th>App</th><th>User</th><th>Step</th><th>Status</th><th>Reason</th><th>IP</th></tr>` +
      h.map((r) => `<tr><td>${fmt(r.created_at)}</td><td>${esc(r.client_id || '—')}</td>
        <td><b>${esc(r.name || 'Unknown')}</b><small>${esc(r.mobileno)}${r.usertype ? ` · ${ROLE[r.usertype] || r.usertype}` : ''}${r.empcode ? ` · ${esc(r.empcode)}` : ''}</small></td>
        <td>${r.event === 'otp-verify' ? 'Sign in' : 'OTP request'}</td>
        <td><span class="pill ${r.status === 'success' ? 'good' : 'bad'}">${esc(r.status)}</span></td>
        <td>${esc(r.failure_reason || '')}</td><td><small>${esc(r.ip || '')}</small></td></tr>`).join('') ||
      '<tr><td colspan="7" class="mut">No records.</td></tr>';
  });
  let hTimer;
  $('#hQ').addEventListener('input', () => { clearTimeout(hTimer); hTimer = setTimeout(loaders.history, 300); });
  ['#hClient', '#hStatus'].forEach((s) => $(s).addEventListener('change', loaders.history));

  // ── Start ──
  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#whoName').textContent = session.user.name;
    loadDivisions().catch((e) => flash(e.message, true));
    show('overview');
  }
  if (session) start();
  else $('#login').hidden = false;
})();
