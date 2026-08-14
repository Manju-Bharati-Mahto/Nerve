/* External Casting Registration.
   Deliberately standalone: no NERVE session, no admin bundle, nothing about the
   internal system is reachable from here. The only thing this page can do is
   read one campaign and submit one form — everything is authorised server-side
   against an email address the server itself verified with a one-time code. */
const $ = s => document.querySelector(s);
const app = $('#app');
const TOKEN = (location.pathname.match(/\/casting\/register\/([A-Za-z0-9]+)/) || [])[1]
  || new URLSearchParams(location.search).get('t') || '';
const API = '/api/v1/public/casting/' + encodeURIComponent(TOKEN);

/* The verified session survives a refresh but not a new tab or browser, and is
   filed under this link's token so it can never be replayed against another. */
const SKEY = 'nerve.portal.casting.' + TOKEN;
const saveSession = t => { try { sessionStorage.setItem(SKEY, t); } catch (e) {} };
const loadSession = () => { try { return sessionStorage.getItem(SKEY) || ''; } catch (e) { return ''; } };
const dropSession = () => { try { sessionStorage.removeItem(SKEY); } catch (e) {} };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const AGE = ['Child','Teen','Young Adult','Adult','Middle-aged','Senior'];
const AGE_KEY = {'Child':'child','Teen':'teen','Young Adult':'young_adult','Adult':'adult','Middle-aged':'middle_aged','Senior':'senior'};
const TYPES = ['Student','Faculty','Staff','Researcher','Alumni','Other'];
const LANGS = ['Gujarati','Hindi','English','Marathi','Sanskrit'];
const INTERESTS = ['Student role','Faculty role','Doctor role','Professional role','Parent role',
  'Corporate role','Traditional role','Lifestyle role','Presenter','Background participant','Other'];
const AVAIL = ['Available regularly','Available occasionally','Available with advance notice','Currently unavailable'];

let campaign = null, identity = null, session = '', state = { languages: [], interests: [] };

const brand = `<div class="brand"><i>N</i><div><b>NERVE Media Ops</b><span>Parul University</span></div></div>`;
const shell = inner => { app.innerHTML = brand + inner + `<div class="foot">Parul University · Media Crew</div>`; };
const note = (kind, html) => `<div class="note ${kind}">${html}</div>`;

async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Something went wrong. Please try again.');
  return j;
}

/* ---- boot ---- */
(async function start() {
  if (!TOKEN) return shell(`<div class="card">${note('bad','<b>This casting registration link is not valid.</b><br>Please check the link you were given.')}</div>`);
  try {
    campaign = await api('');
  } catch (e) {
    return shell(`<div class="card">${note('bad','<b>This casting registration link is not valid.</b><br>' + esc(e.message))}</div>`);
  }
  if (!campaign.open) return shell(`
    <h1>Casting Registration</h1>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    <div class="card">${note('warn','<b>' + esc(campaign.message || 'This casting registration is currently closed.') + '</b><br>Existing submissions are unaffected.')}</div>`);
  // A stored session means this tab already verified for THIS link; the server
  // still re-checks it on every call, so a stale or revoked one just drops back
  // to step 1 rather than pretending to be signed in.
  const saved = loadSession();
  if (saved) { session = saved; try { return await checkIdentity(); } catch (e) { dropSession(); session = ''; } }
  renderEmail();
})();

/* ---- step 1: email → OTP → form ------------------------------------------
   Three steps, one identity. The email is only ever a claim until the server
   has redeemed a code for it; after that the browser holds an opaque session
   token scoped to THIS link, and every later call carries it. The address is
   never editable afterwards — it is whatever the verified session says. */
const STEPS = ['Email verification', 'OTP verification', 'Form'];
const steps = n => `<div class="steps">${STEPS.map((l, i) =>
  `<span class="step${i === n ? ' on' : ''}${i < n ? ' done' : ''}">${i < n ? '✓' : (i + 1)} ${esc(l)}</span>`
).join('<i>›</i>')}</div>`;

let pending = { email: '', resendAt: 0, timer: null };

function renderEmail(msg) {
  const dom = campaign.campaign.allowed_domain;
  shell(`
    <h1>Casting Registration</h1>
    <p class="sub">Join the university Media Crew's casting library for future video, photo and promotional productions.</p>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    ${steps(0)}
    ${campaign.campaign.description ? `<div class="card"><p style="margin:0;color:var(--text-2)">${esc(campaign.campaign.description)}</p></div>` : ''}
    <div class="card">
      <h2>Verify your email</h2>
      <p style="color:var(--text-2);margin:0 0 14px;font-size:13.5px">
        Enter your official Parul University email address to continue. You do not need a
        NERVE account, and verifying here does not create one.</p>
      <div class="field">
        <label>Email <span class="req">*</span></label>
        <input type="email" id="p-email" placeholder="name@${esc(dom)}" value="${esc(pending.email)}" autocomplete="email">
      </div>
      <button class="btn primary" id="p-send">Send OTP</button>
      <div id="auth-msg">${msg || ''}</div>
    </div>`);
  const go = () => sendOtp();
  $('#p-send').onclick = go;
  $('#p-email').onkeydown = e => { if (e.key === 'Enter') go(); };
}

