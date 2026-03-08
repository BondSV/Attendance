const fs = require('fs');
const path = require('path');

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
const CSV_HEADER = 'ts_utc,module,group,intake,sid,phase,student_id,ip,ua_short\n';
const ACTIVE_YEAR_PATH = path.join(CSV_DIR, 'active_year.json');

fs.mkdirSync(CSV_DIR, { recursive: true });

function getAcademicYear(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const pastBoundary = m > 8 || (m === 8 && day >= 15);
  const startYear = pastBoundary ? y : y - 1;
  const endShort = String(startYear + 1).slice(2);
  return { label: `${startYear}-${endShort}`, startYear };
}

function getActiveYearOverride() {
  try {
    if (!fs.existsSync(ACTIVE_YEAR_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(ACTIVE_YEAR_PATH, 'utf8'));
    if (data && data.year && /^\d{4}-\d{2}$/.test(data.year)) return data.year;
    return null;
  } catch { return null; }
}

function setActiveYearOverride(yearLabel) {
  fs.writeFileSync(ACTIVE_YEAR_PATH, JSON.stringify({ year: yearLabel }, null, 2), 'utf8');
}

function clearActiveYearOverride() {
  try { if (fs.existsSync(ACTIVE_YEAR_PATH)) fs.unlinkSync(ACTIVE_YEAR_PATH); } catch {}
}

function getActiveYear() {
  return getActiveYearOverride() || getAcademicYear().label;
}

function csvPathForYear(yearLabel) {
  return path.join(CSV_DIR, `attendance_${yearLabel}.csv`);
}

function currentCsvPath() {
  return csvPathForYear(getActiveYear());
}

function listAvailableYears() {
  try {
    const files = fs.readdirSync(CSV_DIR);
    const years = [];
    const re = /^attendance_(\d{4}-\d{2})\.csv$/;
    files.forEach(f => {
      const m = f.match(re);
      if (m) years.push(m[1]);
    });
    years.sort().reverse();
    return years;
  } catch {
    return [];
  }
}

function createYearFile(yearLabel) {
  const filePath = csvPathForYear(yearLabel);
  if (fs.existsSync(filePath)) return { ok: false, error: 'File already exists' };
  fs.writeFileSync(filePath, CSV_HEADER, 'utf8');
  return { ok: true };
}

function deleteYearFile(yearLabel) {
  const filePath = csvPathForYear(yearLabel);
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
  if (stream && streamPath === filePath) {
    try { stream.end(); } catch {}
    stream = null;
    streamPath = null;
  }
  fs.unlinkSync(filePath);
  return { ok: true };
}

function yearFileSize(yearLabel) {
  const filePath = csvPathForYear(yearLabel);
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function yearFileRowCount(yearLabel) {
  const filePath = csvPathForYear(yearLabel);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return Math.max(0, lines.length - 1);
  } catch { return 0; }
}

let stream = null;
let streamPath = null;
let flushIntervalId = null;

function ensureHeaderFormat(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const head = buffer.slice(0, bytes).toString('utf8');
    const firstLine = head.split(/\r?\n/)[0] || '';
    return firstLine.includes('module') && firstLine.includes('group') && firstLine.includes('intake');
  } catch {
    return false;
  }
}

function ensureStream() {
  const targetPath = currentCsvPath();
  if (stream && streamPath === targetPath) return;
  if (stream) { try { stream.end(); } catch {} }
  stream = null;
  streamPath = null;

  let exists = fs.existsSync(targetPath);
  if (exists && !ensureHeaderFormat(targetPath)) {
    try {
      const legacyPath = `${targetPath}.legacy-${Date.now()}`;
      fs.renameSync(targetPath, legacyPath);
      exists = false;
    } catch (err) {
      console.warn('Unable to rotate legacy attendance CSV', err);
    }
  }
  stream = fs.createWriteStream(targetPath, { flags: 'a' });
  streamPath = targetPath;
  if (!exists) {
    stream.write(CSV_HEADER);
  }
}

function startFlusher() {
  if (flushIntervalId) return;
  flushIntervalId = setInterval(() => {
    if (!stream) return;
    const fd = stream.fd;
    if (typeof fd === 'number') {
      try { fs.fsyncSync(fd); } catch {}
    }
  }, 5000);
}

async function appendCsvRow(fields) {
  ensureStream();
  startFlusher();
  const safeFields = fields.map((f) => {
    let v = String(f).replace(/\n/g, ' ');
    if (v.includes(',') || v.includes('"')) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  });
  const row = safeFields.join(',') + '\n';
  return new Promise((resolve, reject) => {
    stream.write(row, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

process.on('exit', () => {
  if (stream) try { stream.end(); } catch {}
  if (flushIntervalId) clearInterval(flushIntervalId);
});

module.exports = {
  appendCsvRow,
  currentCsvPath,
  csvPathForYear,
  listAvailableYears,
  getAcademicYear,
  getActiveYear,
  getActiveYearOverride,
  setActiveYearOverride,
  clearActiveYearOverride,
  createYearFile,
  deleteYearFile,
  yearFileSize,
  yearFileRowCount,
  CSV_DIR,
  CSV_HEADER,
};
