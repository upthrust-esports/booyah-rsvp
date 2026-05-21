// ═══════════════════════════════════════════════════════════════════
// THE BOOYAH AWARDS 2026 — RSVP BACKEND (Google Apps Script)
// ═══════════════════════════════════════════════════════════════════
//
// SHEETS USED:
//   RSVP_Current  — one row per attendee, latest YES/NO response
//   RSVP_Log      — every attendee response click (full audit)
//   RSVP_SendLog  — every RSVP message sent by admin (WA + email)
//
// ACTIONS (GET):
//   ?action=get&tid=XXX          → get one attendee's RSVP status + history
//   ?action=get_sent             → get ALL sent records (admin loads on startup)
//
// ACTIONS (POST body JSON):
//   {action:"rsvp", ...}         → attendee clicks YES/NO on RSVP page
//   {action:"mark_sent", ...}    → admin sent one message, record it
//   {action:"bulk_mark_sent",...}→ admin bulk-records a batch of sends
//
// SETUP:
//   1. script.google.com → New Project → paste this file
//   2. Set SHEET_ID below
//   3. Run setupHeaders() once manually
//   4. Deploy → Web App (Execute as: Me, Access: Anyone)
//   5. Paste URL into admin.html cfg.scriptUrl AND rsvp.html SCRIPT_URL
//
// ═══════════════════════════════════════════════════════════════════

const SHEET_ID     = '111jKwD6Pzo8bbmwPTJgH-gzU4pWAbNAHpFcBBRKSkXw';

const CURRENT_SHEET  = 'RSVP_Current';
const LOG_SHEET      = 'RSVP_Log';
const SEND_LOG_SHEET = 'RSVP_SendLog';

// ─── ROUTER ──────────────────────────────────────────────────────
function doGet(e) {
  return handleRequest(e.parameter, null);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch(err) {}
  return handleRequest(body, body);
}

