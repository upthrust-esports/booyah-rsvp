// ─────────────────────────────────────────────────────────────────
// rsvp.js — attendee RSVP page logic
// Served as a static file from /public/rsvp.js
// ─────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Init Lucide icons ─────────────────────────────────────────
  lucide.createIcons();

  // ── Parse URL params ──────────────────────────────────────────
  const p    = new URLSearchParams(window.location.search);
  const tid  = p.get('tid')  || 'TCK-DEMO';
  const name = decodeURIComponent(p.get('name')  || 'Attendee');
  const email= decodeURIComponent(p.get('email') || '');
  const pass = decodeURIComponent(p.get('pass')  || 'Booyah Pass');
  const src  = p.get('src')  || 'direct';
  const preConfirm = p.get('confirm'); // YES | NO — auto-submit on load

  // ── Populate UI ───────────────────────────────────────────────
  document.getElementById('nameEl').textContent   = name;
  document.getElementById('emailEl').textContent  = email || '—';
  document.getElementById('avatarEl').textContent =
    name.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  // ── Load existing RSVP status from Apps Script (GET) ─────────
  // Still hits Apps Script directly — GET requests don't have CORS issues
  const SCRIPT_URL = window.__RSVP_CONFIG__?.scriptUrl || '';

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

  // ── Submit RSVP via Node server proxy ─────────────────────────
  // Posting to /api/rsvp/respond instead of directly to Apps Script
  // so the server can forward as proper JSON (no CORS / no-cors issues)
  let busy = false;

  window.submitRSVP = async function (resp) {
    if (busy) return;

    // Validate pincode — optional but must be 6 digits if filled
    const pincodeVal = document.getElementById('pincodeInput').value.trim();
    const errEl      = document.getElementById('pincodeError');
    const inpEl      = document.getElementById('pincodeInput');

    if (pincodeVal && pincodeVal.length !== 6) {
      errEl.style.display     = 'block';
      inpEl.style.borderColor = 'var(--color-red-val)';
      return;
    }
    errEl.style.display     = 'none';
    inpEl.style.borderColor = '';

    busy = true;
    const yb = document.getElementById('yesBtn');
    const nb = document.getElementById('noBtn');
    yb.disabled = nb.disabled = true;

    document.getElementById('loadingEl').style.display = 'block';
    document.getElementById('errorBox').style.display  = 'none';
    document.getElementById('yesBar').classList.remove('show');
    document.getElementById('noBar').classList.remove('show');
    yb.classList.remove('yes-active');
    nb.classList.remove('no-active');

    try {
      const res = await fetch('/api/rsvp/respond', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:   'rsvp',
          tid, name, email, pass,
          response: resp,
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
        if (pincodeVal) {
          inpEl.disabled = true;
        }
        showStatus({
          response: resp,
          pincode:  pincodeVal,
          time:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        });
      } else {
        throw new Error(data.message || 'Unknown error');
      }

    } catch (e) {
      document.getElementById('loadingEl').style.display = 'none';
      const eb = document.getElementById('errorBox');
      eb.textContent   = 'Could not save your response. Please try again.';
      eb.style.display = 'block';
      console.error('submitRSVP failed:', e.message);
    }

    yb.disabled = nb.disabled = busy = false;
  };

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    await loadStatus();
    // Auto-submit if ?confirm=YES or ?confirm=NO in URL (from email button)
    if (preConfirm === 'YES' || preConfirm === 'NO') {
      setTimeout(() => window.submitRSVP(preConfirm), 600);
    }
  }

  init();
})();