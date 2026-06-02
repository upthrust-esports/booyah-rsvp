require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory sent state (synced from Google Sheet on startup) ───
let sentState = new Map();

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Simple admin auth middleware ────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

// ═════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  res.json({ GOOGLE_SCRIPT_URL: process.env.GOOGLE_SCRIPT_URL });
});

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
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════

// ── Parse & deduplicate CSV ───────────────────────────────────────
app.post('/api/admin/parse-csv', adminAuth, upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.json({ status: 'error', message: 'No file uploaded' });

    const text    = req.file.buffer.toString('utf-8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });

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
        pincode:     '',
        waSent:      false,
        emailSent:   false,
      });
    }

    const contacts = Array.from(seen.values()).filter(c => c.email || c.phone);
    const duped    = rawCount - contacts.length;

    contacts.forEach(c => {
      const s = sentState.get(c.txnId);
      if (s) { c.waSent = s.wa; c.emailSent = s.email; }
    });

    res.json({ status: 'ok', contacts, rawCount, unique: contacts.length, duped });
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

  const already = sentState.get(txnId);
  if (already?.wa) {
    return res.json({ status: 'skip', reason: 'Already sent via WhatsApp' });
  }

  if (!phone) return res.json({ status: 'skip', reason: 'No phone number' });
  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    return res.json({ status: 'error', reason: 'WhatsApp not configured' });
  }

  const link = buildRsvpLink({ txnId, name, email, ticketName, src: 'wa' });

  const baseUrl   = (process.env.RSVP_PAGE_URL || `http://localhost:${PORT}/rsvp.html`).replace(/\/$/, '');
  const urlSuffix = link.replace(baseUrl, '');

  let normalizedPhone = phone.replace(/[^\d]/g, '');
  if (normalizedPhone.startsWith('0'))  normalizedPhone = '91' + normalizedPhone.slice(1);
  if (normalizedPhone.length === 10)    normalizedPhone = '91' + normalizedPhone;

  try {
    const waRes = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to:   normalizedPhone,
        type: 'template',
        template: {
          name:     process.env.WA_TEMPLATE_NAME || 'booyah_rsvp',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: name       || 'Guest' },
                { type: 'text', text: ticketName || 'Pass'  },
              ]
            },
            {
              type:     'button',
              sub_type: 'url',
              index:    '0',
              parameters: [
                { type: 'text', text: urlSuffix }
              ]
            }
          ]
        }
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

    const cur = sentState.get(txnId) || { wa: false, email: false };
    cur.wa = true;
    sentState.set(txnId, cur);

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

  const already = sentState.get(txnId);
  if (already?.email) {
    return res.json({ status: 'skip', reason: 'Already sent via Email' });
  }

  if (!email) return res.json({ status: 'skip', reason: 'No email address' });
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.json({ status: 'error', reason: 'Email not configured' });
  }

  const link    = buildRsvpLink({ txnId, name, email, ticketName, src: 'email' });
  const htmlBody = getEmailHtml(name, ticketName, link);

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

    const cur = sentState.get(txnId) || { wa: false, email: false };
    cur.email = true;
    sentState.set(txnId, cur);

    persistSentToSheet({ txnId, name, email, phone: '', channel: 'email', ticketName, msgId: info.messageId });

    res.json({ status: 'sent', msgId: info.messageId });
  } catch (e) {
    console.error(`Email send failed for ${email}:`, e.message);
    res.json({ status: 'failed', reason: e.message });
  }
});

