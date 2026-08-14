/* External Media Request portal.
   Same intake-door pattern as the casting portal: standalone page, no NERVE
   session, no admin bundle. Everything is authorised server-side against a
   verified email address. A submission becomes an ordinary request row —
   there is no second request system (§51). */
const $ = s => document.querySelector(s);
const app = $('#app');
/* Canonical /request/register/<token>; /request/new/<token> still accepted so
   links circulated before the rename keep working. */
const TOKEN = (location.pathname.match(/\/request\/(?:register|new)\/([A-Za-z0-9]+)/) || [])[1]
  || new URLSearchParams(location.search).get('t') || '';
const API = '/api/v1/public/request/' + encodeURIComponent(TOKEN);

/* The verified session survives a refresh but not a new tab or browser, and is
   filed under this link's token so it can never be replayed against another. */
const SKEY = 'nerve.portal.request.' + TOKEN;
const saveSession = t => { try { sessionStorage.setItem(SKEY, t); } catch (e) {} };
const loadSession = () => { try { return sessionStorage.getItem(SKEY) || ''; } catch (e) { return ''; } };
const dropSession = () => { try { sessionStorage.removeItem(SKEY); } catch (e) {} };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* What Media Ops can be asked for. Rendered from the server's own work types
   and deliverable types, so this never becomes a second taxonomy (§9/§15). */
const PRIORITIES = [['low','Low'],['normal','Normal'],['high','High'],['urgent','Urgent']];
let portal = null, identity = null, session = '', pendingDuplicate = null;

const brand = `<div class="brand"><i>N</i><div><b>NERVE Media Ops</b><span>Parul University</span></div></div>`;
const shell = inner => { app.innerHTML = brand + inner + `<div class="foot">Parul University · Media Operations</div>`; };
const note = (k, html) => `<div class="note ${k}">${html}</div>`;

async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !(r.status === 409 && j.duplicate)) throw new Error(j.message || 'Something went wrong. Please try again.');
  return j;
}

(async function start() {
  if (!TOKEN) return shell(`<div class="card">${note('bad','<b>This media request link is not valid.</b><br>Please check the link you were given.')}</div>`);
  try { portal = await api(''); }
  catch (e) { return shell(`<div class="card">${note('bad','<b>This media request link is not valid.</b><br>' + esc(e.message))}</div>`); }
  if (!portal.open) return shell(`
    <h1>Media Request</h1>
    <div class="campaign">◆ ${esc(portal.portal.name)}</div>
    <div class="card">${note('warn','<b>' + esc(portal.message) + '</b><br>Requests already submitted are unaffected.')}</div>`);
  // Same as the casting portal: resume a verified session for THIS link only.
  const saved = loadSession();
  if (saved) {
    session = saved;
    try {
      const r = await api('/me', { portal_session: session });
      identity = { email: r.email, name: r.name, requests: r.requests || [] };
      return renderForm();
    } catch (e) { dropSession(); session = ''; }
  }
  renderEmail();
})();

/* ---- step 1: email → OTP → form ------------------------------------------
   Identical shape to the casting portal, deliberately: the two public doors
   share one server-side implementation, so their client flows match too. */
const STEPS = ['Email verification', 'OTP verification', 'Form'];
const steps = n => `<div class="steps">${STEPS.map((l, i) =>
  `<span class="step${i === n ? ' on' : ''}${i < n ? ' done' : ''}">${i < n ? '✓' : (i + 1)} ${esc(l)}</span>`
).join('<i>›</i>')}</div>`;

let pending = { email: '', resendAt: 0, timer: null };

