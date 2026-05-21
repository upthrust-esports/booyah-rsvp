require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const { parse } = require('csv-parse/sync');
const axios    = require('axios');
const nodemailer = require('nodemailer');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory sent state (synced from Google Sheet on startup) ───
// Structure: Map<txnId, { wa: bool, email: bool }>
// This is the dedup guard — if server restarts, it re-fetches from sheet
let sentState = new Map();

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (rsvp.html, admin.html, banner.jpg)
app.use(express.static(path.join(__dirname, '../public')));

// Upload dir for CSV (temp, in memory only)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Simple admin auth middleware ────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

// ═════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (called by rsvp.html — attendee facing)
// ═════════════════════════════════════════════════════════════════

// Public config endpoint — safe to expose (script URL is already public)
app.get('/api/config', (req, res) => {
  res.json({ GOOGLE_SCRIPT_URL: process.env.GOOGLE_SCRIPT_URL });
});

// Proxy to Google Apps Script — keeps the script URL secret from client
app.get('/api/rsvp/status', async (req, res) => {
  try {
    const { tid } = req.query;
    if (!tid) return res.json({ status: 'error', message: 'Missing tid' });

    const r = await axios.get(process.env.GOOGLE_SCRIPT_URL, {
      params: { action: 'get', tid },
      timeout: 8000
    });
    res.json(r.data);
  } catch (e) {
    console.error('GET status error:', e.message);
    res.json({ status: 'error', message: 'Could not fetch status' });
  }
});

app.post('/api/rsvp/respond', async (req, res) => {
  try {
    const r = await axios.post(process.env.GOOGLE_SCRIPT_URL,
      { action: 'rsvp', ...req.body },
      { timeout: 8000 }
    );
    res.json(r.data);
  } catch (e) {
    console.error('POST rsvp error:', e.message);
    res.json({ status: 'error', message: 'Could not save response' });
  }
});

// ═════════════════════════════════════════════════════════════════
// ADMIN ROUTES (called by admin.html — protected)
// ═════════════════════════════════════════════════════════════════

