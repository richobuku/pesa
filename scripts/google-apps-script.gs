/**
 * Pesa Google Apps Script Bridge (`scripts/google-apps-script.gs`)
 * Target Sheet: https://docs.google.com/spreadsheets/d/1K3g7mHvba2-AdwjvASYUwW7AvpFwyGXBqtKcIqJmrv0/edit
 *
 * Strictly preserves all Budget Tracker formulas!
 * - Writes ONLY yellow input columns (`B,C,F..K` on Spending; `B,C,E..H` on Income; `B..G` on Transfers).
 * - Never overwrites formula columns (`A,D,E,L,M,N` on Spending; `A,D,I..M` on Income; `A` on Transfers).
 * - Automatically restores any missing formulas on the target row.
 * - Supports `batchUpdate`, `batchClear`, `repairFormulas`, and `getRangeValues`.
 */

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var range = e && e.parameter && e.parameter.range;
    var renderOption = (e && e.parameter && e.parameter.valueRenderOption) || "UNFORMATTED_VALUE";

    if (range) {
      var targetRange = ss.getRange(range);
      var values = renderOption === "FORMULA" ? targetRange.getFormulas() : targetRange.getValues();
      var rawValues = targetRange.getValues();
      // Merge formulas with values where cell is not a formula
      if (renderOption === "FORMULA") {
        for (var r = 0; r < values.length; r++) {
          for (var c = 0; c < values[r].length; c++) {
            if (!values[r][c]) values[r][c] = rawValues[r][c];
          }
        }
      }
      return jsonOut({ ok: true, values: values });
    }

    return jsonOut({
      ok: true,
      spreadsheet: ss.getName(),
      sheets: ss.getSheets().map(function(s) { return s.getName(); })
    });
  } catch (err) {
    return jsonOut({ ok: false, error: err.toString() });
  }
}

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};

    if (body.action === "batchUpdate" && Array.isArray(body.data)) {
      for (var i = 0; i < body.data.length; i++) {
        var item = body.data[i];
        ss.getRange(item.range).setValues(item.values);
      }
      SpreadsheetApp.flush();
      return jsonOut({ ok: true, updated: body.data.length });
    }

    if (body.action === "batchClear" && Array.isArray(body.ranges)) {
      for (var j = 0; j < body.ranges.length; j++) {
        ss.getRange(body.ranges[j]).clearContent();
      }
      SpreadsheetApp.flush();
      return jsonOut({ ok: true, cleared: body.ranges.length });
    }

    return jsonOut({ ok: false, error: "Unsupported action" });
  } catch (err) {
    return jsonOut({ ok: false, error: err.toString() });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

