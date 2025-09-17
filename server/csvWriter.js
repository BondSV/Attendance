const fs = require('fs');
const path = require('path');

// Writer state for current open stream
let currentDateStr = null;
let currentStream = null;
let flushIntervalId = null;

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
function getUtcDateStr(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function openStreamForDate(dateStr) {
  const filePath = path.join(CSV_DIR, `${dateStr}.csv`);
  const exists = fs.existsSync(filePath);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  if (!exists) {
    stream.write('ts_utc,sid,phase,student_id,ip,ua_short\n');
  }
  return stream;
}

function rotateIfNeeded() {
  const today = getUtcDateStr();
  if (currentDateStr !== today) {
    // Close old stream
    if (currentStream) {
      try { currentStream.end(); } catch (e) { /* ignore */ }
      currentStream = null;
    }
    currentDateStr = today;
    currentStream = openStreamForDate(currentDateStr);
  }
}

// Periodically flush (fsync) to reduce data loss on crash
function startFlusher() {
  if (flushIntervalId) return;
  flushIntervalId = setInterval(() => {
    if (!currentStream) return;
    const fd = currentStream.fd;
    if (typeof fd === 'number') {
      try { fs.fsyncSync(fd); } catch (e) { /* ignore */ }
    }
  }, 5000);
}

async function appendCsvRow(fields) {
  rotateIfNeeded();
  startFlusher();

  // Sanitize fields: replace commas and newlines with spaces
  const safeFields = fields.map((f) => String(f).replace(/[,\n]/g, ' '));
  const row = safeFields.join(',') + '\n';

  return new Promise((resolve, reject) => {
    currentStream.write(row, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Ensure streams closed on process exit
process.on('exit', () => {
  if (currentStream) try { currentStream.end(); } catch (e) {}
  if (flushIntervalId) clearInterval(flushIntervalId);
});

module.exports = {
  appendCsvRow,
};