async function sendOtp(resend) {
  const dom = campaign.campaign.allowed_domain;
  const email = (resend ? pending.email : ($('#p-email').value || '')).trim().toLowerCase();
  const box = $('#auth-msg');
  /* Mirrors the server rule purely so the obvious mistake is caught without a
     round trip. The server rejects the same thing independently — this check
     is convenience, never the control. */
  if (!email || !email.endsWith('@' + dom)) {
    box.innerHTML = note('bad', `Please use your official @${esc(dom)} email address.`);
    return;
  }
  const btn = $(resend ? '#p-resend' : '#p-send');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const r = await api('/otp/send', { email });
    pending.email = email;
    pending.resendAt = Date.now() + (r.resend_after_seconds || 60) * 1000;
    renderOtp(r.masked_email, note('ok', `<b>OTP sent.</b><br>We sent a verification code to ${esc(r.masked_email)}.`));
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = resend ? 'Resend OTP' : 'Send OTP'; }
    const target = $('#auth-msg');
    if (target) target.innerHTML = note('bad', esc(e.message));
  }
}

function renderOtp(masked, msg) {
  shell(`
    <h1>Casting Registration</h1>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    ${steps(1)}
    <div class="card">
      <h2>Enter your code</h2>
      <p style="color:var(--text-2);margin:0 0 14px;font-size:13.5px">
        We sent a 6-digit code to <b>${esc(masked || pending.email)}</b>. It expires in
        ${esc(String(campaign.otp_ttl_minutes || 10))} minutes.</p>
      <div class="field">
        <label>Verification code <span class="req">*</span></label>
        <input id="p-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="000000" style="letter-spacing:8px;font-size:20px;text-align:center">
      </div>
      <button class="btn primary" id="p-verify">Verify OTP</button>
      <button class="btn" id="p-resend" style="margin-top:8px">Resend OTP</button>
      <button class="btn" id="p-back" style="margin-top:8px">Use a different email</button>
      <div id="auth-msg">${msg || ''}</div>
    </div>`);
  const go = () => verifyOtp();
  $('#p-verify').onclick = go;
  $('#p-otp').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#p-otp').focus();
  $('#p-back').onclick = () => { clearInterval(pending.timer); renderEmail(); };
  $('#p-resend').onclick = () => sendOtp(true);
  tickResend();
}

/* The countdown is the server's cooldown, echoed back — the button is only a
   courtesy, since the server refuses an early resend regardless. */
function tickResend() {
  clearInterval(pending.timer);
  const paint = () => {
    const btn = $('#p-resend');
    if (!btn) return clearInterval(pending.timer);
    const left = Math.ceil((pending.resendAt - Date.now()) / 1000);
    if (left > 0) { btn.disabled = true; btn.textContent = `Resend OTP in ${left}s`; }
    else { btn.disabled = false; btn.textContent = 'Resend OTP'; clearInterval(pending.timer); }
  };
  paint();
  pending.timer = setInterval(paint, 1000);
}

async function verifyOtp() {
  const otp = ($('#p-otp').value || '').trim();
  const box = $('#auth-msg');
  if (!/^\d{6}$/.test(otp)) { box.innerHTML = note('bad', 'Enter the 6-digit code from your email.'); return; }
  const btn = $('#p-verify');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const v = await api('/otp/verify', { email: pending.email, otp });
    clearInterval(pending.timer);
    session = v.portal_session; saveSession(session);
    await checkIdentity();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Verify OTP';
    const target = $('#auth-msg');
    if (target) target.innerHTML = note('bad', esc(e.message));
  }
}

/* The domain rule is enforced on the SERVER — this call is what tells us whether
   the address is acceptable, and whether it has already applied. */
async function checkIdentity() {
  try {
    const r = await api('/lookup', { portal_session: session });
    identity = { email: r.email, name: r.name };
    if (r.existing && ['approved','rejected'].includes(r.existing.status)) return renderAlready(r.existing);
    if (r.existing) return renderForm(r.existing);
    renderForm(null);
  } catch (e) {
    dropSession(); session = '';
    renderEmail(note('bad', esc(e.message)));
  }
}
function renderAlready(ex) {
  shell(`
    <h1>Casting Registration</h1>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    <div class="card">
      ${note('ok', '<b>You have already submitted a casting request for this drive.</b>')}
      <p style="color:var(--text-2)">Request ID: <span class="code">${esc(ex.request_id)}</span></p>
      <p class="hint">The Media Crew will be in touch if they need anything further.</p>
    </div>`);
}

