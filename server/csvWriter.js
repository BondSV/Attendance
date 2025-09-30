const fs = require('fs');
const path = require('path');

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
const CSV_PATH = path.join(CSV_DIR, 'attendance.csv');

function ensureHeaderFormat() {
  if (!fs.existsSync(CSV_PATH)) return false;
  try {
    const fd = fs.openSync(CSV_PATH, 'r');
    const buffer = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const head = buffer.slice(0, bytes).toString('utf8');
    const firstLine = head.split(/\r?\n/)[0] || '';
    return firstLine.includes('module') && firstLine.includes('group');
  } catch (err) {
    return false;
  }
}

fs.mkdirSync(CSV_DIR, { recursive: true });

let stream = null;
let flushIntervalId = null;

function ensureStream() {
  if (stream) return;
  let exists = fs.existsSync(CSV_PATH);
  if (exists && !ensureHeaderFormat()) {
    try {
      const legacyPath = `${CSV_PATH}.legacy-${Date.now()}`;
      fs.renameSync(CSV_PATH, legacyPath);
      exists = false;
    } catch (err) {
      // If rename fails we proceed and append, which may duplicate columns but preserves data.
      console.warn('Unable to rotate legacy attendance CSV', err);
    }
  }
  stream = fs.createWriteStream(CSV_PATH, { flags: 'a' });
  if (!exists) {
    stream.write('ts_utc,module,group,sid,phase,student_id,ip,ua_short\n');
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