function renderEmail(msg) {
  const dom = portal.portal.allowed_domain;
  shell(`
    <h1>Media Request</h1>
    <p class="sub">Submit your photography, videography, event coverage or other media requirements to the
      Media Operations team.</p>
    <div class="campaign">◆ ${esc(portal.portal.name)}</div>
    ${steps(0)}
    ${portal.portal.description ? `<div class="card"><p style="margin:0;color:var(--text-2)">${esc(portal.portal.description)}</p></div>` : ''}
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
  $('#p-send').onclick = () => sendOtp();
  $('#p-email').onkeydown = e => { if (e.key === 'Enter') sendOtp(); };
}

async function sendOtp(resend) {
  const dom = portal.portal.allowed_domain;
  const email = (resend ? pending.email : ($('#p-email').value || '')).trim().toLowerCase();
  /* Convenience only — the server applies the same rule independently. */
  if (!email || !email.endsWith('@' + dom)) {
    $('#auth-msg').innerHTML = note('bad', `Please use your official @${esc(dom)} email address.`);
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
    const t = $('#auth-msg'); if (t) t.innerHTML = note('bad', esc(e.message));
  }
}

function renderOtp(masked, msg) {
  shell(`
    <h1>Media Request</h1>
    <div class="campaign">◆ ${esc(portal.portal.name)}</div>
    ${steps(1)}
    <div class="card">
      <h2>Enter your code</h2>
      <p style="color:var(--text-2);margin:0 0 14px;font-size:13.5px">
        We sent a 6-digit code to <b>${esc(masked || pending.email)}</b>. It expires in
        ${esc(String(portal.otp_ttl_minutes || 10))} minutes.</p>
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
  $('#p-verify').onclick = () => verifyOtp();
  $('#p-otp').onkeydown = e => { if (e.key === 'Enter') verifyOtp(); };
  $('#p-otp').focus();
  $('#p-back').onclick = () => { clearInterval(pending.timer); renderEmail(); };
  $('#p-resend').onclick = () => sendOtp(true);
  tickResend();
}

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
  if (!/^\d{6}$/.test(otp)) { $('#auth-msg').innerHTML = note('bad', 'Enter the 6-digit code from your email.'); return; }
  const btn = $('#p-verify');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const v = await api('/otp/verify', { email: pending.email, otp });
    clearInterval(pending.timer);
    session = v.portal_session; saveSession(session);
    const r = await api('/me', { portal_session: session });
    identity = { email: r.email, name: r.name, requests: r.requests || [] };
    renderForm();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Verify OTP';
    const t = $('#auth-msg'); if (t) t.innerHTML = note('bad', esc(e.message));
  }
}

