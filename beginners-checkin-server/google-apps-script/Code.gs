/**
 * Beginners class attendance receiver.
 * Use this in its OWN Google Sheet (not the main team's): Extensions > Apps Script, paste
 * this in, then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone), and
 * paste the Web App URL into the beginners coach dashboard.
 *
 * The app sends two kinds of messages: each check-in, and the full class list whenever it
 * changes. From those this script keeps a "Log" tab, a "Roster" tab, and one attendance
 * tab per semester.
 */

var SETTINGS_SHEET = 'Semester Settings';
var GREEN = '#93C47D', RED = '#E06666';

function doPost(e) {
  // Clicking "Run" in the editor calls this with no request; that's not a real check-in.
  if (!e || !e.postData) {
    return jsonOut({ ok: false, msg: 'No request body received — this endpoint expects a real POST, not a manual Run.' });
  }
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  if (data.type === 'roster') {
    var roster = ss.getSheetByName('Roster') || ss.insertSheet('Roster');
    roster.clearContents();
    var names = (data.names || []).map(function (n) { return [n]; });
    roster.getRange(1, 1, names.length + 1, 1).setValues([['Name']].concat(names));
    roster.getRange(1, 1).setFontWeight('bold');
    roster.setFrozenRows(1);
    generateAttendanceSheet(semesterKeyOfDay(today));
  } else {
    var log = ss.getSheetByName('Log');
    if (!log) {
      log = ss.insertSheet('Log');
      log.appendRow(['Name', 'Date', 'Time']);
      log.getRange(1, 1, 1, 3).setFontWeight('bold');
      log.setFrozenRows(1);
      log.setColumnWidths(1, 3, 180);
      log.getRange('B:B').setNumberFormat('@'); // keep dates as the plain text the app sent
    }
    log.appendRow([data.name, data.day, data.time]);
    generateAttendanceSheet(semesterKeyOfDay(data.day || today));
  }
  return jsonOut({ ok: true });
}

// Lets you sanity-check the deployment URL by opening it in a browser.
function doGet(e) {
  return jsonOut({ ok: true, msg: 'Beginners attendance receiver is live.' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Beginners Attendance')
    .addItem('Rebuild All Semester Sheets', 'rebuildAllAttendanceSheets')
    .addToUi();
}

// Fall = Aug-Dec, Spring = Jan-May, Summer = Jun-Jul, from a 'yyyy-MM-dd' day.
function semesterKeyOfDay(day) {
  var year = Number(day.slice(0, 4));
  var month = Number(day.slice(5, 7));
  if (month >= 8) return 'Fall ' + year;
  if (month <= 5) return 'Spring ' + year;
  return 'Summer ' + year;
}

// Sheets may turn a 'yyyy-MM-dd' cell into a real date (e.g. after a hand edit); accept both.
function dayOfCell(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  var text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// Every valid Log row as { name, day }.
function readLog() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var rows = sheet.getDataRange().getValues();
  rows.shift();
  return rows
    .map(function (r) { return { name: String(r[0]).trim(), day: dayOfCell(r[1]) }; })
    .filter(function (ev) { return ev.name && ev.day; });
}

function readRoster() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Roster');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (n) { return n; });
}

// The number of classes you require per semester, typed into the "Semester Settings" tab.
// Creates the tab and a blank row for a new semester so there's always a place to fill in.
function getRequiredClasses(semesterKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.appendRow(['Semester', 'Required classes']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 2, 170);
  }
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === semesterKey) {
      var n = Number(values[i][1]);
      return values[i][1] !== '' && n > 0 ? n : null;
    }
  }
  sheet.appendRow([semesterKey, '']);
  return null;
}

// Rebuilds a tab for every semester in the Log, plus the current one. Run this after
// pasting the script in, after editing the Log by hand, or after changing Semester Settings.
function rebuildAllAttendanceSheets() {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var semesters = {};
  semesters[semesterKeyOfDay(today)] = true;
  readLog().forEach(function (ev) { semesters[semesterKeyOfDay(ev.day)] = true; });
  Object.keys(semesters).forEach(function (key) { generateAttendanceSheet(key); });
}

/**
 * Rebuilds ONE semester's attendance tab (e.g. "Fall 2026"): one row per person, one
 * column per class date (any day with at least one check-in). Green "Present" or red.
 * Rows cover everyone on the current class list, plus anyone since removed from it who
 * attended this semester.
 */
function generateAttendanceSheet(semesterKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var events = readLog().filter(function (ev) { return semesterKeyOfDay(ev.day) === semesterKey; });

  var present = {}, dateSet = {}, nameSet = {};
  readRoster().forEach(function (n) { nameSet[n] = true; });
  events.forEach(function (ev) {
    present[ev.name + '|' + ev.day] = true;
    dateSet[ev.day] = true;
    nameSet[ev.name] = true;
  });
  var dates = Object.keys(dateSet).sort();
  var names = Object.keys(nameSet).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  if (!names.length) return;

  var previousActiveName = ss.getActiveSheet().getName();
  var required = getRequiredClasses(semesterKey);
  var target = required || dates.length;

  var out = ss.getSheetByName(semesterKey);
  if (out) ss.deleteSheet(out);
  out = ss.insertSheet(semesterKey);

  out.getRange(1, 1, 1, 4).setValues([['Classes held so far:', dates.length, 'Required classes this semester:',
    required || 'not set — fill in "' + SETTINGS_SHEET + '" tab']]).setFontWeight('bold');

  var HEADER_ROW = 3, FIRST_DATE_COL = 4;
  var header = ['Name', 'Classes attended', 'Attended / required'].concat(dates.map(function (day) {
    return Utilities.formatDate(new Date(day + 'T12:00:00Z'), 'UTC', 'MMM d');
  }));
  out.getRange(HEADER_ROW, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  out.setFrozenRows(HEADER_ROW);
  out.setFrozenColumns(1);

  var rowsOut = [], colorsOut = [];
  names.forEach(function (name) {
    var attended = 0, cells = [], colors = [];
    dates.forEach(function (day) {
      var here = !!present[name + '|' + day];
      if (here) attended++;
      cells.push(here ? 'Present' : '');
      colors.push(here ? GREEN : RED);
    });
    var ratio = target ? attended + '/' + target + ' (' + Math.round((attended / target) * 100) + '%)' : String(attended);
    rowsOut.push([name, attended, ratio].concat(cells));
    colorsOut.push(colors);
  });

  out.getRange(HEADER_ROW + 1, 1, rowsOut.length, header.length).setValues(rowsOut);
  out.getRange(HEADER_ROW + 1, 1, rowsOut.length, 1).setFontWeight('bold');
  if (dates.length) {
    out.getRange(HEADER_ROW + 1, FIRST_DATE_COL, rowsOut.length, dates.length)
      .setBackgrounds(colorsOut).setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  }
  out.autoResizeColumns(1, header.length);

  // Rebuilding switches the active tab to the new one; put the view back where it was so
  // someone else's check-in doesn't yank the coach's screen around.
  try {
    var toRestore = ss.getSheetByName(previousActiveName);
    if (toRestore) ss.setActiveSheet(toRestore);
  } catch (activeErr) {}
}
