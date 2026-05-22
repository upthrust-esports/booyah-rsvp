// ─────────────────────────────────────────────────────────────────
// rsvp.js — attendee RSVP page logic
// Served as a static file from /public/rsvp.js
// ─────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Init Lucide icons ─────────────────────────────────────────
  lucide.createIcons();

  // ── Parse URL params ──────────────────────────────────────────
  const p          = new URLSearchParams(window.location.search);
  const tid        = p.get('tid')    || 'TCK-DEMO';
  const name       = decodeURIComponent(p.get('name')  || 'Attendee');
  const email      = decodeURIComponent(p.get('email') || '');
  const pass       = decodeURIComponent(p.get('pass')  || 'Booyah Pass');
  const src        = p.get('src')    || 'direct';
  const preConfirm = p.get('confirm'); // YES | NO — from email button click

  // ── Populate static UI ────────────────────────────────────────
  document.getElementById('nameEl').textContent   = name;
  document.getElementById('emailEl').textContent  = email || '—';
  document.getElementById('avatarEl').textContent =
    name.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  // ── Apps Script URL (injected via window.__RSVP_CONFIG__) ─────
  const SCRIPT_URL = window.__RSVP_CONFIG__?.scriptUrl || '';

  // ── Pending response state ────────────────────────────────────
  // When user arrives via email link, we stage the response here
  // instead of auto-submitting, so they can fill pincode first.
  let pendingResponse = null; // 'YES' | 'NO' | null

  // ── Load existing RSVP status from Apps Script (GET) ─────────
  async function loadStatus() {
    if (!SCRIPT_URL) return;
    try {
      const r = await fetch(`${SCRIPT_URL}?action=get&tid=${encodeURIComponent(tid)}`);
      const d = await r.json();
      if (d.status === 'ok') showStatus(d.current);
    } catch (e) {
      console.warn('loadStatus failed:', e.message);
    }
  }

  function showStatus(c) {
    if (!c) return;
    document.getElementById('yesBar').classList.toggle('show', c.response === 'YES');
    document.getElementById('noBar').classList.toggle('show',  c.response === 'NO');
    document.getElementById('yesTime').textContent = 'Last updated: ' + c.time;
    document.getElementById('noTime').textContent  = 'Last updated: ' + c.time;
    document.getElementById('yesBtn').classList.toggle('yes-active', c.response === 'YES');
    document.getElementById('noBtn').classList.toggle('no-active',   c.response === 'NO');

    // Pre-fill + lock pincode if already saved in sheet
    if (c.pincode) {
      const inp = document.getElementById('pincodeInput');
      inp.value    = c.pincode;
      inp.disabled = true;
    }
  }

  // ── Stage a response (highlight button, show submit bar) ──────
  // Called by Yes/No button clicks AND by preConfirm from email link
  window.stageResponse = function (resp) {
    pendingResponse = resp;

    // Update button highlight
    document.getElementById('yesBtn').classList.toggle('yes-active', resp === 'YES');
    document.getElementById('noBtn').classList.toggle('no-active',   resp === 'NO');
    // Remove opposite active state
    if (resp === 'YES') document.getElementById('noBtn').classList.remove('no-active');
    if (resp === 'NO')  document.getElementById('yesBtn').classList.remove('yes-active');

    // Show the submit bar
    const bar = document.getElementById('submitBar');
    bar.style.display = 'block';

    // Update submit bar label, hint and button text based on response
    const label = document.getElementById('submitBarLabel');
    const hint  = document.getElementById('submitBarHint');
    const btn   = document.getElementById('submitBtn');

    if (resp === 'YES') {
      label.textContent = "You're saying YES 🎉";
      label.style.color = 'var(--color-green)';
      hint.textContent  = 'Add your pincode above (optional), then confirm your attendance.';
      btn.textContent   = "Yes, confirm my attendance →";
      btn.style.background = 'var(--color-gold)';
      btn.style.color      = '#0C0A14';
    } else {
      label.textContent = "You're saying Can't make it";
      label.style.color = 'var(--color-red-val)';
      hint.textContent  = 'Add your pincode above (optional), then confirm you can\'t attend.';
      btn.textContent   = "Confirm I can't make it →";
      btn.style.background = 'rgba(230,59,46,0.15)';
      btn.style.color      = 'var(--color-red-val)';
    }

    // Scroll submit bar into view smoothly
    setTimeout(() => bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  };

  // ── Final submit — called by the submit button ────────────────
  window.confirmSubmit = async function () {
    if (!pendingResponse) return;

    const pincodeVal = document.getElementById('pincodeInput').value.trim();
    const errEl      = document.getElementById('pincodeError');
    const inpEl      = document.getElementById('pincodeInput');

    // Validate pincode if filled
    if (pincodeVal && pincodeVal.length !== 6) {
      errEl.style.display     = 'block';
      inpEl.style.borderColor = 'var(--color-red-val)';
      inpEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errEl.style.display     = 'none';
    inpEl.style.borderColor = '';

    // Disable both RSVP buttons + submit button during send
    const yb  = document.getElementById('yesBtn');
    const nb  = document.getElementById('noBtn');
    const sub = document.getElementById('submitBtn');
    yb.disabled = nb.disabled = sub.disabled = true;

    document.getElementById('loadingEl').style.display = 'block';
    document.getElementById('errorBox').style.display  = 'none';
    document.getElementById('yesBar').classList.remove('show');
    document.getElementById('noBar').classList.remove('show');

    try {
      const res = await fetch('/api/rsvp/respond', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:   'rsvp',
          tid, name, email, pass,
          response: pendingResponse,
          source:   src,
          pincode:  pincodeVal,
          ua:       navigator.userAgent.slice(0, 200),
          ts:       new Date().toISOString()
        })
      });

      const data = await res.json();
      document.getElementById('loadingEl').style.display = 'none';

      if (data.status === 'ok' || data.status === 'sent') {
        // Lock pincode after successful submit
        if (pincodeVal) inpEl.disabled = true;

        // Hide submit bar after success
        document.getElementById('submitBar').style.display = 'none';

        showStatus({
          response: pendingResponse,
          pincode:  pincodeVal,
          time:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        });

        pendingResponse = null;
      } else {
        throw new Error(data.message || 'Unknown error');
      }

    } catch (e) {
      document.getElementById('loadingEl').style.display = 'none';
      const eb       = document.getElementById('errorBox');
      eb.textContent = 'Could not save your response. Please try again.';
      eb.style.display = 'block';
      console.error('confirmSubmit failed:', e.message);
    }

    yb.disabled = nb.disabled = sub.disabled = false;
  };

  // Keep submitRSVP as an alias so onclick="submitRSVP('YES')" still works
  // but now it just stages instead of immediately submitting
  window.submitRSVP = window.stageResponse;

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    await loadStatus();

    // If user came from email link with ?confirm=YES/NO,
    // stage the response so they see the submit button + can add pincode
    if (preConfirm === 'YES' || preConfirm === 'NO') {
      // Small delay so the page renders first
      setTimeout(() => window.stageResponse(preConfirm), 400);
    }
  }

  init();
})();