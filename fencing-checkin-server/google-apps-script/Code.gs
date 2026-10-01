/**
 * Fencing check-in receiver.
 * Paste this into a Google Sheet's Apps Script editor (Extensions > Apps Script),
 * then deploy it as a Web App (see README.md in the project for exact steps).
 * Every check-in/out event from the tablet server gets appended as a new row.
 */

// Practice start, in the Apps Script project's time zone (Project Settings > Time zone).
// Any first check-in after this is marked late by the number of minutes after it.
var PRACTICE_START_HOUR = 20; // 24-hour clock: 20 = 8 PM
var PRACTICE_START_MINUTE = 0;

// A week counts toward the weekly requirement if the fencer attended at least this many
// practices in it (Monday-start weeks).
var WEEKLY_PRACTICES_REQUIRED = 2;

var SETTINGS_SHEET = 'Semester Settings';

function doPost(e) {
  // If this runs with no real request (e.g. you clicked "Run" in the editor to test
  // it), e or e.postData won't exist — that's not an error in your setup, it just
  // means this wasn't a real check-in. The real test is the Coach dashboard's
  // "Sync now" button, which sends an actual POST to the deployed URL.
  if (!e || !e.postData) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, msg: 'No request body received — this endpoint expects a real POST, not a manual Run.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Log');
  if (!sheet) { sheet = ss.insertSheet('Log'); }

  // Add a header row once, if the sheet is empty.
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Name', 'Action', 'Time']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 3, 160);
  }

  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([data.name, data.action, data.time]);

  // Highlight D.N.C. rows so they stand out from normal check-outs at a glance.
  if (data.action === 'D.N.C.') {
    sheet.getRange(sheet.getLastRow(), 1, 1, 3).setFontColor('#C9A227').setFontWeight('bold');
  }

  // Keep this event's semester attendance tab live — rebuilt from the Log on every
  // check-in/out. Only the semester this event falls in gets rebuilt, so past, finished
  // semesters' tabs are never touched (and don't slow down as the season goes on).
  var tz = Session.getScriptTimeZone();
  generateAttendanceSheet(semesterKeyOfDay(Utilities.formatDate(new Date(data.time), tz, 'yyyy-MM-dd')));

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Lets you sanity-check the deployment URL by opening it in a browser.
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, msg: 'Fencing check-in receiver is live.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Adds a "Fencing Attendance" menu with buttons to (re)build attendance tabs and to
// apply header/highlight formatting to a Log tab that predates this script.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fencing Attendance')
    .addItem('Refresh Attendance Sheet (this semester)', 'refreshCurrentSemesterAttendance')
    .addItem('Rebuild All Semester Sheets', 'rebuildAllAttendanceSheets')
    .addItem('Format Log tab', 'formatLogSheet')
    .addToUi();
}

// One-time (or run-anytime) formatting pass over the existing "Log" tab: bolds and
// freezes the header row, sets readable column widths, and highlights any D.N.C. rows
// gold. New rows appended by doPost are already formatted as they're written — this is
// only needed to catch up rows that were added before this formatting existed.
function formatLogSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  if (!sheet || sheet.getLastRow() === 0) {
    SpreadsheetApp.getUi().alert('No Log tab (or no rows) to format yet.');
    return;
  }
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 3, 160);

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var actions = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    actions.forEach(function (row, i) {
      var rowIndex = i + 2;
      var isDnc = row[0] === 'D.N.C.';
      var range = sheet.getRange(rowIndex, 1, 1, 3);
      range.setFontColor(isDnc ? '#C9A227' : null).setFontWeight(isDnc ? 'bold' : null);
    });
  }
}

// Fall = Aug-Dec, Spring = Jan-May, Summer = Jun-Jul, from a 'yyyy-MM-dd' day key.
// Adjust here if your school's terms don't line up with this.
function semesterKeyOfDay(dayKey) {
  var year = Number(dayKey.slice(0, 4));
  var month = Number(dayKey.slice(5, 7));
  if (month >= 8) return 'Fall ' + year;
  if (month <= 5) return 'Spring ' + year;
  return 'Summer ' + year;
}