function renderForm() {
  const chips = (id, items, key) => `<div class="chips" id="${id}">${items.map(x =>
    `<span class="chip" data-v="${esc(key ? x.id : x)}">${esc(key ? x.name : x)}</span>`).join('')}</div>`;
  shell(`
    <h1>Media Request</h1>
    <div class="campaign">◆ ${esc(portal.portal.name)}</div>
    <div class="card"><div class="who">✓ Email verified — ${esc(identity.email)}</div></div>

    ${identity.requests.length ? `<div class="card">
      <h2>Your previous requests</h2>
      ${identity.requests.map(r => `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;
        border-bottom:1px solid var(--border);font-size:13px">
        <span><span class="code">${esc(r.code)}</span> ${esc(r.event_name)}</span>
        <span style="color:var(--text-3);white-space:nowrap">${esc(r.status)}</span></div>`).join('')}
    </div>` : ''}

    <div class="card">
      <h2>Who is requesting</h2>
      <div class="field"><label>Institute / faculty <span class="req">*</span></label>
        <input type="text" id="f-inst" placeholder="e.g. Faculty of Engineering &amp; Technology"></div>
      <div class="field"><label>Department / unit</label>
        <select id="f-unit"><option value="">— not listed —</option>
          ${portal.units.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Point of contact <span class="req">*</span></label>
        <input type="text" id="f-stake" value="${esc(identity.name || '')}"></div>
      <div class="field"><label>University email</label>
        <input type="email" id="f-email" value="${esc(identity.email)}" readonly
          style="background:#F8FAFC;color:var(--text-3)">
        <div class="hint">Taken from your verified sign-in.</div></div>
      <div class="field"><label>Phone number</label>
        <input type="text" id="f-phone" inputmode="tel" placeholder="Optional, but helps us reach you quickly"></div>
    </div>

    <div class="card">
      <h2>What is the event or requirement?</h2>
      <div class="field"><label>Event / requirement name <span class="req">*</span></label>
        <input type="text" id="f-event" placeholder="e.g. Engineering Convocation 2026"></div>
      <div class="field"><label>Venue</label>
        <input type="text" id="f-venue" placeholder="e.g. Convention Hall"></div>
      <div class="field"><label>Date <span class="req">*</span></label>
        <input type="date" id="f-date"></div>
      <div class="field"><label>Time</label><input type="time" id="f-time"></div>
      <div class="field"><label>End date <span style="font-weight:400;color:var(--text-3)">(for multi-day events)</span></label>
        <input type="date" id="f-end"></div>
      <div class="field"><label>End time</label><input type="time" id="f-endtime"></div>
    </div>

    <div class="card">
      <h2>What do you need from Media Ops?</h2>
      <div class="field">${chips('f-types', portal.work_types, true)}
        <div class="hint">Select everything that applies.</div></div>
      <div class="field"><label>Expected deliverables</label>
        ${chips('f-delivs', portal.deliverable_types, true)}
        <div class="hint">What you would like to receive. The final production plan is agreed with the Media team.</div></div>
    </div>

    <div class="card">
      <h2>Tell us more</h2>
      <div class="field"><label>Requirement <span class="req">*</span></label>
        <input type="text" id="f-req" placeholder="e.g. Full-day photo and video coverage of the event"></div>
      <div class="field"><label>Description</label>
        <textarea id="f-desc" placeholder="Please describe what you need, important instructions, expected coverage, special requirements, etc."></textarea></div>
      <div class="field"><label>Priority</label>
        <div class="chips" id="f-pri">${PRIORITIES.map(([k,l]) =>
          `<span class="chip${k==='normal'?' on':''}" data-v="${k}">${l}</span>`).join('')}</div>
        <div class="hint">Please reserve Urgent for genuine short-notice requirements.</div></div>
      <div class="field"><label>Additional requirements / notes</label>
        <textarea id="f-extra" placeholder="VIP coverage, specific guests, camera positions, special access, branding, delivery deadline…"></textarea></div>
      <div class="field"><label>Indicative budget <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <input type="text" id="f-budget" inputmode="numeric" placeholder="Leave blank if not applicable"></div>
    </div>

    <div class="card">
      <h2>Coordination</h2>
      <div class="consent" style="margin-bottom:10px">
        <input type="checkbox" id="f-meet">
        <label for="f-meet">I would like a meeting to discuss this requirement</label></div>
      <div id="meet-box" style="display:none">
        <div class="field"><label>Preferred meeting date</label><input type="date" id="f-meetdate"></div>
        <div class="field"><label>Preferred time</label><input type="time" id="f-meettime"></div>
        <div class="field"><label>Meeting notes</label><textarea id="f-meetnotes"></textarea></div>
        <div class="hint" style="margin-bottom:12px">The Media team will confirm — nothing is scheduled automatically.</div>
      </div>
      <div class="consent">
        <input type="checkbox" id="f-vendor">
        <label for="f-vendor">This may need an external vendor (printing, staging, equipment hire…)</label></div>
      <div id="vendor-box" style="display:none;margin-top:10px">
        <div class="field"><label>Vendor requirement</label><textarea id="f-vendordetails"></textarea></div>
      </div>
      <div id="form-msg"></div>
    </div>

    <div class="bar"><button class="btn primary" id="submit">Submit media request</button></div>`);

  document.querySelectorAll('.chips').forEach(g => {
    const single = g.id === 'f-pri';
    g.onclick = e => { const c = e.target.closest('.chip'); if (!c) return;
      if (single) g.querySelectorAll('.chip').forEach(x => x !== c && x.classList.remove('on'));
      c.classList.toggle('on'); };
  });
  $('#f-meet').onchange = e => { $('#meet-box').style.display = e.target.checked ? '' : 'none'; };
  $('#f-vendor').onchange = e => { $('#vendor-box').style.display = e.target.checked ? '' : 'none'; };
  $('#submit').onclick = () => submit(false);
}
const picked = id => [...document.querySelectorAll('#' + id + ' .chip.on')].map(c => c.dataset.v);