function handleRequest(params, body) {
  const action = (params.action || (body && body.action) || '').trim();
  let result;
  try {
    switch (action) {
      case 'rsvp':           result = handleRSVP(body || params);           break;
      case 'get':            result = getStatus(params.tid || body.tid);    break;
      case 'get_sent':       result = getSentLog();                          break;
      case 'mark_sent':      result = markSent(body);                       break;
      case 'bulk_mark_sent': result = bulkMarkSent(body);                   break;
      default:               result = { status: 'error', message: 'Unknown action: ' + action };
    }
  } catch(err) {
    result = { status: 'error', message: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════
// ATTENDEE RSVP (called from rsvp.html when attendee clicks Yes/No)
// ═══════════════════════════════════════════════════════════════════
function handleRSVP(data) {
  const tid      = (data.tid      || '').trim();
  const name     = (data.name     || '').trim();
  const email    = (data.email    || '').trim().toLowerCase();
  const pass     = (data.pass     || 'Booyah Pass').trim();
  const response = (data.response || '').toUpperCase(); // YES | NO
  const source   = (data.source   || 'direct').trim();  // wa | email | direct
  const ua       = (data.ua       || '').slice(0, 200);
  const rawTs    = data.ts || new Date().toISOString();

  if (!tid)                              return { status: 'error', message: 'Missing ticket ID' };
  if (!['YES','NO'].includes(response))  return { status: 'error', message: 'Invalid response' };

  const ss      = SpreadsheetApp.openById(SHEET_ID);
  const current = ss.getSheetByName(CURRENT_SHEET);
  const log     = ss.getSheetByName(LOG_SHEET);
  const nowIST  = getISTTimestamp();

  // 1. Always append to RSVP_Log
  log.appendRow([nowIST, tid, name, email, response, source, ua, rawTs]);

  // 2. Upsert RSVP_Current (match by txnId OR email for cross-channel dedup)
  const currentData = current.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < currentData.length; i++) {
    if (currentData[i][0] === tid ||
       (email && currentData[i][2].toString().toLowerCase() === email)) {
      rowIndex = i + 1;
      break;
    }
  }

  let totalYes = 0, totalNo = 0, firstTs = nowIST, allSources = source;
  if (rowIndex > 0) {
    const ex = currentData[rowIndex - 1];
    totalYes   = parseInt(ex[6]) || 0;
    totalNo    = parseInt(ex[7]) || 0;
    firstTs    = ex[8] || nowIST;
    const srcSet = new Set((ex[10]||'').split(',').map(s=>s.trim()).filter(Boolean));
    srcSet.add(source);
    allSources = Array.from(srcSet).join(', ');
  }
  if (response === 'YES') totalYes++; else totalNo++;

  const newRow = [tid, name, email, pass, response, nowIST, totalYes, totalNo, firstTs, source, allSources];
  if (rowIndex > 0) current.getRange(rowIndex, 1, 1, newRow.length).setValues([newRow]);
  else              current.appendRow(newRow);

  return {
    status:   'ok',
    current:  { response, time: nowIST },
    history:  getHistoryForTid(log, tid, email),
    totalYes, totalNo
  };
}

// ═══════════════════════════════════════════════════════════════════
// GET ATTENDEE STATUS (called from rsvp.html on page load)
// ═══════════════════════════════════════════════════════════════════
function getStatus(tid) {
  if (!tid) return { status: 'error', message: 'Missing tid' };

  const ss      = SpreadsheetApp.openById(SHEET_ID);
  const current = ss.getSheetByName(CURRENT_SHEET);
  const log     = ss.getSheetByName(LOG_SHEET);
  const data    = current.getDataRange().getValues();
  let found     = null;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === tid) {
      found = {
        response:      data[i][4],
        time:          data[i][5],
        totalYes:      data[i][6],
        totalNo:       data[i][7],
        firstResponse: data[i][8],
        lastSource:    data[i][9],
        allSources:    data[i][10]
      };
      break;
    }
  }

  return { status: 'ok', current: found, history: getHistoryForTid(log, tid, null) };
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN — MARK ONE SEND (called after each WA/email send from admin)
// ═══════════════════════════════════════════════════════════════════
function markSent(data) {
  // data: { txnId, name, email, phone, channel, ticketName, msgId }
  const txnId      = (data.txnId      || '').trim();
  const name       = (data.name       || '').trim();
  const email      = (data.email      || '').trim().toLowerCase();
  const phone      = (data.phone      || '').trim();
  const channel    = (data.channel    || '').trim(); // 'wa' | 'email'
  const ticketName = (data.ticketName || '').trim();
  const msgId      = (data.msgId      || '').trim();
  const nowIST     = getISTTimestamp();

  if (!txnId)   return { status: 'error', message: 'Missing txnId' };
  if (!channel) return { status: 'error', message: 'Missing channel' };

  // Check for duplicate — don't double-write if somehow called twice
  const ss       = SpreadsheetApp.openById(SHEET_ID);
  const sendLog  = ss.getSheetByName(SEND_LOG_SHEET);
  const existing = sendLog.getDataRange().getValues();

  for (let i = 1; i < existing.length; i++) {
    if (existing[i][0] === txnId && existing[i][4] === channel) {
      // Already recorded — return ok but note it was a duplicate call
      return { status: 'ok', duplicate: true, txnId, channel };
    }
  }

  sendLog.appendRow([txnId, name, email, phone, channel, ticketName, msgId, nowIST]);
  return { status: 'ok', txnId, channel, time: nowIST };
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN — BULK MARK SENT (batch write after a send run)
// ═══════════════════════════════════════════════════════════════════
function bulkMarkSent(data) {
  // data: { records: [{txnId, name, email, phone, channel, ticketName, msgId}] }
  const records = data.records || [];
  if (!records.length) return { status: 'ok', written: 0 };

  const ss      = SpreadsheetApp.openById(SHEET_ID);
  const sendLog = ss.getSheetByName(SEND_LOG_SHEET);
  const existing = sendLog.getDataRange().getValues();

  // Build set of already-recorded txnId+channel combos
  const already = new Set();
  for (let i = 1; i < existing.length; i++) {
    already.add(existing[i][0] + '|' + existing[i][4]);
  }

  const nowIST = getISTTimestamp();
  const toWrite = [];
  records.forEach(r => {
    const key = (r.txnId || '') + '|' + (r.channel || '');
    if (!already.has(key)) {
      toWrite.push([
        r.txnId || '', r.name || '', r.email || '', r.phone || '',
        r.channel || '', r.ticketName || '', r.msgId || '', nowIST
      ]);
      already.add(key); // prevent dupes within this batch
    }
  });

  if (toWrite.length) {
    sendLog.getRange(
      sendLog.getLastRow() + 1, 1, toWrite.length, 8
    ).setValues(toWrite);
  }

  return { status: 'ok', written: toWrite.length, skipped: records.length - toWrite.length };
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN — GET FULL SEND LOG (admin loads this on page open)
// ═══════════════════════════════════════════════════════════════════
function getSentLog() {
  const ss      = SpreadsheetApp.openById(SHEET_ID);
  const sendLog = ss.getSheetByName(SEND_LOG_SHEET);
  const data    = sendLog.getDataRange().getValues();

  // Return as {txnId: {wa: bool, email: bool}} map
  // Also return flat array for the log table
  const sentMap   = {};  // txnId → {wa, email}
  const sentArray = [];  // [{txnId, name, email, channel, time}]

  for (let i = 1; i < data.length; i++) {
    const [txnId, name, email, phone, channel, ticketName, msgId, time] = data[i];
    if (!txnId) continue;

    if (!sentMap[txnId]) sentMap[txnId] = { wa: false, email: false };
    if (channel === 'wa')    sentMap[txnId].wa    = true;
    if (channel === 'email') sentMap[txnId].email = true;

    sentArray.push({ txnId, name, email, channel, ticketName, msgId, time });
  }

  return { status: 'ok', sentMap, sentArray };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function getHistoryForTid(logSheet, tid, email) {
  const data    = logSheet.getDataRange().getValues();
  const history = [];
  for (let i = 1; i < data.length; i++) {
    const rowTid   = data[i][1];
    const rowEmail = data[i][3].toString().toLowerCase();
    if (rowTid === tid || (email && rowEmail === email.toLowerCase())) {
      history.push({ time: data[i][0], response: data[i][4], source: data[i][5] });
    }
  }
  return history;
}

function getISTTimestamp() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = n => n.toString().padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())} IST`;
}

// ═══════════════════════════════════════════════════════════════════
// ONE-TIME SETUP — run manually once from Apps Script editor
// ═══════════════════════════════════════════════════════════════════
function setupHeaders() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  function makeSheet(name, headers) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    Logger.log('✅ ' + name + ' ready');
    return sh;
  }

  makeSheet(CURRENT_SHEET, [
    'TxnID','Name','Email','Pass','FinalResponse',
    'LastUpdated(IST)','TotalYes','TotalNo','FirstResponseTime','LastSource','AllSources'
  ]);

  makeSheet(LOG_SHEET, [
    'Timestamp(IST)','TxnID','Name','Email',
    'Response','Source','UserAgent','RawTimestamp(ISO)'
  ]);

  // NEW: tracks every admin send (WA + email), used for dedup on reload
  makeSheet(SEND_LOG_SHEET, [
    'TxnID','Name','Email','Phone',
    'Channel','TicketName','MsgID','SentAt(IST)'
  ]);

  Logger.log('✅ All sheets set up');
}