// ── Get RSVP responses from sheet (for reminder variant detection) ─
app.get('/api/admin/rsvp-responses', adminAuth, async (req, res) => {
  try {
    const r = await axios.get(process.env.GOOGLE_SCRIPT_URL, {
      params: { action: 'get_rsvp_responses' },
      timeout: 15000
    });
    res.json(r.data);
  } catch (e) {
    console.error('get_rsvp_responses error:', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

// ── Send reminder email to one contact ───────────────────────────
// Variant logic:
//   ticketGroup === 'Tickets'              → C (Paid, UID form button)
//   ticketGroup === 'RSVP' + hasResponded  → A (reminder + attractions + FAQs)
//   ticketGroup === 'RSVP' + !hasResponded → B (reminder + attractions + FAQs + RSVP buttons)
app.post('/api/admin/send-reminder', adminAuth, async (req, res) => {
  const { txnId, name, email, ticketName, ticketGroup, hasResponded } = req.body;

  if (!email)  return res.json({ status: 'skip', reason: 'No email address' });
  if (!txnId)  return res.json({ status: 'skip', reason: 'No txnId' });

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.json({ status: 'error', reason: 'Email not configured' });
  }

  const isPaid = (ticketGroup || '').trim() === 'Tickets';
  let variant;
  if (isPaid)          variant = 'C';
  else if (hasResponded) variant = 'A';
  else                   variant = 'B';

  const rsvpLink   = buildRsvpLink({ txnId, name, email, ticketName, src: 'reminder' });
  const uidFormLink = process.env.UID_FORM_URL || '#';
  const htmlBody   = getReminderEmailHtml({ name, ticketName, variant, rsvpLink, uidFormLink });

  const subjectMap = {
    A: process.env.REMINDER_SUBJECT_A || "The Booyah Awards is almost here — here's what to expect 🎉",
    B: process.env.REMINDER_SUBJECT_B || "You haven't confirmed yet — The Booyah Awards is in 4 days!",
    C: process.env.REMINDER_SUBJECT_C || "You're on the paid list — share your UID to unlock your rewards 💎",
  };

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const info = await transporter.sendMail({
      from:    `"${process.env.EMAIL_FROM_NAME || 'The Booyah Awards'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to:      email,
      subject: subjectMap[variant],
      html:    htmlBody,
    });

    persistSentToSheet({
      txnId, name, email, phone: '',
      channel: `reminder_${variant}`,
      ticketName,
      msgId: info.messageId
    });

    res.json({ status: 'sent', variant, msgId: info.messageId });
  } catch (e) {
    console.error(`Reminder email failed for ${email}:`, e.message);
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

// ── Bulk mark sent ────────────────────────────────────────────────
app.post('/api/admin/bulk-mark-sent', adminAuth, async (req, res) => {
  const { records } = req.body;
  if (!records?.length) return res.json({ status: 'ok', written: 0 });
  try {
    const r = await axios.post(process.env.GOOGLE_SCRIPT_URL,
      { action: 'bulk_mark_sent', records },
      { timeout: 15000 }
    );
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

// ═════════════════════════════════════════════════════════════════
// EMAIL HTML BUILDERS
// ═════════════════════════════════════════════════════════════════

// ── Build RSVP link ───────────────────────────────────────────────
function buildRsvpLink({ txnId, name, email, ticketName, src }) {
  const base = (process.env.RSVP_PAGE_URL || `http://localhost:${PORT}/rsvp.html`).replace(/\/$/, '');
  const p = new URLSearchParams({ tid: txnId, name, email, pass: ticketName, src });
  return `${base}?${p.toString()}`;
}

function extractParam(url, key) {
  try {
    return new URL(url).searchParams.get(key) || '';
  } catch(e) {
    const match = url.match(new RegExp('[?&]' + key + '=([^&]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }
}

// ── Original RSVP email builder ───────────────────────────────────
function getEmailHtml(name, ticketName, rsvpLink) {
  const templatePath = path.join(__dirname, '../public/rsvp_email_template.html');

  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8')
      .replace(/{{NAME}}/g,       name       || 'there')
      .replace(/{{PASS}}/g,       ticketName || 'Booyah Pass')
      .replace(/{{TICKET_ID}}/g,  extractParam(rsvpLink, 'tid'))
      .replace(/{{NAME_ENC}}/g,   encodeURIComponent(name       || ''))
      .replace(/{{EMAIL_ENC}}/g,  encodeURIComponent(extractParam(rsvpLink, 'email') || ''))
      .replace(/{{PASS_ENC}}/g,   encodeURIComponent(ticketName || 'Booyah Pass'))
      .replace(/{{RSVP_YES_LINK}}/g, rsvpLink + '&confirm=YES')
      .replace(/{{RSVP_NO_LINK}}/g,  rsvpLink + '&confirm=NO')
      .replace(/{{UNSUBSCRIBE_LINK}}/g, '#');
  }

  return `<p>Hi ${name},</p>
<p>Confirm your attendance for <strong>The Booyah Awards 2026</strong>:</p>
<p><a href="${rsvpLink}&confirm=YES">Yes, I'll be there</a> &nbsp;|&nbsp; <a href="${rsvpLink}&confirm=NO">Can't make it</a></p>`;
}

// ── Reminder email builder ────────────────────────────────────────
function getReminderEmailHtml({ name, ticketName, variant, rsvpLink, uidFormLink }) {
  const isPaid = variant === 'C';

  const attractions = [
    { icon: '🎮', label: 'FFM Themed Zones',                          desc: 'Guess the Voice, Guess the Emote, Hammer Challenge and more' },
    { icon: '🏆', label: 'Fan Games & Challenges',                    desc: 'Compete in live challenges on the floor' },
    { icon: '📸', label: 'Giant Photo Ops & Interactive Installations', desc: 'Photo Booth, Scream Machine, Create Your Own Avatar' },
    { icon: '🌟', label: 'Meet Your Favourite Creators',              desc: 'Total Gaming, Desi Gamer, Sooneeta, Munna Bhai & many more' },
    { icon: '👕', label: 'Exclusive Merch & Custom Prints',           desc: 'Official Booyah Awards merchandise available on-site' },
    { icon: '📍', label: 'Squad-Worthy Photo Spots',                  desc: 'Iconic Free Fire MAX themed backdrops across the venue' },
  ];

  const attractionRows = attractions.map(a => `
    <tr>
      <td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="width:34px;vertical-align:middle;">
            <div style="width:34px;height:34px;background:rgba(245,200,66,0.1);border-radius:8px;border:1px solid rgba(245,200,66,0.18);text-align:center;line-height:34px;font-size:15px;">${a.icon}</div>
          </td>
          <td style="padding-left:12px;vertical-align:middle;">
            <div style="font-size:13px;font-weight:700;color:#E8E3F2;">${a.label}</div>
            <div style="font-size:11px;color:#7A748F;margin-top:2px;">${a.desc}</div>
          </td>
        </tr></table>
      </td>
    </tr>`).join('');

  // FAQ rows — placeholder answers to be replaced once client confirms
  const faqs = [
    { q: 'What time should I arrive?',    a: 'Gates open at [GATES_TIME]. We recommend arriving early to explore all the zones before the show begins.' },
    { q: 'What do I need to bring?',      a: 'Your entry ticket QR code (digital or printed). A valid photo ID is recommended.' },
    { q: 'Is re-entry allowed?',          a: 'Yes, re-entry is permitted throughout the event.' },
    { q: 'What is the age restriction?',  a: '16 years and above. Attendees below 18 must be accompanied by a parent or guardian.' },
    { q: 'How do I get there?',           a: 'Take the Aqua Line metro to Knowledge Park II or Pari Chowk. Free Booyah Awards shuttles will be waiting at the metro exit — no last-mile stress.' },
  ];

  const faqRows = faqs.map(f => `
    <tr>
      <td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:12px;font-weight:700;color:#F5C842;margin-bottom:4px;">${f.q}</div>
        <div style="font-size:12px;color:#d4d4d4;line-height:1.6;">${f.a}</div>
      </td>
    </tr>`).join('');

  // Paid perks block — Variant C only
  const paidPerksBlock = isPaid ? `
    <tr>
      <td style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;font-weight:600;">Your Paid Ticket Perks</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="font-size:13px;color:#2ECC82;">✓</span>&nbsp;<span style="font-size:13px;color:#E8E3F2;font-weight:600;">Exclusive Free Merch</span>
          </td></tr>
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="font-size:13px;color:#2ECC82;">✓</span>&nbsp;<span style="font-size:13px;color:#E8E3F2;font-weight:600;">1000 Free Diamonds</span>
          </td></tr>
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:11px 16px;">
            <span style="font-size:13px;color:#2ECC82;">✓</span>&nbsp;<span style="font-size:13px;color:#E8E3F2;font-weight:600;">Closer Seating to FFM Creators &amp; Esports Stars</span>
          </td></tr>
        </table>
      </td>
    </tr>` : '';

  // CTA block — depends on variant
  let ctaBlock = '';

  if (variant === 'B') {
    const yesLink = rsvpLink + '&confirm=YES';
    const noLink  = rsvpLink + '&confirm=NO';
    ctaBlock = `
    <tr>
      <td style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;font-weight:600;">Confirm Your Attendance</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
          <tr><td align="center">
            <a href="${yesLink}" target="_blank"
              style="display:block;width:100%;background-color:#F5C842;color:#0C0A14;text-decoration:none;font-size:16px;font-weight:800;padding:17px 24px;border-radius:13px;text-align:center;font-family:'Arial Black','Helvetica Neue',Arial,sans-serif;box-sizing:border-box;">
              🎉 &nbsp;Yes, I'll be there!
            </a>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="${noLink}" target="_blank"
              style="display:block;width:100%;background-color:transparent;color:#d4d4d4;text-decoration:none;font-size:14px;font-weight:500;padding:14px 24px;border-radius:13px;text-align:center;border:1px solid rgba(255,255,255,0.12);box-sizing:border-box;">
              Can't make it
            </a>
          </td></tr>
        </table>
      </td>
    </tr>`;
  }

  if (variant === 'C') {
    ctaBlock = `
    <tr>
      <td style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-weight:600;">One Last Step</div>
        <p style="margin:0 0 16px;font-size:13px;color:#d4d4d4;line-height:1.7;">
          Share your in-game UID so we can credit your <strong style="color:#F5C842;">1000 Free Diamonds</strong> before the event.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center">
            <a href="${uidFormLink}" target="_blank"
              style="display:block;width:100%;background-color:#F5C842;color:#0C0A14;text-decoration:none;font-size:16px;font-weight:800;padding:17px 24px;border-radius:13px;text-align:center;font-family:'Arial Black','Helvetica Neue',Arial,sans-serif;box-sizing:border-box;">
              🎮 &nbsp;Share Your UID
            </a>
          </td></tr>
        </table>
      </td>
    </tr>`;
  }

  const greetingCopy = {
    A: `Your ticket for <strong style="color:#F5C842;">The Booyah Awards 2026</strong> is confirmed. The event is almost here — here's everything you need to know before you show up.`,
    B: `Your ticket for <strong style="color:#F5C842;">The Booyah Awards 2026</strong> is confirmed. We noticed you haven't responded to your RSVP yet — please let us know if you'll be attending, it helps us plan for you.`,
    C: `You're on the paid list for <strong style="color:#F5C842;">The Booyah Awards 2026</strong>. The event is almost here — check out what's in store, and complete one quick step to unlock your exclusive rewards.`,
  };

  const preheaderMap = {
    A: 'The Booyah Awards 2026 is almost here — here\'s what to expect on the day',
    B: 'You haven\'t confirmed yet — The Booyah Awards is just days away',
    C: 'Share your UID to unlock 1000 Free Diamonds before the event',
  };

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>The Booyah Awards 2026</title>
<style type="text/css">
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  body,#body-wrap,.outer-td,.outer-bg{background-color:#0C0A14 !important;}
  [data-ogsc] body,[data-ogsc] #body-wrap,[data-ogsc] .outer-td{background-color:#0C0A14 !important;}
  @media (prefers-color-scheme:dark){body,.outer-bg,.outer-td{background-color:#0C0A14 !important;}}
  @media only screen and (max-width:600px){
    .email-container{width:100% !important;}
    .pad-mobile{padding:18px 20px !important;}
    .hero-img{border-radius:14px 14px 0 0 !important;}
    .footer-radius{border-radius:0 0 14px 14px !important;}
  }
</style>
</head>
<body id="body-wrap" style="margin:0;padding:0;background-color:#0C0A14 !important;background:#0C0A14 !important;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">

<div style="display:none;font-size:1px;color:#0C0A14;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheaderMap[variant]}</div>

<div class="outer-bg" style="background-color:#0C0A14 !important;width:100%;min-width:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0C0A14" style="background-color:#0C0A14 !important;width:100%;">
<tr>
<td class="outer-td" align="center" valign="top" bgcolor="#0C0A14" style="background-color:#0C0A14 !important;padding:32px 16px;">

  <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;">

    <!-- HERO -->
    <tr>
      <td style="border-radius:20px 20px 0 0;overflow:hidden;border:1px solid rgba(255,255,255,0.07);border-bottom:none;line-height:0;font-size:0;padding:0;">
        <img class="hero-img"
          src="https://res.cloudinary.com/dopqilo8o/image/upload/q_auto/f_auto/v1779379488/WhatsApp_Image_2026-05-21_at_4.30.13_PM_b4cofs.jpg"
          width="580"
          style="display:block;width:100%;max-width:580px;border-radius:20px 20px 0 0;"
          alt="The Booyah Awards 2026">
      </td>
    </tr>

    <!-- GREETING -->
    <tr>
      <td class="pad-mobile" style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <p style="margin:0;font-size:20px;font-weight:700;color:#E8E3F2;">Hey ${name || 'there'} 👋</p>
        <p style="margin:8px 0 0;font-size:14px;color:#d4d4d4;line-height:1.7;">${greetingCopy[variant]}</p>
      </td>
    </tr>

    <!-- PAID PERKS (Variant C only) -->
    ${paidPerksBlock}

    <!-- CTA (B: RSVP buttons · C: UID form · A: none) -->
    ${ctaBlock}

    <!-- WHAT'S HAPPENING -->
    <tr>
      <td class="pad-mobile" style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;font-weight:600;">What's Happening</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
          ${attractionRows}
        </table>
      </td>
    </tr>

    <!-- EVENT DETAILS -->
    <tr>
      <td class="pad-mobile" style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;font-weight:600;">Event Details</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:34px;vertical-align:middle;"><div style="width:34px;height:34px;background:rgba(245,200,66,0.1);border-radius:8px;border:1px solid rgba(245,200,66,0.18);text-align:center;line-height:34px;font-size:15px;">📅</div></td>
              <td style="padding-left:12px;vertical-align:middle;">
                <div style="font-size:10px;color:#7A748F;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Date</div>
                <div style="font-size:13px;font-weight:600;color:#E8E3F2;">Saturday, 6 June 2026</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:34px;vertical-align:middle;"><div style="width:34px;height:34px;background:rgba(245,200,66,0.1);border-radius:8px;border:1px solid rgba(245,200,66,0.18);text-align:center;line-height:34px;font-size:15px;">⏰</div></td>
              <td style="padding-left:12px;vertical-align:middle;">
                <div style="font-size:10px;color:#7A748F;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Doors Open / Show</div>
                <div style="font-size:13px;font-weight:600;color:#E8E3F2;">[GATES_TIME] · Show 12:00 – 6:30 PM IST</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:34px;vertical-align:top;padding-top:2px;"><div style="width:34px;height:34px;background:rgba(245,200,66,0.1);border-radius:8px;border:1px solid rgba(245,200,66,0.18);text-align:center;line-height:34px;font-size:15px;">📍</div></td>
              <td style="padding-left:12px;vertical-align:middle;">
                <div style="font-size:10px;color:#7A748F;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Venue</div>
                <div style="font-size:13px;font-weight:600;color:#E8E3F2;">India Expo Centre &amp; Mart, Greater Noida</div>
                <a href="https://maps.app.goo.gl/B2doQttFHaH8Q2wQ8" target="_blank" style="font-size:11px;color:#A78BFA;text-decoration:none;display:inline-block;margin-top:3px;">View on Google Maps &rarr;</a>
              </td>
            </tr></table>
          </td></tr>
          <tr><td bgcolor="#140016c9" style="background-color:#140016c9;padding:12px 16px;">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:34px;vertical-align:middle;"><div style="width:34px;height:34px;background:rgba(245,200,66,0.1);border-radius:8px;border:1px solid rgba(245,200,66,0.18);text-align:center;line-height:34px;font-size:15px;">🚇</div></td>
              <td style="padding-left:12px;vertical-align:middle;">
                <div style="font-size:10px;color:#7A748F;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">How to Reach</div>
                <div style="font-size:13px;font-weight:600;color:#E8E3F2;">Aqua Line → Knowledge Park II / Pari Chowk</div>
                <div style="font-size:11px;color:#7A748F;margin-top:2px;">Free Booyah Awards shuttles at metro exit</div>
              </td>
            </tr></table>
          </td></tr>
        </table>
      </td>
    </tr>

    <!-- FAQs -->
    <tr>
      <td class="pad-mobile" style="background-color:#3e087c;border:1px solid rgba(255,255,255,0.07);border-top:none;border-bottom:none;padding:24px 36px;">
        <div style="font-size:10px;color:#a09ab8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;font-weight:600;">FAQs</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
          ${faqRows}
        </table>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td class="pad-mobile footer-radius" style="background-color:#3e087c;border-radius:0 0 20px 20px;border:1px solid rgba(255,255,255,0.07);border-top:none;padding:22px 36px;text-align:center;">
        <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(245,200,66,0.25),transparent);margin-bottom:18px;"></div>
        <p style="margin:0 0 6px;font-size:12px;color:#bcb8d0;">The Booyah Awards 2026 &middot; Greater Noida</p>
        <p style="margin:0;font-size:11px;color:#9490a8;line-height:1.8;">
          You received this because you registered for The Booyah Awards 2026.<br>
          <a href="#" style="color:#9490a8;text-decoration:underline;">Unsubscribe</a>
        </p>
      </td>
    </tr>

    <tr><td bgcolor="#0C0A14" style="background-color:#0C0A14;height:32px;font-size:0;line-height:0;">&nbsp;</td></tr>

  </table>
</td>
</tr>
</table>
</div>
</body>
</html>`;
}

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 Booyah RSVP server running on http://localhost:${PORT}`);
  console.log(`   RSVP page   → http://localhost:${PORT}/rsvp.html`);
  console.log(`   Admin panel → http://localhost:${PORT}/admin.html`);
  console.log(`   Health      → http://localhost:${PORT}/health\n`);

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