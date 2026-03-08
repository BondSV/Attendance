const fs = require('fs');
const path = require('path');

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
const CSV_HEADER = 'ts_utc,module,group,intake,sid,phase,student_id,ip,ua_short\n';
const ACTIVE_YEAR_PATH = path.join(CSV_DIR, 'active_year.json');
const UPLOADS_DIR = path.join(CSV_DIR, 'uploads');
const YEAR_MAPPING_PATH = path.join(CSV_DIR, 'year_mapping.json');

fs.mkdirSync(CSV_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
  const yearSet = new Set();
  try {
    const files = fs.readdirSync(CSV_DIR);
    const re = /^attendance_(\d{4}-\d{2})\.csv$/;
    files.forEach(f => {
      const m = f.match(re);
      if (m) yearSet.add(m[1]);
    });
  } catch {}
  try {
    const mapping = readYearMapping();
    Object.keys(mapping).forEach(y => {
      if (/^\d{4}-\d{2}$/.test(y)) yearSet.add(y);
    });
  } catch {}
  return Array.from(yearSet).sort().reverse();
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

function fileMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return { size: stat.size, rows: Math.max(0, lines.length - 1) };
  } catch { return { size: 0, rows: 0 }; }
}

// ── Year mapping ──

function readYearMapping() {
  try {
    if (!fs.existsSync(YEAR_MAPPING_PATH)) return {};
    return JSON.parse(fs.readFileSync(YEAR_MAPPING_PATH, 'utf8'));
  } catch { return {}; }
}

function writeYearMapping(map) {
  fs.writeFileSync(YEAR_MAPPING_PATH, JSON.stringify(map, null, 2), 'utf8');
}

function resolveYearPath(yearLabel) {
  const mapping = readYearMapping();
  if (mapping[yearLabel]) {
    const mapped = mapping[yearLabel];
    const uploadPath = path.join(UPLOADS_DIR, mapped);
    if (fs.existsSync(uploadPath)) return uploadPath;
    const directPath = path.join(CSV_DIR, mapped);
    if (fs.existsSync(directPath)) return directPath;
  }
  return csvPathForYear(yearLabel);
}

// ── Uploaded files library ──

function listUploadedFiles() {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    return files
      .filter(f => f.endsWith('.csv') || f.endsWith('.txt'))
      .map(f => {
        const fp = path.join(UPLOADS_DIR, f);
        const meta = fileMetadata(fp);
        return { name: f, size: meta.size, rows: meta.rows, path: fp };
      })
      .sort((a, b) => b.size - a.size);
  } catch { return []; }
}

function saveUploadedFile(filename, content) {
  const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  let targetName = safeName;
  const targetPath = path.join(UPLOADS_DIR, targetName);
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    targetName = `${base}_${Date.now()}${ext}`;
  }
  const finalPath = path.join(UPLOADS_DIR, targetName);
  fs.writeFileSync(finalPath, content, 'utf8');
  return { name: targetName, path: finalPath, bytes: Buffer.byteLength(content) };
}

function deleteUploadedFile(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!filePath.startsWith(UPLOADS_DIR)) return { ok: false, error: 'Invalid path' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
  fs.unlinkSync(filePath);
  const mapping = readYearMapping();
  let changed = false;
  Object.keys(mapping).forEach(y => {
    if (mapping[y] === safeName) { delete mapping[y]; changed = true; }
  });
  if (changed) writeYearMapping(mapping);
  return { ok: true };
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
  resolveYearPath,
  readYearMapping,
  writeYearMapping,
  listUploadedFiles,
  saveUploadedFile,
  deleteUploadedFile,
  fileMetadata,
  CSV_DIR,
  CSV_HEADER,
  UPLOADS_DIR,
};
