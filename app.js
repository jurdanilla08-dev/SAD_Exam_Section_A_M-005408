/* app.js — dashboard logic (role-gated, policy-driven) */
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $  = (s) => document.querySelector(s);

const ME       = { profile: null };
let PROGRAMS   = {};   // id -> program row
let ALL_SUBS   = [];   // submissions visible to current user
let MY_ASSIGN  = null; // scholar assignment
let EDITING_ID = null; // scholar correction mode

/* ---------------- boot + role gate ---------------- */
(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.replace('index.html'); return; }

  const { data: profile, error } = await sb.from('profiles')
    .select('*').eq('id', session.user.id).single();

  if (error || !profile) {
    alert('No profile record found for this account. Contact the Scholarship Office.');
    await sb.auth.signOut();
    window.location.replace('index.html');
    return;
  }

  ME.profile = profile;
  $('#whoName').textContent = profile.full_name;
  $('#whoRole').textContent = profile.role === 'staff' ? 'Scholarship Staff' : 'Scholar';

  if (profile.role === 'staff') {
    $('#staffView').hidden = false;
    await loadPrograms();
    await loadStaff();
  } else {
    $('#scholarView').hidden = false;
    await loadScholar();
  }
})();

$('#btnLogout').addEventListener('click', async () => {
  await sb.auth.signOut();
  window.location.replace('index.html');
});

/* ---------------- helpers ---------------- */
const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila',
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

const chip = (text, cls) => `<span class="chip ${cls}">${text ?? '—'}</span>`;