async function submit(confirmDuplicate) {
  const btn = $('#submit'), msg = $('#form-msg');
  const v = id => (($('#' + id) || {}).value || '').trim();
  if (!v('f-inst'))  return fail('Please tell us which institute or faculty this is for.');
  if (!v('f-event')) return fail('Please give the event or requirement a name.');
  if (!v('f-stake')) return fail('Please give a point of contact.');
  if (!v('f-date'))  return fail('Please give the date this is needed for.');
  if (!v('f-req'))   return fail('Please summarise what you need.');

  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const r = await api('/submit', {
      portal_session: session, confirm_duplicate: !!confirmDuplicate,
      institute: v('f-inst'), academic_unit_id: v('f-unit') || null,
      stakeholder: v('f-stake'), contact_email: identity.email, contact_phone: v('f-phone'),
      event_name: v('f-event'), venue: v('f-venue'),
      event_date: v('f-date'), event_time: v('f-time'),
      end_date: v('f-end'), end_time: v('f-endtime'),
      requirement_types: picked('f-types').map(Number),
      deliverables_requested: picked('f-delivs').map(Number),
      requirement: v('f-req'), description: v('f-desc'),
      priority: picked('f-pri')[0] || 'normal',
      additional_notes: v('f-extra'), budget: v('f-budget').replace(/[^\d.]/g, '') || null,
      meeting_required: $('#f-meet').checked, meeting_date: v('f-meetdate'),
      meeting_time: v('f-meettime'), meeting_notes: v('f-meetnotes'),
      vendor_required: $('#f-vendor').checked, vendor_details: v('f-vendordetails'),
    });
    if (r.duplicate) { btn.disabled = false; btn.textContent = 'Submit media request'; return renderDuplicate(r); }
    renderDone(r);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Submit media request';
    fail(e.message);
  }
  function fail(m) { msg.innerHTML = note('bad', esc(m)); msg.scrollIntoView({behavior:'smooth',block:'center'}); }
}
/* §20 — a duplicate is a warning, not a wall: a second genuine request for the
   same event is legitimate, so the requester decides. */
function renderDuplicate(r) {
  const msg = $('#form-msg');
  msg.innerHTML = note('warn', `<b>A similar request may already exist.</b><br>
    Request <span class="code">${esc(r.existing_code)}</span> was submitted for the same event and date.
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn" id="dup-cancel" style="width:auto;padding:0 14px;min-height:40px">Keep the existing one</button>
      <button class="btn primary" id="dup-go" style="width:auto;padding:0 14px;min-height:40px">Submit anyway</button>
    </div>`);
  $('#dup-go').onclick = () => submit(true);
  $('#dup-cancel').onclick = () => { msg.innerHTML = ''; };
  msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function renderDone(r) {
  shell(`
    <div class="card done">
      <div class="tick">✓</div>
      <h1 style="font-size:24px">Request submitted</h1>
      <p class="sub">Your media requirement has been submitted to the Media Operations team.</p>
      <p style="margin:16px 0">Request ID: <span class="code">${esc(r.code)}</span></p>
      <div style="text-align:left;border-top:1px solid var(--border);padding-top:14px;margin-top:8px">
        <div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13.5px">
          <span style="color:var(--text-3)">Event / requirement</span><b>${esc(r.event_name)}</b></div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13.5px">
          <span style="color:var(--text-3)">Submitted</span><b>${new Date(r.submitted_at||Date.now()).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</b></div>
      </div>
      <p class="hint" style="margin-top:14px">The Media Operations team will review your requirement and get in
        touch if anything needs clarifying. Keep this ID for reference.</p>
    </div>`);
  window.scrollTo(0, 0);
}
