const fs = require('fs');
const path = require('path');

const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
const CSV_HEADER = 'ts_utc,module,group,intake,sid,phase,student_id,ip,ua_short\n';
const ACTIVE_YEAR_PATH = path.join(CSV_DIR, 'active_year.json');
const ASSIGNMENTS_PATH = path.join(CSV_DIR, 'assignments.json');

const CONFIG_FILES = new Set([
  'roster.csv', 'under18.csv', 'intakes.json',
  'active_year.json', 'assignments.json',
  'year_mapping.json'
]);

fs.mkdirSync(CSV_DIR, { recursive: true });

// ── Migration from old layout ──

function migrateFromOldLayout() {
  const oldUploadsDir = path.join(CSV_DIR, 'uploads');
  const oldMappingPath = path.join(CSV_DIR, 'year_mapping.json');
  let migrated = false;

  if (fs.existsSync(oldUploadsDir)) {
    try {
      const files = fs.readdirSync(oldUploadsDir);
      files.forEach(f => {
        if (!f.endsWith('.csv') && !f.endsWith('.txt')) return;
        const src = path.join(oldUploadsDir, f);
        let dest = path.join(CSV_DIR, f);
        if (fs.existsSync(dest)) {
          const ext = path.extname(f);
          const base = path.basename(f, ext);
          dest = path.join(CSV_DIR, `${base}_migrated${ext}`);
        }
        fs.renameSync(src, dest);
      });
      fs.rmdirSync(oldUploadsDir, { recursive: true });
      migrated = true;
    } catch (e) {
      console.warn('Migration: failed to move uploads/', e.message);
    }
  }

  if (fs.existsSync(oldMappingPath) && !fs.existsSync(ASSIGNMENTS_PATH)) {
    try {
      const oldMapping = JSON.parse(fs.readFileSync(oldMappingPath, 'utf8'));
      const assignments = {};
      Object.entries(oldMapping).forEach(([year, filename]) => {
        const filePath = path.join(CSV_DIR, filename);
        if (fs.existsSync(filePath)) {
          assignments[year] = filename;
        }
      });
      writeAssignments(assignments);
      migrated = true;
    } catch (e) {
      console.warn('Migration: failed to convert year_mapping.json', e.message);
    }
  }

  if (migrated && fs.existsSync(oldMappingPath)) {
    try { fs.unlinkSync(oldMappingPath); } catch {}
  }

  if (!fs.existsSync(ASSIGNMENTS_PATH)) {
    const assignments = {};
    try {
      const files = fs.readdirSync(CSV_DIR);
      const re = /^attendance_(\d{4}-\d{2})\.csv$/;
      files.forEach(f => {
        const m = f.match(re);
        if (m) assignments[m[1]] = f;
      });
    } catch {}
    if (Object.keys(assignments).length) {
      writeAssignments(assignments);
    }
  }
}

// ── Academic year ──

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

// ── Active year override ──

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

// ── Assignments ──

function readAssignments() {
  try {
    if (!fs.existsSync(ASSIGNMENTS_PATH)) return {};
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
  } catch { return {}; }
}

function writeAssignments(map) {
  fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(map, null, 2), 'utf8');
}

function assignFile(filename, yearLabel) {
  const filePath = path.join(CSV_DIR, filename);
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
  const assignments = readAssignments();
  Object.keys(assignments).forEach(y => {
    if (assignments[y] === filename) delete assignments[y];
  });
  assignments[yearLabel] = filename;
  writeAssignments(assignments);
  return { ok: true };
}

function unassignYear(yearLabel) {
  const assignments = readAssignments();
  if (!assignments[yearLabel]) return { ok: false, error: 'Year not assigned' };
  delete assignments[yearLabel];
  writeAssignments(assignments);
  return { ok: true };
}

// ── File path resolution ──

function csvPathForYear(yearLabel) {
  return path.join(CSV_DIR, `attendance_${yearLabel}.csv`);
}

function resolveYearPath(yearLabel) {
  const assignments = readAssignments();
  if (assignments[yearLabel]) {
    const assigned = path.join(CSV_DIR, assignments[yearLabel]);
    if (fs.existsSync(assigned)) return assigned;
  }
  return csvPathForYear(yearLabel);
}

