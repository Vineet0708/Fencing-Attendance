/**
 * Fencing check-in receiver.
 * Paste this into a Google Sheet's Apps Script editor (Extensions > Apps Script),
 * then deploy it as a Web App (see README.md in the project for exact steps).
 * Every check-in/out event from the tablet server gets appended as a new row.
 */
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
  }

  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([data.name, data.action, data.time]);

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

// Adds a "Fencing Attendance" menu with a button to (re)build the Weekly Summary tab.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fencing Attendance')
    .addItem('Refresh Weekly Summary', 'generateWeeklySummary')
    .addToUi();
}

/**
 * Rebuilds a "Weekly Summary" tab from the raw "Log" sheet: per fencer, per week
 * (Monday-start), how many practices they attended and how many hours. Also totals:
 * how many weeks they hit at least 2 practices, and their all-time practice/hour totals.
 *
 * A D.N.C. entry still counts as attending that day (they were clearly there), but
 * contributes 0 hours for that session, since the real checkout time is unknown.
 */
function generateWeeklySummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName('Log');
  if (!logSheet || logSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No check-in data yet — nothing to summarize.');
    return;
  }
  var tz = Session.getScriptTimeZone();
  var rows = logSheet.getDataRange().getValues();
  rows.shift(); // drop header row

  // Group raw events by fencer name.
  var byFencer = {};
  rows.forEach(function (r) {
    var name = r[0], action = r[1], time = new Date(r[2]);
    if (!name || !action || isNaN(time.getTime())) return;
    if (!byFencer[name]) byFencer[name] = [];
    byFencer[name].push({ action: String(action).toLowerCase(), time: time });
  });

  function dayKeyOf(d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
  function mondayOf(dayKey) {
    var d = new Date(dayKey + 'T00:00:00');
    var shift = (d.getDay() === 0 ? -6 : 1 - d.getDay());
    d.setDate(d.getDate() + shift);
    return dayKeyOf(d);
  }

  // Reconstruct sessions per fencer per calendar day: attended (bool) + hours (number).
  var perFencerDay = {};
  var allDays = {};
  Object.keys(byFencer).forEach(function (name) {
    var events = byFencer[name].slice().sort(function (a, b) { return a.time - b.time; });
    var openIn = null;
    perFencerDay[name] = {};
    events.forEach(function (e) {
      var dk = dayKeyOf(e.time);
      allDays[dk] = true;
      if (e.action.indexOf('in') === 0) { // 'in'
        openIn = e.time;
        if (!(dk in perFencerDay[name])) perFencerDay[name][dk] = 0;
      } else if (e.action === 'out') {
        if (openIn) {
          perFencerDay[name][dk] = (perFencerDay[name][dk] || 0) + (e.time - openIn) / 3600000;
          openIn = null;
        }
      } else { // d.n.c. or anything else closes the session with no hours
        if (openIn) { perFencerDay[name][dk] = perFencerDay[name][dk] || 0; openIn = null; }
      }
    });
  });

  var weeks = Object.keys(allDays).map(mondayOf)
    .filter(function (w, i, arr) { return arr.indexOf(w) === i; })
    .sort();
  var fencers = Object.keys(perFencerDay).sort();

  var out = ss.getSheetByName('Weekly Summary');
  if (out) ss.deleteSheet(out);
  out = ss.insertSheet('Weekly Summary');

  var header = ['Fencer'];
  weeks.forEach(function (w) { header.push('Wk of ' + w + ' (practices)', 'Wk of ' + w + ' (hours)'); });
  header.push('Weeks ≥2 practices', 'Total practices', 'Total hours');
  out.appendRow(header);

  fencers.forEach(function (name) {
    var row = [name], weeksMet = 0, totalPractices = 0, totalHours = 0;
    weeks.forEach(function (w) {
      var practices = 0, hours = 0;
      Object.keys(perFencerDay[name]).forEach(function (dk) {
        if (mondayOf(dk) === w) { practices += 1; hours += perFencerDay[name][dk]; }
      });
      row.push(practices, Math.round(hours * 100) / 100);
      if (practices >= 2) weeksMet++;
      totalPractices += practices;
      totalHours += hours;
    });
    row.push(weeksMet, totalPractices, Math.round(totalHours * 100) / 100);
    out.appendRow(row);
  });

  out.getRange(1, 1, 1, header.length).setFontWeight('bold');
  out.setFrozenRows(1);
  out.setFrozenColumns(1);
  if (fencers.length) out.autoResizeColumns(1, header.length);
}