function verificationChip(s) {
  const map = { Pending: 'pending', Verified: 'verified', Returned: 'returned' };
  return chip(s.verification_status, map[s.verification_status] || 'none');
}
function complianceChip(s) {
  if (!s.compliance_result) return chip('Not evaluated', 'none');
  const cls = s.compliance_result === 'Compliant' ? 'compliant' : 'deficient';
  return chip(s.compliance_result, cls);
}
function renewalChip(s) {
  if (!s.renewal_decision) return chip('—', 'none');
  const cls = s.renewal_decision === 'Approved' ? 'approved' : 'held';
  return chip(s.renewal_decision, cls);
}
function reasonList(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return '';
  return `<ul class="reasons">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
}

/* ---------------- policy engine (thresholds come from the DB) ---------------- */
function computeCompliance(sub, program) {
  const reasons = [];

  if (sub.verification_status !== 'Verified')
    reasons.push('Evidence is not verified — final evaluation is blocked.');

  if (Number(sub.gwa) > Number(program.max_gwa))
    reasons.push(`GWA ${Number(sub.gwa).toFixed(2)} exceeds the ${program.name} maximum of ${Number(program.max_gwa).toFixed(2)}.`);

  if (sub.enrolled_units < program.min_units)
    reasons.push(`Enrolled units ${sub.enrolled_units} is below the required minimum of ${program.min_units}.`);

  if (sub.failed_count > program.allowed_failed)
    reasons.push(`Failed subjects (${sub.failed_count}) exceeds the allowed maximum of ${program.allowed_failed}.`);

  if (sub.incomplete_count > program.allowed_incomplete)
    reasons.push(`Incomplete grades (${sub.incomplete_count}) exceeds the allowed maximum of ${program.allowed_incomplete}.`);

  if (sub.dropped_count > program.allowed_dropped)
    reasons.push(`Dropped subjects (${sub.dropped_count}) exceeds the allowed maximum of ${program.allowed_dropped}.`);

  if (program.required_evidence && !sub.evidence_ref)
    reasons.push('Missing grade document reference.');

  // Deadline comparison: a submission at the exact deadline is ON TIME.
  const deadline  = new Date(program.deadline).getTime();
  const submitted = new Date(sub.submitted_at).getTime();
  if (submitted > deadline)
    reasons.push(`Late submission — received ${fmtDate(sub.submitted_at)} (Asia/Manila); deadline was ${fmtDate(program.deadline)}.`);

  return { result: reasons.length ? 'With Deficiency' : 'Compliant', reasons };
}

/* ================= SCHOLAR ================= */
async function loadScholar() {
  const { data: asg } = await sb.from('scholar_assignments')
    .select('*, programs(*)')
    .eq('scholar_id', ME.profile.id)
    .order('assigned_at', { ascending: false })
    .limit(1).maybeSingle();

  MY_ASSIGN = asg;
  $('#scholarProgram').textContent = asg
    ? `${asg.programs.name} · max GWA ${Number(asg.programs.max_gwa).toFixed(2)} · ` +
      `min units ${asg.programs.min_units} · deadline ${fmtDate(asg.programs.deadline)}`
    : 'No scholarship program assigned yet — please contact the Scholarship Office.';

  const { data: subs, error } = await sb.from('submissions')
    .select('*').eq('scholar_id', ME.profile.id)
    .order('submitted_at', { ascending: false });

  if (error) { console.error(error); return; }
  renderMine(subs || []);
}

function renderMine(subs) {
  const tb = $('#tblMine tbody');
  if (!subs.length) { tb.innerHTML = `<tr><td colspan="10" class="muted">No submissions yet.</td></tr>`; return; }

  tb.innerHTML = subs.map(s => `
    <tr>
      <td>${s.academic_year} / ${s.semester}</td>
      <td>${Number(s.gwa).toFixed(2)}</td>
      <td>${s.enrolled_units}</td>
      <td>${s.failed_count} / ${s.incomplete_count} / ${s.dropped_count}</td>
      <td>${s.evidence_ref ?? '—'}</td>
      <td>${fmtDate(s.submitted_at)}</td>
      <td>${verificationChip(s)}
          ${s.verification_status === 'Returned' && s.verification_reason
            ? `<div class="reasons">${s.verification_reason}</div>` : ''}</td>
      <td>${complianceChip(s)}${reasonList(s.compliance_reasons)}</td>
      <td>${renewalChip(s)}</td>
      <td>${s.verification_status === 'Returned'
            ? `<button class="btn ghost small" data-resubmit="${s.id}">Correct &amp; resubmit</button>`
            : '—'}</td>
    </tr>`).join('');

  tb.querySelectorAll('[data-resubmit]').forEach(btn =>
    btn.addEventListener('click', () => startCorrection(btn.dataset.resubmit, subs)));
}

function startCorrection(id, subs) {
  const s = subs.find(x => x.id === id);
  if (!s) return;

  EDITING_ID = id;
  const f = $('#formSubmit');
  f.academic_year.value  = s.academic_year;
  f.semester.value       = s.semester;
  f.gwa.value            = s.gwa;
  f.enrolled_units.value = s.enrolled_units;
  f.failed_count.value   = s.failed_count;
  f.incomplete_count.value = s.incomplete_count;
  f.dropped_count.value  = s.dropped_count;
  f.evidence_ref.value   = s.evidence_ref;

  f.academic_year.disabled = true;
  f.semester.disabled      = true;

  $('#formTitle').textContent = 'Correct and resubmit returned submission';
  $('#btnCancelEdit').hidden  = false;
  showMsg('Correct the record, then resubmit. It will return to Pending verification.', 'ok');
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#btnCancelEdit').addEventListener('click', () => resetForm());

function resetForm() {
  EDITING_ID = null;
  const f = $('#formSubmit');
  f.reset();
  f.academic_year.value = '2026-2027';
  f.academic_year.disabled = false;
  f.semester.disabled = false;
  $('#formTitle').textContent = 'Submit semester academic summary';
  $('#btnCancelEdit').hidden = true;
  showMsg('', '');
}

function showMsg(text, cls = '') {
  const m = $('#msg');
  m.textContent = text;
  m.className = 'msg ' + cls;
}

function validatePayload(p) {
  if (isNaN(p.gwa) || p.gwa < 1 || p.gwa > 5)
    return 'Invalid GWA: enter a value from 1.00 to 5.00 inclusive.';
  for (const k of ['enrolled_units', 'failed_count', 'incomplete_count', 'dropped_count']) {
    if (!Number.isInteger(p[k]) || p[k] < 0)
      return 'Invalid input: units and counts must be non-negative whole numbers.';
  }
  if (!p.evidence_ref) return 'Grade document reference is required.';
  if (!p.academic_year) return 'Academic year is required.';
  return null;
}

$('#formSubmit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);

  const payload = {
    scholar_id:       ME.profile.id,
    program_id:       MY_ASSIGN?.program_id,
    academic_year:    (f.get('academic_year') || '').trim(),
    semester:         f.get('semester'),
    gwa:              Number(f.get('gwa')),
    enrolled_units:   Number(f.get('enrolled_units')),
    failed_count:     Number(f.get('failed_count')),
    incomplete_count: Number(f.get('incomplete_count')),
    dropped_count:    Number(f.get('dropped_count')),
    evidence_ref:     (f.get('evidence_ref') || '').trim()
  };

  const bad = validatePayload(payload);
  if (bad) { showMsg(bad, 'err'); return; }
  if (!payload.program_id) { showMsg('No program assigned to your account.', 'err'); return; }

  if (EDITING_ID) {
    /* Correction path — DB trigger forces status back to Pending and
       clears verification/compliance/renewal fields. */
    const { error } = await sb.from('submissions').update({
      gwa: payload.gwa,
      enrolled_units: payload.enrolled_units,
      failed_count: payload.failed_count,
      incomplete_count: payload.incomplete_count,
      dropped_count: payload.dropped_count,
      evidence_ref: payload.evidence_ref
    }).eq('id', EDITING_ID);

    if (error) { showMsg('Correction failed: ' + error.message, 'err'); return; }
    await logAudit(EDITING_ID, 'RESUBMIT_CORRECTION', { evidence_ref: payload.evidence_ref });
    showMsg('Corrected and resubmitted. Status is now Pending verification.', 'ok');
    resetForm();
    await loadScholar();
    return;
  }

  const { error } = await sb.from('submissions').insert(payload);

  if (error) {
    if (error.code === '23505')
      showMsg('Duplicate record: you already submitted for this academic year and semester.', 'err');
    else if (error.code === '23514')
      showMsg('Invalid value rejected by the database: GWA must be 1.00–5.00 and counts must be non-negative.', 'err');
    else
      showMsg('Submission failed: ' + error.message, 'err');
    return;
  }

  showMsg('Submitted successfully. Status: Pending verification.', 'ok');
  resetForm();
  await loadScholar();
});

/* ================= STAFF ================= */
async function loadPrograms() {
  const { data } = await sb.from('programs').select('*').order('code');
  PROGRAMS = Object.fromEntries((data || []).map(p => [p.id, p]));

  const selAssign = $('#selAssignProgram');
  const selFilter = $('#fProgram');
  selAssign.innerHTML = (data || []).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  selFilter.innerHTML = `<option value="">All programs</option>` +
    (data || []).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function loadStaff() {
  /* Staff can read ALL synthetic submissions; the scholar-only RLS policy
     does not apply to them. */
  const { data: subs, error } = await sb.from('submissions')
    .select('*, profiles!fk_sub_scholar(full_name, student_id), programs(name)')
    .order('submitted_at', { ascending: false });

  if (error) { console.error(error); return; }
  ALL_SUBS = subs || [];

  const { data: assigns } = await sb.from('scholar_assignments').select('scholar_id');
  $('#kpiAssigned').textContent = new Set((assigns || []).map(a => a.scholar_id)).size;

  renderKpis(ALL_SUBS);
  renderStaffTable();
  await loadAudit();
}

function renderKpis(subs) {
  $('#kpiPending').textContent   = subs.filter(s => s.verification_status === 'Pending').length;
  $('#kpiCompliant').textContent = subs.filter(s => s.compliance_result === 'Compliant').length;
  $('#kpiDeficient').textContent = subs.filter(s => s.compliance_result === 'With Deficiency').length;
}

function filteredSubs() {
  const q   = $('#q').value.trim().toLowerCase();
  const pr  = $('#fProgram').value;
  const co  = $('#fCompliance').value;
  const ve  = $('#fVerification').value;

  return ALL_SUBS.filter(s => {
    const name = (s.profiles?.full_name || '').toLowerCase();
    const sid  = (s.profiles?.student_id || '').toLowerCase();
    if (q && !(name.includes(q) || sid.includes(q))) return false;
    if (pr && s.program_id !== pr) return false;
    if (ve && s.verification_status !== ve) return false;
    if (co === '__none' && s.compliance_result) return false;
    if (co && co !== '__none' && s.compliance_result !== co) return false;
    return true;
  });
}

function renderStaffTable() {
  const rows = filteredSubs();
  const tb = $('#tblAll tbody');
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="11" class="muted">No matching submissions.</td></tr>`; return; }

  tb.innerHTML = rows.map(s => {
    const canVerify   = s.verification_status !== 'Verified';
    const canEvaluate = s.verification_status === 'Verified';
    const canDecide   = s.compliance_result === 'Compliant' || s.compliance_result === 'With Deficiency';

    return `<tr>
      <td><strong>${s.profiles?.full_name ?? '—'}</strong><div class="muted">${s.profiles?.student_id ?? ''}</div></td>
      <td>${s.programs?.name ?? '—'}</td>
      <td>${s.academic_year} / ${s.semester}</td>
      <td>${Number(s.gwa).toFixed(2)}</td>
      <td>${s.enrolled_units}</td>
      <td>${s.failed_count} / ${s.incomplete_count} / ${s.dropped_count}</td>
      <td>${fmtDate(s.submitted_at)}</td>
      <td>${verificationChip(s)}
          ${s.verification_status === 'Returned' && s.verification_reason
            ? `<div class="reasons">${s.verification_reason}</div>` : ''}</td>
      <td>${complianceChip(s)}${reasonList(s.compliance_reasons)}</td>
      <td>${renewalChip(s)}${s.decision_notes ? `<div class="muted">${s.decision_notes}</div>` : ''}</td>
      <td>
        <div class="btnrow">
          <button class="btn ghost small" data-verify="${s.id}" ${canVerify ? '' : 'disabled'}>Verify</button>
          <button class="btn ghost small" data-return="${s.id}">Return</button>
          <button class="btn primary small" data-evaluate="${s.id}" ${canEvaluate ? '' : 'disabled'}>Evaluate</button>
          <button class="btn primary small" data-approve="${s.id}" ${canDecide && s.compliance_result === 'Compliant' ? '' : 'disabled'}>Approve</button>
          <button class="btn ghost small" data-hold="${s.id}" ${canDecide ? '' : 'disabled'}>Hold</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tb.querySelectorAll('[data-verify]').forEach(b   => b.addEventListener('click', () => setVerification(b.dataset.verify, 'Verified')));
  tb.querySelectorAll('[data-return]').forEach(b   => b.addEventListener('click', () => setVerification(b.dataset.return, 'Returned')));
  tb.querySelectorAll('[data-evaluate]').forEach(b => b.addEventListener('click', () => evaluate(b.dataset.evaluate)));
  tb.querySelectorAll('[data-approve]').forEach(b  => b.addEventListener('click', () => decide(b.dataset.approve, 'Approved')));
  tb.querySelectorAll('[data-hold]').forEach(b     => b.addEventListener('click', () => decide(b.dataset.hold, 'Held')));
}

['#q', '#fProgram', '#fCompliance', '#fVerification'].forEach(sel =>
  $(sel).addEventListener('input', renderStaffTable));

/* ---- verification / correction ---- */
async function setVerification(id, status) {
  let reason = null;
  if (status === 'Returned') {
    reason = prompt('Reason for returning this submission (required):');
    if (!reason || !reason.trim()) return;
    reason = reason.trim();
  }

  const { error } = await sb.from('submissions').update({
    verification_status: status,
    verification_reason: reason,
    verified_by: ME.profile.id,
    verified_at: new Date().toISOString(),
    /* A returned submission is no longer evaluable. */
    ...(status === 'Returned'
      ? { compliance_result: null, compliance_reasons: null, evaluated_at: null }
      : {})
  }).eq('id', id);

  if (error) return alert('Update failed: ' + error.message);
  await logAudit(id, 'VERIFICATION_' + status.toUpperCase(), { reason });
  await loadStaff();
}

/* ---- compliance evaluation ---- */
async function evaluate(id) {
  const sub = ALL_SUBS.find(s => s.id === id);
  if (!sub) return;

  if (sub.verification_status !== 'Verified')
    return alert('Blocked: evidence must be Verified before evaluation.');

  const program = PROGRAMS[sub.program_id] ?? sub.programs;
  if (!program) return alert('Program policy record not found.');

  const { result, reasons } = computeCompliance(sub, program);

  const { error } = await sb.from('submissions').update({
    compliance_result: result,
    compliance_reasons: reasons,
    evaluated_at: new Date().toISOString()
  }).eq('id', id);

  if (error) return alert('Evaluation failed: ' + error.message);
  await logAudit(id, 'EVALUATION_' + result.toUpperCase().replace(/\s+/g, '_'), { reasons });
  await loadStaff();

  alert(`Evaluation result: ${result}` + (reasons.length ? `\n\nReasons:\n• ${reasons.join('\n• ')}` : ''));
}

/* ---- renewal decision ---- */
async function decide(id, decision) {
  const sub = ALL_SUBS.find(s => s.id === id);
  if (!sub) return;

  if (decision === 'Approved' && sub.compliance_result !== 'Compliant')
    return alert('Blocked: approval requires a Compliant evaluation. Deficient records can only be Held.');

  if (!sub.compliance_result)
    return alert('Blocked: evaluate the submission before recording a renewal decision.');

  const notes = prompt(`Decision notes for ${decision}:`) ?? '';

  const { error } = await sb.from('submissions').update({
    renewal_decision: decision,
    decision_notes: notes,
    decided_by: ME.profile.id,
    decided_at: new Date().toISOString()
  }).eq('id', id);

  if (error) return alert('Decision failed: ' + error.message);
  await logAudit(id, 'RENEWAL_' + decision.toUpperCase(), { notes });
  await loadStaff();
}

/* ---- audit log ---- */
async function logAudit(submissionId, action, details) {
  await sb.from('audit_log').insert({
    submission_id: submissionId,
    actor_id: ME.profile.id,
    action,
    details: details ?? {}
  });
}

async function loadAudit() {
  const { data } = await sb.from('audit_log')
    .select('*, profiles!fk_audit_actor(full_name)')
    .order('created_at', { ascending: false })
    .limit(50);

  $('#tblAudit tbody').innerHTML = (data || []).map(a => `
    <tr>
      <td>${fmtDate(a.created_at)}</td>
      <td>${a.profiles?.full_name ?? '—'}</td>
      <td>${a.action}</td>
      <td>${JSON.stringify(a.details)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="muted">No history yet.</td></tr>`;
}

/* ---- staff: register / assign scholar ---- */
$('#formAssign').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = f.get('email').trim().toLowerCase();
  const msgEl = $('#assignMsg');

  const { data: profile, error: pErr } = await sb.from('profiles')
    .select('id').eq('email', email).maybeSingle();

  if (pErr) { msgEl.textContent = pErr.message; msgEl.className = 'msg err'; return; }
  if (!profile) {
    msgEl.textContent = 'No account with that email. Create it in Supabase Auth first.';
    msgEl.className = 'msg err';
    return;
  }

  const { error } = await sb.from('scholar_assignments').upsert({
    scholar_id: profile.id,
    program_id: f.get('program_id'),
    school_year: '2026-2027',
    status: 'Active',
    assigned_by: ME.profile.id
  }, { onConflict: 'scholar_id,school_year' });

  if (error) { msgEl.textContent = 'Assignment failed: ' + error.message; msgEl.className = 'msg err'; return; }

  msgEl.textContent = 'Scholar registered and program assigned.';
  msgEl.className = 'msg ok';
  e.target.reset();
  await loadStaff();
});