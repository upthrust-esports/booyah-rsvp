# Booyah Awards 2026 — RSVP System
## Complete File Index + Deployment Roadmap

---

## FILES IN THIS PACKAGE

| File | Purpose | Edit needed |
|------|---------|-------------|
| `rsvp_backend.gs` | Google Apps Script — all sheet logic | Set `SHEET_ID` |
| `rsvp.html` | Attendee-facing RSVP page | Set `SCRIPT_URL` |
| `admin.html` | Admin panel — import CSV, send WA/email | Set via Settings UI |
| `rsvp_email_template.html` | HTML email template for bulk mailers | Replace `{{PLACEHOLDERS}}` |

---

## STEP-BY-STEP DEPLOYMENT

### STEP 1 — Create the Google Sheet

1. Go to **sheets.google.com** → create a new blank spreadsheet
2. Name it: `Booyah Awards 2026 — RSVP`
3. Copy the Sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/**THIS_PART**/edit`

---

### STEP 2 — Deploy the Apps Script backend

1. Go to **script.google.com** → New Project
2. Delete all existing code, paste `rsvp_backend.gs` entirely
3. Replace line 28:
   ```js
   const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE';
   // ↓ replace with
   const SHEET_ID = 'abc123xyz...'; // your actual Sheet ID
   ```
4. Run `setupHeaders()` once:
   - Click the function dropdown (top bar) → select `setupHeaders` → click ▶ Run
   - First run will ask for Google Sheets permission — click Allow
   - Check your sheet: 3 new tabs should appear:
     - `RSVP_Current` — latest Yes/No per attendee
     - `RSVP_Log` — every click ever (full audit)
     - `RSVP_SendLog` — every WA/email sent by admin
5. Deploy as Web App:
   - Click **Deploy** → **New Deployment**
   - Type: **Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy → copy the URL (looks like `https://script.google.com/macros/s/AKfycb.../exec`)

> ⚠️ Every time you change the `.gs` code, you must create a **New Deployment** (not update existing) for changes to take effect.

---

### STEP 3 — Host the RSVP page

**Option A — GitHub Pages (free, recommended):**
1. Create a GitHub repo (e.g. `booyah-rsvp`)
2. Upload `rsvp.html` to the repo root
3. Go to repo Settings → Pages → Source: main branch → Save
4. Your page is live at: `https://yourusername.github.io/booyah-rsvp/rsvp.html`

**Option B — Any static host:**
Netlify, Vercel, Cloudflare Pages — just upload `rsvp.html`.

After hosting, open `rsvp.html` in a text editor and replace line 442:
```js
const SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
// ↓ replace with your actual Apps Script URL
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```
Re-upload the updated file.

---

### STEP 4 — Configure the Admin Panel

1. Open `admin.html` in a browser (can run locally — no server needed)
2. Go to **Settings** (⚙️ sidebar)
3. Fill in:
   - **Hosted RSVP Page URL**: `https://yourusername.github.io/booyah-rsvp/rsvp.html`
   - **Google Apps Script URL**: `https://script.google.com/macros/s/AKfycb.../exec`
   - **WhatsApp Phone Number ID**: from Meta Business → WhatsApp → API Setup
   - **WhatsApp Access Token**: Permanent token from Meta System User
   - **Message template**: customise the WA message (use `{name}` and `{link}`)
4. Click **Save Settings**

---

### STEP 5 — Import District CSV

1. Go to **Import CSV** page in admin
2. Export your ticket list from District dashboard as CSV
3. Drag & drop the CSV file
4. Review the preview — deduplication summary is shown
   - Multiple rows for same Transaction ID = collapsed to 1 contact
5. Click **Import X Contacts**
6. Admin auto-fetches sent history from Google Sheet and marks already-sent contacts

---

### STEP 6 — Send RSVPs

1. Go to **Send RSVP** page
2. Select channels: 📱 WhatsApp and/or 📧 Email
3. Stats show:
   - **To Send**: contacts with no sent flag on either channel
   - **Already Sent**: will be skipped automatically
   - **Will Send**: exact count on selected channels
4. Set batch rate (default 5/sec — WhatsApp API limit is ~80/min)
5. Click 🚀 **Start Sending**
6. Watch live progress — each send writes immediately to `RSVP_SendLog` sheet
7. At end of run, a bulk sync writes all sent records as a safety net

