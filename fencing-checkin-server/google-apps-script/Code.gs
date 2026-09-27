/**
 * Fencing check-in receiver.
 * Paste this into a Google Sheet's Apps Script editor (Extensions > Apps Script),
 * then deploy it as a Web App (see README.md in the project for exact steps).
 * Every check-in/out event from the tablet server gets appended as a new row.
 */

// How many minutes after the earliest check-in of the day counts as "late" for that day.
// There's no concept of a scheduled practice start time in the app, so "late" is relative
// to whoever else showed up that day, not a fixed clock time. Tune as needed.
var LATE_THRESHOLD_MINUTES = 10;

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
  generateAttendanceSheet(semesterKeyOf(new Date(data.time), tz));

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

// Fall = Aug-Dec, Spring = Jan-May, Summer = Jun-Jul. Adjust here if your school's terms
// don't line up with this.
function semesterKeyOf(date, tz) {
  var month = Number(Utilities.formatDate(date, tz, 'M'));
  var year = Number(Utilities.formatDate(date, tz, 'yyyy'));
  if (month >= 8) return 'Fall ' + year;
  if (month <= 5) return 'Spring ' + year;
  return 'Summer ' + year;
}

// Rebuilds the tab for whichever semester "today" falls in, and jumps you to it. The
// automatic per-check-in rebuild (see doPost) deliberately does NOT switch your active
// tab, so use this when you want to manually jump over and look.
function refreshCurrentSemesterAttendance() {
  var tz = Session.getScriptTimeZone();
  var key = semesterKeyOf(new Date(), tz);
  generateAttendanceSheet(key);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = ss.getSheetByName(key);
  if (out) ss.setActiveSheet(out);
}

// Scans the whole Log for every semester that appears in it and (re)builds a tab for
// each. Use this once after pasting this script in for the first time, to backfill
// attendance sheets for data that already existed before this feature did.
function rebuildAllAttendanceSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName('Log');
  if (!logSheet || logSheet.getLastRow() < 2) {
    try { SpreadsheetApp.getUi().alert('No check-in data yet — nothing to build.'); } catch (uiErr) {}
    return;
  }
  var tz = Session.getScriptTimeZone();
  var rows = logSheet.getDataRange().getValues();
  rows.shift();

  var semesters = {};
  rows.forEach(function (r) {
    var t = new Date(r[2]);
    if (!r[0] || !r[1] || isNaN(t.getTime())) return;
    semesters[semesterKeyOf(t, tz)] = true;
  });
  Object.keys(semesters).forEach(function (key) { generateAttendanceSheet(key); });
}

/**
 * Rebuilds ONE semester's attendance tab (named after the semester, e.g. "Fall 2026")
 * from the raw "Log" sheet: one row per fencer, one column per practice date that had
 * at least one check-in, color-coded:
 *   green  "123min"              — attended, on time
 *   amber  "Check in late - Nmin" — checked in more than LATE_THRESHOLD_MINUTES after
 *                                   the earliest check-in recorded that day
 *   amber  "No Check Out"        — checked in but never checked out (closes as D.N.C.)
 *   red    "0min"                — checked in/out but the computed time on the strip was
 *                                   zero; counts as a missed practice
 *   red    (blank)                — no record for that fencer on that date at all
 * Plus rollup columns: total minutes; counts of missed / late / not-signed-out days;
 * fraction/percent of practices attended; how many Monday-start weeks (of those with at
 * least one practice this semester) the fencer attended 2 or more practices in, both as
 * a raw count and as a fraction/percent of all such weeks in the semester.
 *
 * Only fencers with at least one Log entry in this semester appear — a fencer who never
 * checked in even once won't show up, since the Log (and this script) never receives a
 * full roster, only individual check-in/out events.
 */
