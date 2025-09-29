const fs = require('fs');
const path = require('path');

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
const CSV_PATH = path.join(CSV_DIR, 'attendance.csv');

fs.mkdirSync(CSV_DIR, { recursive: true });

let stream = null;
let flushIntervalId = null;

function ensureStream() {
  if (stream) return;
  const exists = fs.existsSync(CSV_PATH);
  stream = fs.createWriteStream(CSV_PATH, { flags: 'a' });
  if (!exists) {
    stream.write('ts_utc,sid,phase,student_id,ip,ua_short\n');
  }
}

function startFlusher() {
  if (flushIntervalId) return;
  flushIntervalId = setInterval(() => {
    if (!stream) return;
    const fd = stream.fd;
    if (typeof fd === 'number') {
      try { fs.fsyncSync(fd); } catch (e) { /* ignore */ }
    }
  }, 5000);
}

async function appendCsvRow(fields) {
  ensureStream();
  startFlusher();
  const safeFields = fields.map((f) => String(f).replace(/[\n,]/g, ' '));
  const row = safeFields.join(',') + '\n';
  return new Promise((resolve, reject) => {
    stream.write(row, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

process.on('exit', () => {
  if (stream) try { stream.end(); } catch (e) {}
  if (flushIntervalId) clearInterval(flushIntervalId);
});

module.exports = {
  appendCsvRow,
  CSV_PATH,
};