function currentCsvPath() {
  return resolveYearPath(getActiveYear());
}

// ── File listing ──

function listAttendanceFiles() {
  const assignments = readAssignments();
  const yearByFile = {};
  Object.entries(assignments).forEach(([year, fname]) => {
    yearByFile[fname] = year;
  });

  try {
    const allFiles = fs.readdirSync(CSV_DIR);
    return allFiles
      .filter(f => (f.endsWith('.csv') || f.endsWith('.txt')) && !CONFIG_FILES.has(f))
      .map(f => {
        const fp = path.join(CSV_DIR, f);
        const meta = fileMetadata(fp);
        return {
          name: f,
          size: meta.size,
          rows: meta.rows,
          assignedYear: yearByFile[f] || null
        };
      })
      .sort((a, b) => {
        if (a.assignedYear && !b.assignedYear) return -1;
        if (!a.assignedYear && b.assignedYear) return 1;
        if (a.assignedYear && b.assignedYear) return b.assignedYear.localeCompare(a.assignedYear);
        return a.name.localeCompare(b.name);
      });
  } catch { return []; }
}

function listAssignedYears() {
  const assignments = readAssignments();
  return Object.keys(assignments)
    .filter(y => {
      const fp = path.join(CSV_DIR, assignments[y]);
      return fs.existsSync(fp);
    })
    .sort()
    .reverse();
}

// ── File operations ──

function fileMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return { size: stat.size, rows: Math.max(0, lines.length - 1) };
  } catch { return { size: 0, rows: 0 }; }
}

function createYearFile(yearLabel) {
  const filePath = csvPathForYear(yearLabel);
  const filename = path.basename(filePath);
  if (fs.existsSync(filePath)) return { ok: false, error: 'File already exists' };
  fs.writeFileSync(filePath, CSV_HEADER, 'utf8');
  assignFile(filename, yearLabel);
  return { ok: true };
}

function saveFile(filename, content) {
  const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  let targetName = safeName;
  const targetPath = path.join(CSV_DIR, targetName);
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    targetName = `${base}_${Date.now()}${ext}`;
  }
  const finalPath = path.join(CSV_DIR, targetName);
  fs.writeFileSync(finalPath, content, 'utf8');
  return { name: targetName, path: finalPath, bytes: Buffer.byteLength(content) };
}

function deleteFile(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(CSV_DIR, safeName);
  if (!filePath.startsWith(CSV_DIR)) return { ok: false, error: 'Invalid path' };
  if (CONFIG_FILES.has(safeName)) return { ok: false, error: 'Cannot delete config file' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };

  if (stream && streamPath === filePath) {
    try { stream.end(); } catch {}
    stream = null;
    streamPath = null;
  }

  fs.unlinkSync(filePath);

  const assignments = readAssignments();
  let changed = false;
  Object.keys(assignments).forEach(y => {
    if (assignments[y] === safeName) { delete assignments[y]; changed = true; }
  });
  if (changed) writeAssignments(assignments);

  return { ok: true };
}

// ── CSV writing ──

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

  if (!exists) {
    fs.writeFileSync(targetPath, CSV_HEADER, 'utf8');
    const activeYear = getActiveYear();
    const fname = path.basename(targetPath);
    const assignments = readAssignments();
    if (!Object.values(assignments).includes(fname)) {
      assignFile(fname, activeYear);
    }
  }

  stream = fs.createWriteStream(targetPath, { flags: 'a' });
  streamPath = targetPath;
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

// ── Run migration on load ──
migrateFromOldLayout();

module.exports = {
  appendCsvRow,
  currentCsvPath,
  csvPathForYear,
  resolveYearPath,
  listAttendanceFiles,
  listAssignedYears,
  getAcademicYear,
  getActiveYear,
  getActiveYearOverride,
  setActiveYearOverride,
  clearActiveYearOverride,
  createYearFile,
  saveFile,
  deleteFile,
  assignFile,
  unassignYear,
  readAssignments,
  fileMetadata,
  CSV_DIR,
  CSV_HEADER,
};
