const fs = require('fs');
const path = require('path');

/**
 * CSV writer module. Each check‑in record is appended to a daily CSV file.  The
 * file path is derived from the UTC date (e.g. `2025‑10‑03.csv`).  If the
 * directory does not exist it will be created on the fly.  A header row is
 * written when a new file is created.
 */

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');

// Ensure the base directory exists.  This call is synchronous because it
// executes once at startup and avoids race conditions later.
fs.mkdirSync(CSV_DIR, { recursive: true });

/**
 * Append a row to the CSV file for the current UTC date.  The row will be
 * joined by commas and terminated by a newline.  If the file does not
 * already exist, a header row will be written first.
 *
 * @param {Array<string|number>} fields Values for the row in the order
 *   [ts_utc, sid, phase, student_id, ip, ua_short].  Fields containing
 *   commas or newlines are sanitised.
 */
async function appendCsvRow(fields) {
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const fileName = `${yyyy}-${mm}-${dd}.csv`;
  const filePath = path.join(CSV_DIR, fileName);

  // Sanitize fields: replace commas and newlines with spaces
  const safeFields = fields.map((f) => String(f).replace(/[,\n]/g, ' '));
  const row = safeFields.join(',') + '\n';

  // Determine whether we need to write a header row
  const exists = fs.existsSync(filePath);
  let header = '';
  if (!exists) {
    header = 'ts_utc,sid,phase,student_id,ip,ua_short\n';
  }

  // Append the header (if needed) and row
  await fs.promises.appendFile(filePath, header + row);
}

module.exports = {
  appendCsvRow,
};