// Monday of the week containing dayKey, as 'yyyy-MM-dd'. Pure date math, so it can't be
// thrown off by the script's timezone.
function mondayOf(dayKey) {
  var d = new Date(dayKey + 'T00:00:00Z');
  var shift = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

/**
 * Reads every valid Log row and assigns each one the local calendar day it belongs to.
 * A D.N.C. row is attributed to the day of that fencer's most recent check-in rather than
 * its own timestamp: the server stamps D.N.C. at 23:59 UTC, which is the NEXT local day
 * for an evening practice in the Americas, and would otherwise land on the wrong date.
 */
function readLogEvents(tz) {
  var logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  if (!logSheet || logSheet.getLastRow() < 2) return [];
  var rows = logSheet.getDataRange().getValues();
  rows.shift(); // drop header row

  var events = rows
    .map(function (r) { return { name: String(r[0]).trim(), action: String(r[1]).trim(), time: new Date(r[2]) }; })
    .filter(function (ev) { return ev.name && ev.action && !isNaN(ev.time.getTime()); })
    .sort(function (a, b) { return a.time - b.time; });

  var lastInDayByName = {};
  events.forEach(function (ev) {
    var ownDay = Utilities.formatDate(ev.time, tz, 'yyyy-MM-dd');
    if (ev.action === 'D.N.C.') {
      ev.dayKey = lastInDayByName[ev.name] || ownDay;
    } else {
      ev.dayKey = ownDay;
      if (ev.action === 'in') lastInDayByName[ev.name] = ownDay;
    }
  });
  return events;
}

/**
 * Reads the per-semester targets you type into the "Semester Settings" tab. Creates the
 * tab, and a blank row for any semester not listed yet, so there's always a place to fill
 * them in. Blank cells come back as null.
 */
function getSemesterSettings(semesterKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.appendRow(['Semester', 'Required practices', 'Mandatory weeks']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 3, 170);
  }
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === semesterKey) {
      var practices = Number(values[i][1]), weeks = Number(values[i][2]);
      return {
        requiredPractices: values[i][1] !== '' && practices > 0 ? practices : null,
        mandatoryWeeks: values[i][2] !== '' && weeks > 0 ? weeks : null
      };
    }
  }
  sheet.appendRow([semesterKey, '', '']);
  return { requiredPractices: null, mandatoryWeeks: null };
}