> **Email note:** Browser can't send email directly (no SMTP). The admin marks email contacts as "queued". Export them via Contacts → Export CSV — the file includes pre-built RSVP links for both channels. Import into SendGrid / Brevo / Mailchimp as a campaign.

---

### STEP 7 — Monitor Responses

Attendees click their RSVP link → land on `rsvp.html` → click Yes or No.

Every response writes to:
- `RSVP_Log` — every click with timestamp + source (wa/email/direct)
- `RSVP_Current` — upserted latest response per person

Check your Google Sheet live for response counts.

---

## SYSTEM ARCHITECTURE

```
District CSV Export
        ↓
   admin.html (browser)
   ├── Import & dedup by Transaction ID
   ├── Send WA via Meta Cloud API
   ├── Mark email as queued → export CSV for bulk mailer
   └── After send → POST to Apps Script (RSVP_SendLog)
                          ↓
              Google Apps Script (Web App)
              ├── RSVP_SendLog  ← admin writes sent records
              ├── RSVP_Current  ← attendee Yes/No (latest)
              └── RSVP_Log      ← attendee every click (audit)
                          ↑
              rsvp.html (attendee page)
              ├── Reads ?tid=&name=&email=&pass=&src= from URL
              ├── Loads existing response on open
              ├── Attendee clicks Yes or No
              └── POST → Apps Script → writes to both sheets
```

---

## LINK FORMAT

Every RSVP link looks like this:

```
https://yourdomain.com/rsvp.html
  ?tid=6a06cbc67ab54494ca3398a2   ← Transaction ID (dedup key)
  &name=Ratnim%20Tyagi            ← attendee name
  &email=ratnim@gmail.com         ← attendee email
  &pass=General%20Access          ← ticket type
  &src=wa                         ← channel: wa | email | direct
```

The admin generates these automatically. You never build them manually.

---

## DEDUPLICATION RULES

| Scenario | Behaviour |
|----------|-----------|
| Same person buys 3 tickets (3 CSV rows, same Txn ID) | Collapsed to 1 RSVP link |
| Admin sends WA, then tries to send WA again | Skipped — `waSent = true` |
| Admin sends WA, then sends email | Allowed — different channel |
| Attendee clicks Yes, then No later | Latest response wins in `RSVP_Current`, both logged in `RSVP_Log` |
| Same email on WA + email click | Same row in `RSVP_Current` (matched by email) |
| Admin closes browser, reopens, re-imports CSV | `loadSentStateFromSheet()` fetches `RSVP_SendLog` → all previously sent contacts re-marked |

---

## WHAT NEEDS EXTERNAL SETUP

| Service | What for | Where to get |
|---------|---------|-------------|
| Google Sheets | Data storage | sheets.google.com (free) |
| Google Apps Script | Backend API | script.google.com (free) |
| Static host | RSVP page hosting | GitHub Pages / Netlify (free) |
| Meta WhatsApp Business API | Sending WA messages | developers.facebook.com/docs/whatsapp |
| SendGrid / Brevo / Mailchimp | Bulk email sending | Any ESP (email service provider) |

> WhatsApp Business API requires a verified Meta Business account. For sending to users who haven't messaged you first, you need an **approved message template** via Meta — plain text messages to new users will be rejected. Get the template approved before the send date.

---

## TESTING CHECKLIST

- [ ] `setupHeaders()` ran, 3 sheets visible in Google Sheet
- [ ] Apps Script deployed as Web App, URL copied
- [ ] `rsvp.html` live on static host with correct `SCRIPT_URL`
- [ ] Open `rsvp.html?tid=TEST&name=Admin&email=test@test.com&pass=RSVP&src=direct` — page loads
- [ ] Click Yes → row appears in `RSVP_Current` and `RSVP_Log`
- [ ] Click No → same row updated in `RSVP_Current`, new row in `RSVP_Log`
- [ ] Admin Settings saved
- [ ] Import CSV → contacts appear in Contacts tab
- [ ] 🔄 Sync Sheet — no errors in console
- [ ] Send one test WA to your own number — message received, row in `RSVP_SendLog`
- [ ] Re-import same CSV — that contact shows "Sent" status immediately

