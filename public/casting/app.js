/* External Casting Registration.
   Deliberately standalone: no NERVE session, no admin bundle, nothing about the
   internal system is reachable from here. The only thing this page can do is
   read one campaign and submit one form — everything is authorised server-side
   against a verified Google identity. */
const $ = s => document.querySelector(s);
const app = $('#app');
const TOKEN = (location.pathname.match(/\/casting\/register\/([A-Za-z0-9]+)/) || [])[1]
  || new URLSearchParams(location.search).get('t') || '';
const API = '/api/v1/public/casting/' + encodeURIComponent(TOKEN);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const AGE = ['Child','Teen','Young Adult','Adult','Middle-aged','Senior'];
const AGE_KEY = {'Child':'child','Teen':'teen','Young Adult':'young_adult','Adult':'adult','Middle-aged':'middle_aged','Senior':'senior'};
const TYPES = ['Student','Faculty','Staff','Researcher','Alumni','Other'];
const LANGS = ['Gujarati','Hindi','English','Marathi','Sanskrit'];
const INTERESTS = ['Student role','Faculty role','Doctor role','Professional role','Parent role',
  'Corporate role','Traditional role','Lifestyle role','Presenter','Background participant','Other'];
const AVAIL = ['Available regularly','Available occasionally','Available with advance notice','Currently unavailable'];

let campaign = null, identity = null, state = { languages: [], interests: [] };

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
  renderSignIn();
})();

/* ---- step 1: prove who you are ---- */
function renderSignIn() {
  const dom = campaign.campaign.allowed_domain;
  shell(`
    <h1>Casting Registration</h1>
    <p class="sub">Join the university Media Crew's casting library for future video, photo and promotional productions.</p>
    <div class="campaign">◆ ${esc(campaign.campaign.name)}</div>
    ${campaign.campaign.description ? `<div class="card"><p style="margin:0;color:var(--text-2)">${esc(campaign.campaign.description)}</p></div>` : ''}
    <div class="card">
      <h2>Sign in to continue</h2>
      <p style="color:var(--text-2);margin:0 0 14px;font-size:13.5px">
        Use your official <b>@${esc(dom)}</b> Google account. You do not need a NERVE account,
        and signing in here does not create one.</p>
      <div id="gbtn"></div>
      ${campaign.dev_identity ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border)">
          <div class="hint" style="margin-bottom:8px"><b>Development mode</b> — Google sign-in is not configured on this
            server, so identity can be entered directly. This is disabled in production.</div>
          <input type="email" id="dev-email" placeholder="you@${esc(dom)}" style="margin-bottom:8px">
          <button class="btn primary" id="dev-go">Continue</button>
        </div>` : ''}
      <div id="signin-msg"></div>
    </div>`);

  if (campaign.google_client_id) mountGoogle();
  else if (!campaign.dev_identity) $('#signin-msg').innerHTML =
    note('warn', '<b>Google sign-in is not configured yet.</b><br>Please contact the Media Crew — registration cannot accept submissions until it is set up.');

  const dev = $('#dev-go');
  if (dev) dev.onclick = () => {
    const email = ($('#dev-email').value || '').trim();
    if (!email) return;
    checkIdentity({ dev_email: email });
  };
}
/* Google Identity Services, loaded only when a client id is actually configured. */
function mountGoogle() {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: campaign.google_client_id,
      callback: r => checkIdentity({ id_token: r.credential }),
    });
    google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
  };
  s.onerror = () => { $('#signin-msg').innerHTML = note('bad', 'Could not load Google sign-in. Please check your connection and reload.'); };
  document.head.appendChild(s);
}
/* The domain rule is enforced on the SERVER — this call is what tells us whether
   the account is acceptable, and whether it has already applied. */
async function checkIdentity(auth) {
  $('#signin-msg').innerHTML = `<div class="hint" style="margin-top:12px">Checking your account…</div>`;
  try {
    const r = await api('/lookup', auth);
    identity = { ...auth, email: r.email, name: r.name };
    if (r.existing && ['approved','rejected'].includes(r.existing.status)) return renderAlready(r.existing);
    if (r.existing) return renderForm(r.existing);
    renderForm(null);
  } catch (e) {
    $('#signin-msg').innerHTML = note('bad', '<b>University account required</b><br>' + esc(e.message));
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
    <div class="card"><div class="who">✓ Signed in as ${esc(identity.email)}</div></div>

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
      ...identity, name, applicant_type: type, department: dept,
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