// Rebuilds the tab for whichever semester "today" falls in, and jumps you to it. The
// automatic per-check-in rebuild (see doPost) deliberately does NOT switch your active
// tab, so use this when you want to manually jump over and look.
function refreshCurrentSemesterAttendance() {
  var tz = Session.getScriptTimeZone();
  var key = semesterKeyOfDay(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  generateAttendanceSheet(key);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = ss.getSheetByName(key);
  if (out) ss.setActiveSheet(out);
}

// Scans the whole Log for every semester that appears in it and (re)builds a tab for
// each. Use this after pasting the script in, after editing the Log by hand, or after
// changing numbers in the "Semester Settings" tab.
function rebuildAllAttendanceSheets() {
  var events = readLogEvents(Session.getScriptTimeZone());
  if (!events.length) {
    try { SpreadsheetApp.getUi().alert('No check-in data yet — nothing to build.'); } catch (uiErr) {}
    return;
  }
  var semesters = {};
  events.forEach(function (ev) { semesters[semesterKeyOfDay(ev.dayKey)] = true; });
  Object.keys(semesters).forEach(function (key) { generateAttendanceSheet(key); });
}

function fmtHours(ms) { return (Math.round(ms / 36000) / 100) + ' hrs'; }
function ratioLabel(n, d) { return d ? n + '/' + d + ' (' + Math.round((n / d) * 100) + '%)' : String(n); }

/**
 * Rebuilds ONE semester's attendance tab (named after the semester, e.g. "Fall 2026"):
 * one row per fencer, one column per practice date (any day with at least one check-in),
 * color-coded:
 *   green  "1.75 hrs"         — attended, on time
 *   green  "In progress"      — checked in today and not out yet
 *   amber  "24 min late"      — first check-in after the practice start time
 *   amber  "No Check Out"     — checked in but never checked out that day
 *   red    "0 hrs"            — checked out less than a minute after checking in (a
 *                               double-tap); not counted as attended
 *   red    (blank)            — no record that day
 * There's one practice a day, so a day's time is first check-in to LAST check-out. Extra
 * out/in/out scans at the end of practice are absorbed, and a stray check-in after the
 * fencer already checked out doesn't count as a missing checkout.
 *
 * Only fencers with at least one Log entry in this semester appear — the Log never
 * receives the full roster, only individual check-in/out events.
 */
function generateAttendanceSheet(semesterKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = Session.getScriptTimeZone();
  var events = readLogEvents(tz).filter(function (ev) { return semesterKeyOfDay(ev.dayKey) === semesterKey; });
  if (!events.length) return;

  var previousActiveName = ss.getActiveSheet().getName();
  var settings = getSemesterSettings(semesterKey);
  var todayKey = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // Distinct practice dates and fencers, both sorted.
  var dateSet = {}, fencerSet = {};
  events.forEach(function (ev) { dateSet[ev.dayKey] = true; fencerSet[ev.name] = true; });
  var dates = Object.keys(dateSet).sort();
  var fencers = Object.keys(fencerSet).sort();
  var weeksWithPractice = dates.map(mondayOf)
    .filter(function (w, i, arr) { return arr.indexOf(w) === i; });

  // Fall back to what's actually been held when no target is set in Semester Settings.
  var practiceTarget = settings.requiredPractices || dates.length;
  var weekTarget = settings.mandatoryWeeks || weeksWithPractice.length;

  var practiceStartSec = PRACTICE_START_HOUR * 3600 + PRACTICE_START_MINUTE * 60;
  function minutesLate(time) {
    var hms = Utilities.formatDate(time, tz, 'HH:mm:ss').split(':').map(Number);
    var lateSec = hms[0] * 3600 + hms[1] * 60 + hms[2] - practiceStartSec;
    return lateSec > 0 ? Math.ceil(lateSec / 60) : 0;
  }

  // Group each fencer's events by date (already in time order from readLogEvents).
  var byFencerDate = {};
  events.forEach(function (ev) {
    byFencerDate[ev.name] = byFencerDate[ev.name] || {};
    (byFencerDate[ev.name][ev.dayKey] = byFencerDate[ev.name][ev.dayKey] || []).push(ev);
  });

  var out = ss.getSheetByName(semesterKey);
  if (out) ss.deleteSheet(out);
  out = ss.insertSheet(semesterKey);

  out.getRange(1, 1, 2, 4).setValues([
    ['Practices held so far:', dates.length, 'Required practices this semester:',
      settings.requiredPractices || 'not set — fill in "' + SETTINGS_SHEET + '" tab'],
    ['Weeks with practice so far:', weeksWithPractice.length, 'Mandatory weeks this semester:',
      settings.mandatoryWeeks || 'not set — fill in "' + SETTINGS_SHEET + '" tab']
  ]);
  out.getRange(1, 1, 2, 4).setFontWeight('bold');

  var HEADER_ROW = 4;
  var baseHeader = ['Fencer', 'Total Time On The Strip (hours)', 'Practices attended',
    'Practices attended / required', 'Total # of late practices',
    'Total # of not signed out practices/left early',
    'Weeks with ' + WEEKLY_PRACTICES_REQUIRED + '+ practices', 'Weeks with ' + WEEKLY_PRACTICES_REQUIRED + '+ practices / mandatory'];
  var FIRST_DATE_COL = baseHeader.length + 1;
  var header = baseHeader.concat(dates.map(function (dk) {
    return Utilities.formatDate(new Date(dk + 'T12:00:00Z'), 'UTC', 'MMM d');
  }));
  out.getRange(HEADER_ROW, 1, 1, header.length).setValues([header]).setFontWeight('bold').setWrap(true);
  out.setFrozenRows(HEADER_ROW);
  out.setFrozenColumns(1);

  var GREEN = '#93C47D', RED = '#E06666', AMBER = '#F1C232';

  var rowsOut = [], colorsOut = [];
  fencers.forEach(function (name) {
    var totalMs = 0, attended = 0, late = 0, noCheckout = 0;
    var attendedByWeek = {};
    var dateValues = [], dateColors = [];

    dates.forEach(function (dk) {
      var dayEvents = (byFencerDate[name] || {})[dk] || [];
      var firstIn = null, lastOut = null;
      dayEvents.forEach(function (ev) {
        if (ev.action === 'in' && !firstIn) firstIn = ev.time;
        else if (ev.action === 'out' && firstIn) lastOut = ev.time;
      });

      if (!firstIn) {
        dateValues.push('');
        dateColors.push(RED);
        return;
      }

      var dayMs = lastOut ? lastOut - firstIn : 0;
      if (lastOut && dayMs < 60000) {
        dateValues.push('0 hrs');
        dateColors.push(RED);
        return;
      }
      // Never checked out: still practicing if it's today, otherwise a missing checkout.
      var missingCheckout = !lastOut && dk < todayKey;
      var inProgress = !lastOut && dk >= todayKey;

      attended++;
      totalMs += dayMs;
      var wk = mondayOf(dk);
      attendedByWeek[wk] = (attendedByWeek[wk] || 0) + 1;

      var parts = [];
      var lateMin = minutesLate(firstIn);
      if (lateMin > 0) { late++; parts.push(lateMin + ' min late'); }
      if (missingCheckout) { noCheckout++; parts.push('No Check Out'); }
      if (!parts.length) parts.push(inProgress ? 'In progress' : fmtHours(dayMs));
      dateValues.push(parts.join(' · '));
      dateColors.push(lateMin > 0 || missingCheckout ? AMBER : GREEN);
    });

    var weeksMet = Object.keys(attendedByWeek).filter(function (wk) {
      return attendedByWeek[wk] >= WEEKLY_PRACTICES_REQUIRED;
    }).length;

    rowsOut.push([name, Math.round(totalMs / 36000) / 100, attended, ratioLabel(attended, practiceTarget),
      late, noCheckout, weeksMet, ratioLabel(weeksMet, weekTarget)].concat(dateValues));
    colorsOut.push(dateColors);
  });

  var firstDataRow = HEADER_ROW + 1;
  out.getRange(firstDataRow, 1, rowsOut.length, header.length).setValues(rowsOut);
  out.getRange(firstDataRow, 1, rowsOut.length, 1).setFontWeight('bold');
  var dateBlock = out.getRange(firstDataRow, FIRST_DATE_COL, rowsOut.length, dates.length);
  dateBlock.setBackgrounds(colorsOut);
  dateBlock.setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');

  out.autoResizeColumns(1, header.length);

  // Rebuilding a tab from scratch switches the active tab to it — restore whatever tab
  // was actually open (e.g. "Log") so an automatic rebuild triggered by someone else's
  // check-in doesn't yank the coach's current view around.
  try {
    var toRestore = ss.getSheetByName(previousActiveName);
    if (toRestore) ss.setActiveSheet(toRestore);
  } catch (activeErr) {}
}