// ── Parse & deduplicate CSV ───────────────────────────────────────
app.post('/api/admin/parse-csv', adminAuth, upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.json({ status: 'error', message: 'No file uploaded' });

    const text    = req.file.buffer.toString('utf-8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });

    // Deduplicate by Transaction ID — keep first row per txn
    const seen = new Map();
    let rawCount = 0;

    for (const r of records) {
      rawCount++;
      const txnId = (r['Transaction ID'] || '').trim();
      if (!txnId || seen.has(txnId)) continue;

      const email = (r['Email'] || '').trim().toLowerCase();
      const phone = (r['Phone'] || '').trim().replace(/\s/g, '');

      seen.set(txnId, {
        txnId,
        shortcode:   (r['Shortcode']    || '').trim(),
        name:        (r['Name']         || '').trim(),
        email,
        phone,
        ticketName:  (r['Ticket Name']  || '').trim(),
        ticketGroup: (r['Ticket Group'] || '').trim(),
        waSent:      false,
        emailSent:   false,
      });
    }

    // Filter out contacts with no email AND no phone
    const contacts = Array.from(seen.values()).filter(c => c.email || c.phone);
    const duped    = rawCount - contacts.length;

    // Merge with current sent state from memory
    contacts.forEach(c => {
      const s = sentState.get(c.txnId);
      if (s) { c.waSent = s.wa; c.emailSent = s.email; }
    });

    res.json({
      status:   'ok',
      contacts,
      rawCount,
      unique:   contacts.length,
      duped,
    });
  } catch (e) {
    console.error('CSV parse error:', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

// ── Get sent state from Google Sheet ─────────────────────────────
app.get('/api/admin/sent-state', adminAuth, async (req, res) => {
  try {
    const r = await axios.get(process.env.GOOGLE_SCRIPT_URL, {
      params: { action: 'get_sent' },
      timeout: 15000
    });
    // Cache in server memory
    if (r.data.sentMap) {
      sentState = new Map(Object.entries(r.data.sentMap));
      console.log(`Synced ${sentState.size} sent records from sheet`);
    }
    res.json(r.data);
  } catch (e) {
    console.error('get_sent error:', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

// ── Send WhatsApp to one contact ──────────────────────────────────
app.post('/api/admin/send-wa', adminAuth, async (req, res) => {
  const { txnId, name, email, phone, ticketName } = req.body;

  // Server-side dedup check
  const already = sentState.get(txnId);
  if (already?.wa) {
    return res.json({ status: 'skip', reason: 'Already sent via WhatsApp' });
  }

  if (!phone) return res.json({ status: 'skip', reason: 'No phone number' });
  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    return res.json({ status: 'error', reason: 'WhatsApp not configured' });
  }

  // Build RSVP link
  const link = buildRsvpLink({ txnId, name, email, ticketName, src: 'wa' });

  // Build message
  const msg = (process.env.WA_TEMPLATE || 'Hi {name}, confirm your attendance: {link}')
    .replace(/{name}/g, name || 'there')
    .replace(/{link}/g, link)
    .replace(/\\n/g, '\n');

  // Normalize phone to international format
  let normalizedPhone = phone.replace(/[^\d]/g, '');
  if (normalizedPhone.startsWith('0'))   normalizedPhone = '91' + normalizedPhone.slice(1);
  if (normalizedPhone.length === 10)     normalizedPhone = '91' + normalizedPhone;

  try {
    const waRes = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to:   normalizedPhone,
        type: 'text',
        text: { body: msg },
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        },
        timeout: 10000,
      }
    );

    const msgId = waRes.data?.messages?.[0]?.id || '';

    // Update in-memory sent state
    const cur = sentState.get(txnId) || { wa: false, email: false };
    cur.wa = true;
    sentState.set(txnId, cur);

    // Persist to Google Sheet (fire and forget — don't block response)
    persistSentToSheet({ txnId, name, email, phone, channel: 'wa', ticketName, msgId });

    res.json({ status: 'sent', msgId });
  } catch (e) {
    const waError = e.response?.data?.error?.message || e.message;
    console.error(`WA send failed for ${phone}:`, waError);
    res.json({ status: 'failed', reason: waError });
  }
});

// ── Send Email to one contact ─────────────────────────────────────
app.post('/api/admin/send-email', adminAuth, async (req, res) => {
  const { txnId, name, email, ticketName } = req.body;

  // Server-side dedup check
  const already = sentState.get(txnId);
  if (already?.email) {
    return res.json({ status: 'skip', reason: 'Already sent via Email' });
  }

  if (!email) return res.json({ status: 'skip', reason: 'No email address' });
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.json({ status: 'error', reason: 'Email not configured' });
  }

  const link = buildRsvpLink({ txnId, name, email, ticketName, src: 'email' });

  // Read email template and inject values
  let htmlBody = getEmailHtml(name, ticketName, link);

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const info = await transporter.sendMail({
      from:    `"${process.env.EMAIL_FROM_NAME || 'The Booyah Awards'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to:      email,
      subject: process.env.EMAIL_SUBJECT || "You're invited — Confirm your attendance 🎉",
      html:    htmlBody,
    });

    // Update in-memory sent state
    const cur = sentState.get(txnId) || { wa: false, email: false };
    cur.email = true;
    sentState.set(txnId, cur);

    // Persist to Google Sheet
    persistSentToSheet({ txnId, name, email, phone: '', channel: 'email', ticketName, msgId: info.messageId });

    res.json({ status: 'sent', msgId: info.messageId });
  } catch (e) {
    console.error(`Email send failed for ${email}:`, e.message);
    res.json({ status: 'failed', reason: e.message });
  }
});

// ── Persist sent record to Google Sheet (non-blocking) ───────────
async function persistSentToSheet({ txnId, name, email, phone, channel, ticketName, msgId }) {
  try {
    await axios.post(process.env.GOOGLE_SCRIPT_URL, {
      action: 'mark_sent',
      txnId, name, email, phone, channel, ticketName, msgId: msgId || ''
    }, { timeout: 8000 });
  } catch (e) {
    console.warn('persistSentToSheet failed (non-critical):', e.message);
  }
}

// ── Build RSVP link ───────────────────────────────────────────────
function buildRsvpLink({ txnId, name, email, ticketName, src }) {
  const base = (process.env.RSVP_PAGE_URL || `http://localhost:${PORT}/rsvp.html`).replace(/\/$/, '');
  const p = new URLSearchParams({ tid: txnId, name, email, pass: ticketName, src });
  return `${base}?${p.toString()}`;
}

// ── Email HTML builder ────────────────────────────────────────────
function getEmailHtml(name, ticketName, rsvpLink) {
  const templatePath = path.join(__dirname, '../public/rsvp_email_template.html');
 
  // Build the base RSVP URL with all params baked in
  // rsvpLink already contains ?tid=...&name=...&email=...&pass=...&src=email
  // We just need to append &confirm=YES or &confirm=NO — done in the template
 
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8')
      // Text placeholders
      .replace(/{{NAME}}/g,       name       || 'there')
      .replace(/{{PASS}}/g,       ticketName || 'Booyah Pass')
      .replace(/{{TICKET_ID}}/g,  extractParam(rsvpLink, 'tid'))
 
      // URL-encoded placeholders used inside the href query strings
      .replace(/{{NAME_ENC}}/g,   encodeURIComponent(name       || ''))
      .replace(/{{EMAIL_ENC}}/g,  encodeURIComponent(extractParam(rsvpLink, 'email') || ''))
      .replace(/{{PASS_ENC}}/g,   encodeURIComponent(ticketName || 'Booyah Pass'))
 
      // Keep legacy YES/NO link placeholders working too (in case you switch back)
      .replace(/{{RSVP_YES_LINK}}/g, rsvpLink + '&confirm=YES')
      .replace(/{{RSVP_NO_LINK}}/g,  rsvpLink + '&confirm=NO')
 
      // Unsubscribe — replace with your real unsubscribe URL if you have one
      .replace(/{{UNSUBSCRIBE_LINK}}/g, '#');
  }
 
  // Minimal fallback if template file missing
  return `<p>Hi ${name},</p>
<p>Confirm your attendance for <strong>The Booyah Awards 2026</strong>:</p>
<p><a href="${rsvpLink}&confirm=YES">Yes, I'll be there</a> &nbsp;|&nbsp; <a href="${rsvpLink}&confirm=NO">Can't make it</a></p>`;
}
 
// Helper — pull a param value out of a URL string
function extractParam(url, key) {
  try {
    return new URL(url).searchParams.get(key) || '';
  } catch(e) {
    const match = url.match(new RegExp('[?&]' + key + '=([^&]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }
}

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sentStateSize: sentState.size,
    env: {
      googleScript: !!process.env.GOOGLE_SCRIPT_URL,
      whatsapp:     !!process.env.WA_ACCESS_TOKEN,
      smtp:         !!process.env.SMTP_PASS,
    }
  });
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 Booyah RSVP server running on http://localhost:${PORT}`);
  console.log(`   RSVP page  → http://localhost:${PORT}/rsvp.html`);
  console.log(`   Admin panel → http://localhost:${PORT}/admin.html`);
  console.log(`   Health      → http://localhost:${PORT}/health\n`);

  // On startup, sync sent state from Google Sheet into memory
  if (process.env.GOOGLE_SCRIPT_URL) {
    try {
      const r = await axios.get(process.env.GOOGLE_SCRIPT_URL, {
        params: { action: 'get_sent' }, timeout: 15000
      });
      if (r.data.sentMap) {
        sentState = new Map(Object.entries(r.data.sentMap));
        console.log(`✅ Synced ${sentState.size} sent records from Google Sheet`);
      }
    } catch (e) {
      console.warn('⚠️  Could not sync sent state on startup:', e.message);
    }
  }
});

// ── Bulk mark sent (called from admin after a send run) ──────────
app.post('/api/admin/bulk-mark-sent', adminAuth, async (req, res) => {
  const { records } = req.body;
  if (!records?.length) return res.json({ status: 'ok', written: 0 });
  try {
    const r = await axios.post(process.env.GOOGLE_SCRIPT_URL,
      { action: 'bulk_mark_sent', records },
      { timeout: 15000 }
    );
    // Also update in-memory state
    records.forEach(r => {
      const cur = sentState.get(r.txnId) || { wa: false, email: false };
      if (r.channel === 'wa')    cur.wa    = true;
      if (r.channel === 'email') cur.email = true;
      sentState.set(r.txnId, cur);
    });
    res.json(r.data);
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});