/* ---- step 2: the form ---- */
function renderForm(existing) {
  const dom = campaign.campaign.allowed_domain;
  const chips = (id, list, sel) => `<div class="chips" id="${id}">${list.map(x =>
    `<span class="chip${sel && sel.includes(x) ? ' on' : ''}" data-v="${esc(x)}">${esc(x)}</span>`).join('')}</div>`;
  shell(`
    <h1>Casting Registration</h1>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    ${existing ? note('warn', `<b>You already have a submission for this drive.</b><br>Request <span class="code">${esc(existing.request_id)}</span> — saving will update it.`) : ''}
    <div class="card"><div class="who">✓ Email verified — ${esc(identity.email)}</div></div>

    <div class="card">
      <h2>About you</h2>
      <div class="field"><label>Full name <span class="req">*</span></label>
        <input type="text" id="f-name" value="${esc(identity.name || '')}" autocomplete="name"></div>
      <div class="field"><label>What best describes you? <span class="req">*</span></label>
        ${chips('f-type', TYPES)}</div>
      <div class="field"><label>Department / institute ${campaign.campaign.require_department ? '<span class="req">*</span>' : ''}</label>
        <input type="text" id="f-dept" placeholder="e.g. Faculty of Engineering &amp; Technology"></div>
      <div class="field"><label>Designation / course</label>
        <input type="text" id="f-desig" placeholder="e.g. B.Tech Student, Assistant Professor"></div>
    </div>

    <div class="card">
      <h2>Casting details</h2>
      <div class="field"><label>Age group</label>${chips('f-age', AGE)}
        <div class="hint">Broad ranges only — we do not collect your date of birth.</div></div>
      <div class="field"><label>Gender <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <input type="text" id="f-gender" placeholder="Only if you wish to share it"></div>
      <div class="field"><label>Languages</label>${chips('f-langs', LANGS)}</div>
      <div class="field"><label>Campus / location</label>
        <input type="text" id="f-loc" placeholder="e.g. Waghodia campus"></div>
      <div class="field"><label>What kind of roles might suit you?</label>${chips('f-interests', INTERESTS)}</div>
      <div class="field"><label>Availability</label>${chips('f-avail', AVAIL)}</div>
      <div class="field"><label>Short introduction <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <textarea id="f-intro" placeholder="Tell us briefly about yourself and the kind of production you would be interested in."></textarea></div>
    </div>

    <div class="card">
      <h2>Media casting consent</h2>
      <p style="color:var(--text-2);font-size:13.5px;margin:0 0 12px">
        You confirm that you voluntarily wish to be considered for university media productions, and understand
        that the information you submit here will be reviewed by the Media Crew for casting purposes.
        You can ask the Media Crew to remove your details at any time.</p>
      <div class="consent">
        <input type="checkbox" id="f-consent">
        <label for="f-consent">I agree to be considered for university media productions.</label>
      </div>
      <div id="form-msg"></div>
    </div>

    <div class="bar"><button class="btn primary" id="submit">Submit casting request</button></div>`);

  document.querySelectorAll('.chips').forEach(group => {
    const single = ['f-type','f-age','f-avail'].includes(group.id);
    group.onclick = e => {
      const c = e.target.closest('.chip'); if (!c) return;
      if (single) group.querySelectorAll('.chip').forEach(x => x !== c && x.classList.remove('on'));
      c.classList.toggle('on');
    };
  });
  if (existing) prefill(existing);
  $('#submit').onclick = submit;
}
function prefill(ex) { /* keeps an update from wiping what they typed last time */
  if (ex.applicant_name) $('#f-name').value = ex.applicant_name;
  if (ex.department) $('#f-dept').value = ex.department;
}
const picked = id => [...document.querySelectorAll('#' + id + ' .chip.on')].map(c => c.dataset.v);

async function submit() {
  const btn = $('#submit'), msg = $('#form-msg');
  const name = ($('#f-name').value || '').trim();
  const type = picked('f-type')[0];
  const dept = ($('#f-dept').value || '').trim();
  if (!name) return fail('Please enter your full name.');
  if (!type) return fail('Please tell us what best describes you.');
  if (campaign.campaign.require_department && !dept) return fail('Please enter your department or institute.');
  if (!$('#f-consent').checked) return fail('Please confirm the casting consent before submitting.');

  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const r = await api('/submit', {
      portal_session: session, name, applicant_type: type, department: dept,
      designation: ($('#f-desig').value || '').trim(),
      age_group: AGE_KEY[picked('f-age')[0]] || null,
      gender: ($('#f-gender').value || '').trim(),
      languages: picked('f-langs'),
      interests: picked('f-interests'),
      availability: picked('f-avail')[0] || null,
      location: ($('#f-loc').value || '').trim(),
      intro: ($('#f-intro').value || '').trim(),
      consent: true,
    });
    renderDone(r);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Submit casting request';
    fail(e.message);
  }
  function fail(m) { msg.innerHTML = note('bad', esc(m)); msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
function renderDone(r) {
  shell(`
    <div class="card done">
      <div class="tick">✓</div>
      <h1 style="font-size:24px">${r.updated ? 'Submission updated' : 'Thank you!'}</h1>
      <p class="sub">Your casting registration has been ${r.updated ? 'updated' : 'submitted'} to the NERVE Media Ops team.</p>
      <p style="margin:16px 0">Request ID: <span class="code">${esc(r.request_id)}</span></p>
      <p class="hint">Your submission will be reviewed by the Media Crew. Keep this ID for reference.</p>
    </div>`);
  window.scrollTo(0, 0);
}
