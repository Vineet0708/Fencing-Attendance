/**
 * Fencing check-in receiver.
 * Paste this into a Google Sheet's Apps Script editor (Extensions > Apps Script),
 * then deploy it as a Web App (see README.md in the project for exact steps).
 * Every check-in/out event from the tablet server gets appended as a new row.
 */
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

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