function generateAttendanceSheet(semesterKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName('Log');
  if (!logSheet || logSheet.getLastRow() < 2) return;

  var tz = Session.getScriptTimeZone();
  var previousActiveName = ss.getActiveSheet().getName();

  var rows = logSheet.getDataRange().getValues();
  rows.shift(); // drop header row

  function dayKeyOf(d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
  function mondayOf(dayKey) {
    var d = new Date(dayKey + 'T00:00:00');
    var shift = (d.getDay() === 0 ? -6 : 1 - d.getDay());
    d.setDate(d.getDate() + shift);
    return dayKeyOf(d);
  }

  var semesterRows = rows
    .map(function (r) { return { name: r[0], action: String(r[1]), time: new Date(r[2]) }; })
    .filter(function (r) {
      return r.name && r.action && !isNaN(r.time.getTime()) && semesterKeyOf(r.time, tz) === semesterKey;
    });
  if (!semesterRows.length) return;

  // Distinct practice dates (any day with >=1 event) and fencers, both sorted.
  var dateSet = {}, fencerSet = {};
  semesterRows.forEach(function (r) {
    dateSet[dayKeyOf(r.time)] = true;
    fencerSet[r.name] = true;
  });
  var dates = Object.keys(dateSet).sort();
  var fencers = Object.keys(fencerSet).sort();

  // Every Monday-start week that had at least one practice date this semester — the
  // denominator for the "weeks with 2+ practices" fraction below.
  var weeksInSemester = dates.map(mondayOf)
    .filter(function (w, i, arr) { return arr.indexOf(w) === i; })
    .sort();

  // Earliest "in" of each date across the whole roster — that date's practice start.
  var teamStartByDate = {};
  semesterRows.forEach(function (r) {
    if (r.action !== 'in') return;
    var dk = dayKeyOf(r.time);
    if (!teamStartByDate[dk] || r.time < teamStartByDate[dk]) teamStartByDate[dk] = r.time;
  });

  // Group each fencer's rows by date.
  var byFencerDate = {};
  semesterRows.forEach(function (r) {
    var dk = dayKeyOf(r.time);
    byFencerDate[r.name] = byFencerDate[r.name] || {};
    byFencerDate[r.name][dk] = byFencerDate[r.name][dk] || [];
    byFencerDate[r.name][dk].push(r);
  });

  var out = ss.getSheetByName(semesterKey);
  if (out) ss.deleteSheet(out);
  out = ss.insertSheet(semesterKey);

  out.getRange(1, 1).setValue('Total # of practices this semester:');
  out.getRange(1, 2).setValue(dates.length).setFontWeight('bold');

  var HEADER_ROW = 3;
  var baseHeader = ['Fencer', 'Total Time On The Strip (minutes)', 'Total # of missed practices',
    'Total # of late practices', 'Total # of not signed out practices/left early',
    'Practices Attended (fraction/%)', 'Weeks with 2+ Practices', 'Weeks with 2+ Practices (fraction/%)'];
  var FIRST_DATE_COL = baseHeader.length + 1; // 1-indexed column where date columns start
  var header = baseHeader.concat(dates.map(function (dk) {
    return Utilities.formatDate(new Date(dk + 'T12:00:00'), tz, 'MMM d');
  }));
  out.getRange(HEADER_ROW, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  out.setFrozenRows(HEADER_ROW);
  out.setFrozenColumns(1);

  var GREEN = '#93C47D', RED = '#E06666', AMBER = '#F1C232';

  fencers.forEach(function (name, fi) {
    var rowIndex = HEADER_ROW + 1 + fi;
    var totalMinutes = 0, missed = 0, late = 0, noCheckout = 0;
    var dateValues = [], dateColors = [];

    dates.forEach(function (dk) {
      var events = ((byFencerDate[name] || {})[dk] || []).slice()
        .sort(function (a, b) { return a.time - b.time; });

      if (!events.length) {
        missed++;
        dateValues.push('');
        dateColors.push(RED);
        return;
      }

      var openIn = null, firstIn = null, totalMs = 0, hasDnc = false;
      events.forEach(function (ev) {
        if (ev.action === 'in') {
          openIn = ev.time;
          if (!firstIn) firstIn = ev.time;
        } else if (ev.action === 'out') {
          if (openIn) { totalMs += ev.time - openIn; openIn = null; }
        } else if (ev.action === 'D.N.C.') {
          hasDnc = true;
          openIn = null;
        }
      });

      if (hasDnc) {
        noCheckout++;
        dateValues.push('No Check Out');
        dateColors.push(AMBER);
        return;
      }
      if (totalMs <= 0) {
        missed++;
        dateValues.push('0min');
        dateColors.push(RED);
        return;
      }

      var minutes = Math.round(totalMs / 60000);
      var teamStart = teamStartByDate[dk];
      var latenessMin = teamStart ? Math.round((firstIn - teamStart) / 60000) : 0;
      if (latenessMin > LATE_THRESHOLD_MINUTES) {
        late++;
        totalMinutes += minutes;
        dateValues.push('Check in late - ' + latenessMin + 'min');
        dateColors.push(AMBER);
      } else {
        totalMinutes += minutes;
        dateValues.push(minutes + 'min');
        dateColors.push(GREEN);
      }
    });

    // Weekly attendance rollups. A date counts as "attended" if it isn't colored red —
    // red is used only for a true miss (no record) and a 0min session, both of which
    // already fed into `missed` above.
    var attendedByWeek = {};
    dates.forEach(function (dk, di) {
      var attended = dateColors[di] !== RED;
      var wk = mondayOf(dk);
      attendedByWeek[wk] = (attendedByWeek[wk] || 0) + (attended ? 1 : 0);
    });
    var weeksMet = weeksInSemester.filter(function (wk) { return (attendedByWeek[wk] || 0) >= 2; }).length;
    var totalWeeks = weeksInSemester.length;
    var attendedCount = dates.length - missed;
    var practicesPct = dates.length ? Math.round((attendedCount / dates.length) * 100) : 0;
    var weeksPct = totalWeeks ? Math.round((weeksMet / totalWeeks) * 100) : 0;
    var practicesLabel = attendedCount + '/' + dates.length + ' (' + practicesPct + '%)';
    var weeksLabel = weeksMet + '/' + totalWeeks + ' (' + weeksPct + '%)';

    var row = [name, totalMinutes, missed, late, noCheckout, practicesLabel, weeksMet, weeksLabel].concat(dateValues);
    out.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    out.getRange(rowIndex, 1).setFontWeight('bold');

    var dateRange = out.getRange(rowIndex, FIRST_DATE_COL, 1, dates.length);
    dateRange.setBackgrounds([dateColors]);
    dateRange.setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  });

  out.autoResizeColumns(1, header.length);

  // Rebuilding a tab from scratch switches the active tab to it — restore whatever tab
  // was actually open (e.g. "Log") so an automatic rebuild triggered by someone else's
  // check-in doesn't yank the coach's current view around.
  try {
    var toRestore = ss.getSheetByName(previousActiveName);
    if (toRestore) ss.setActiveSheet(toRestore);
  } catch (activeErr) {}
}
