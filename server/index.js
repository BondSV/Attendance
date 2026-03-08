const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { issueVerification, consumeVerification, acquireDeviceLock, peekDeviceLock } = require('./memoryState');
const { appendCsvRow, currentCsvPath, csvPathForYear, listAvailableYears, getAcademicYear, getActiveYear, getActiveYearOverride, setActiveYearOverride, clearActiveYearOverride, createYearFile, deleteYearFile, yearFileSize, yearFileRowCount, CSV_DIR, CSV_HEADER } = require('./csvWriter');
const { canCheckin, CHECKIN_WINDOW_MS } = require('./checkins');
const { issueChallenge, validateChallenge, DEFAULT_TTL_MS } = require('./challenges');
const { registerManualOverride, consumeManualOverride, logManualOverrideUsage } = require('./manualOverrides');

const PORT = process.env.PORT || 8080;
const ANOMALY_LOG_PATH = process.env.ANOMALY_LOG_PATH || null;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INTAKES_PATH = path.join(CSV_DIR, 'intakes.json');
const ROSTER_PATH = path.join(CSV_DIR, 'roster.csv');
const UNDER18_PATH = path.join(CSV_DIR, 'under18.csv');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'raveadmin2026';
const MANUAL_OVERRIDE_PASSWORD = process.env.MANUAL_OVERRIDE_PASSWORD || 'RaveCheck2026';
const MANUAL_OVERRIDE_PASSWORD_BUFFER = MANUAL_OVERRIDE_PASSWORD ? Buffer.from(MANUAL_OVERRIDE_PASSWORD, 'utf8') : null;
const MANUAL_OVERRIDE_PASSWORD_VERSION = MANUAL_OVERRIDE_PASSWORD ? crypto.createHash('sha256').update(MANUAL_OVERRIDE_PASSWORD_BUFFER).digest('hex').slice(0, 12) : null;

const OVERRIDE_MAX_ATTEMPTS = 5;
const OVERRIDE_WINDOW_MS = 15 * 60 * 1000;
const overrideAttempts = new Map();

function checkOverrideRateLimit(key) {
  const now = Date.now();
  const entry = overrideAttempts.get(key);
  if (!entry || (now - entry.windowStart) > OVERRIDE_WINDOW_MS) {
    overrideAttempts.set(key, { windowStart: now, failures: 0 });
    return true;
  }
  return entry.failures < OVERRIDE_MAX_ATTEMPTS;
}

function recordOverrideFailure(key) {
  const now = Date.now();
  const entry = overrideAttempts.get(key);
  if (!entry || (now - entry.windowStart) > OVERRIDE_WINDOW_MS) {
    overrideAttempts.set(key, { windowStart: now, failures: 1 });
  } else {
    entry.failures += 1;
  }
}

function resetOverrideFailures(key) {
  overrideAttempts.delete(key);
}

function verifyManualOverridePassword(candidate) {
  if (!MANUAL_OVERRIDE_PASSWORD_BUFFER) return false;
  if (typeof candidate !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  if (candidateBuffer.length !== MANUAL_OVERRIDE_PASSWORD_BUFFER.length) return false;
  try {
    return crypto.timingSafeEqual(candidateBuffer, MANUAL_OVERRIDE_PASSWORD_BUFFER);
  } catch {
    return false;
  }
}

function sendJson(res, payload, status = 200) {
  const data = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' };
  if (process.env.ALLOW_CORS_ALL === '1') headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(status, headers);
  res.end(data);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
  });
}

function logAnomaly(obj) {
  const msg = `[ANOMALY] ${new Date().toISOString()} ${JSON.stringify(obj)}`;
  console.warn(msg);
  if (ANOMALY_LOG_PATH) {
    try { fs.appendFileSync(ANOMALY_LOG_PATH, msg + '\n'); } catch {}
  }
}

function getClientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (header && typeof header === 'string') {
    const parts = header.split(',');
    if (parts.length) return parts[0].trim();
  }
  return req.socket.remoteAddress || '';
}

const VALID_PHASES = new Set(['start', 'break1', 'break2', 'end']);

function normalizePhaseInput(value) {
  const raw = (value || 'start').toString().trim().toLowerCase();
  if (raw === 'break' || raw === 'break1' || raw === 'break 1') return 'break1';
  if (raw === 'break2' || raw === 'break 2') return 'break2';
  if (raw === 'start' || raw === 'end') return raw;
  return raw;
}

function buildDeviceKey({ sid, phase, deviceId, req }) {
  const parts = [];
  const normalizedSid = (sid || '').toString().trim();
  const normalizedPhase = (phase || '').toString().trim().toLowerCase();
  if (normalizedSid) parts.push(`sid:${normalizedSid}`);
  if (normalizedPhase) parts.push(`phase:${normalizedPhase}`);
  const stableDeviceId = (deviceId || '').toString().trim();
  if (stableDeviceId) parts.push(`device:${stableDeviceId}`);
  const clientIp = getClientIp(req);
  if (clientIp) parts.push(`ip:${clientIp}`);
  const userAgent = (req.headers['user-agent'] || '').toString().trim();
  if (userAgent) {
    const truncatedUa = userAgent.length > 160 ? userAgent.slice(0, 160) : userAgent;
    parts.push(`ua:${truncatedUa}`);
  }
  return parts.join('|') || 'anon-device';
}

function readIntakesConfig() {
  try {
    if (!fs.existsSync(INTAKES_PATH)) return {};
    const raw = fs.readFileSync(INTAKES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readModuleListFromCsv() {
  const csvPath = currentCsvPath();
  if (!fs.existsSync(csvPath)) return [];
  try {
    const text = fs.readFileSync(csvPath, 'utf8');
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    if (!lines.length) return [];
    const header = (lines[0] || '').split(',').map(h => h.trim().toLowerCase());
    const moduleIdx = header.indexOf('module');
    const sidIdx = header.indexOf('sid');
    const modules = new Set();
    const modulePattern = /^[A-Z]{3}\d{5}$/;
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      const parts = raw.split(',');
      let candidate = '';
      if (moduleIdx !== -1 && parts[moduleIdx]) {
        candidate = parts[moduleIdx].trim();
      } else if (sidIdx !== -1 && parts[sidIdx]) {
        const sid = parts[sidIdx].trim();
        const match = sid.match(/^([A-Z]{3}\d{5})/);
        if (match) candidate = match[1];
      }
      if (modulePattern.test(candidate)) {
        modules.add(candidate);
      }
    }
    return Array.from(modules).sort();
  } catch (err) {
    console.warn('Failed to read module list', err);
    return [];
  }
}

function serveStatic(req, res) {
  if (req.method !== 'GET') return false;
  const parsed = new URL(req.url, 'http://localhost');
  let pathname = path.normalize(parsed.pathname).replace(/^\/+/, '');
  if (pathname === 'student' || pathname === 'student/') {
    const filePath = path.join(PUBLIC_DIR, 'student', 'index.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname.startsWith('student')) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return false;
    try {
      const data = fs.readFileSync(filePath);
      let contentType = 'text/plain';
      if (filePath.endsWith('.html')) contentType = 'text/html';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.css')) contentType = 'text/css';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname === '' || pathname === 'index.html') {
    const filePath = path.join(__dirname, '..', 'index.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname === 'teacher' || pathname === 'teacher/' || pathname === 'teacher.html') {
    const filePath = path.join(__dirname, '..', 'teacher.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname === 'analysis' || pathname === 'analysis/' || pathname === 'analysis.html') {
    const filePath = path.join(__dirname, '..', 'analysis.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname === 'admin' || pathname === 'admin/' || pathname === 'admin.html') {
    const filePath = path.join(__dirname, '..', 'admin.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (serveStatic(req, res)) return;
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  try {
    if (pathname === '/api/modules' && req.method === 'GET') {
      const modules = readModuleListFromCsv();
      return sendJson(res, { modules });
    }

    if (pathname === '/api/intakes' && req.method === 'GET') {
      const config = readIntakesConfig();
      return sendJson(res, config);
    }

    if (pathname === '/api/attendance/years' && req.method === 'GET') {
      const years = listAvailableYears();
      const autoYear = getAcademicYear().label;
      const override = getActiveYearOverride();
      const active = getActiveYear();
      const files = years.map(y => ({ year: y, size: yearFileSize(y), rows: yearFileRowCount(y) }));
      return sendJson(res, { years, files, current: autoYear, active, override: override || null });
    }

    if (pathname === '/api/attendance' && req.method === 'GET') {
      const yearParam = parsed.searchParams.get('year') || getActiveYear();
      const yearRe = /^\d{4}-\d{2}$/;
      if (!yearRe.test(yearParam)) return sendJson(res, { error: 'Invalid year format' }, 400);
      const csvPath = csvPathForYear(yearParam);
      if (!fs.existsSync(csvPath)) {
        return sendJson(res, { error: 'No data for this academic year' }, 404);
      }
      const headers = {
        'Content-Type': 'text/csv',
        'Cache-Control': 'no-store'
      };
      if (process.env.ALLOW_CORS_ALL === '1') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      fs.createReadStream(csvPath).pipe(res);
      return;
    }

    if (pathname === '/api/attendance/active' && req.method === 'GET') {
      const override = getActiveYearOverride();
      const auto = getAcademicYear().label;
      return sendJson(res, { active: getActiveYear(), auto, override: override || null });
    }

    if (pathname === '/api/attendance/active' && req.method === 'PUT') {
      const body = await parseRequestBody(req);
      const yearLabel = body && body.year;
      if (!yearLabel) {
        clearActiveYearOverride();
        return sendJson(res, { ok: true, active: getAcademicYear().label, override: null });
      }
      if (!/^\d{4}-\d{2}$/.test(yearLabel)) return sendJson(res, { error: 'Invalid year format' }, 400);
      setActiveYearOverride(yearLabel);
      return sendJson(res, { ok: true, active: yearLabel, override: yearLabel });
    }

    if (pathname === '/api/attendance/create' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const yearLabel = body && body.year;
      if (!yearLabel || !/^\d{4}-\d{2}$/.test(yearLabel)) return sendJson(res, { error: 'Invalid year format (use YYYY-YY)' }, 400);
      const result = createYearFile(yearLabel);
      if (!result.ok) return sendJson(res, { error: result.error }, 409);
      return sendJson(res, { ok: true, year: yearLabel });
    }

    if (pathname === '/api/attendance/upload' && req.method === 'POST') {
      const yearParam = parsed.searchParams.get('year');
      if (!yearParam || !/^\d{4}-\d{2}$/.test(yearParam)) return sendJson(res, { error: 'Invalid year format' }, 400);
      return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 20e6) { req.connection.destroy(); resolve(); } });
        req.on('end', () => {
          try {
            const filePath = csvPathForYear(yearParam);
            fs.writeFileSync(filePath, body, 'utf8');
            sendJson(res, { ok: true, year: yearParam, bytes: Buffer.byteLength(body) });
          } catch (err) {
            console.error('Failed to write attendance file', err);
            sendJson(res, { error: 'Failed to save' }, 500);
          }
          resolve();
        });
      });
    }

    if (pathname === '/api/attendance' && req.method === 'DELETE') {
      const body = await parseRequestBody(req);
      const yearLabel = body && body.year;
      const password = body && body.password;
      if (!yearLabel || !/^\d{4}-\d{2}$/.test(yearLabel)) return sendJson(res, { error: 'Invalid year' }, 400);
      if (!password || password !== ADMIN_PASSWORD) return sendJson(res, { error: 'Invalid password' }, 403);
      const result = deleteYearFile(yearLabel);
      if (!result.ok) return sendJson(res, { error: result.error }, 404);
      return sendJson(res, { ok: true, year: yearLabel });
    }

    if (pathname === '/api/challenge' && req.method === 'GET') {
      const sid = parsed.searchParams.get('sid');
      const phase = normalizePhaseInput(parsed.searchParams.get('phase'));
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!VALID_PHASES.has(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      const { challenge, expiresAt, ttlMs } = issueChallenge(sid, phase);
      return sendJson(res, { challenge, expires_at_ms: expiresAt, ttl_ms: ttlMs || DEFAULT_TTL_MS });
    }

    if (pathname === '/api/validate-challenge' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase: rawPhase, challenge, page_session_id, device_id } = body;
      const phase = normalizePhaseInput(rawPhase);
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!VALID_PHASES.has(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      if (!challenge || typeof challenge !== 'string' || challenge.length > 128) {
        return sendJson(res, { error: 'Invalid challenge' }, 400);
      }
      const result = validateChallenge(sid, phase, challenge);
      if (!result.ok) {
        return sendJson(res, { error: 'Challenge expired' }, 400);
      }
      const connectionKey = page_session_id || '';
      const token = issueVerification(connectionKey);
      return sendJson(res, { verified: true, verification_id: token, sid, phase, device_id: device_id || '', ttl_ms: 300000 });
    }

    if (pathname === '/api/manual-override/check' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase: rawPhase, module: moduleCodeRaw, group: groupRaw, device_id: deviceIdRaw } = body;
      const phase = normalizePhaseInput(rawPhase);
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!VALID_PHASES.has(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      const moduleCode = (moduleCodeRaw || '').toString().trim().toUpperCase();
      const groupCode = (groupRaw || '').toString().trim();
      const moduleRe = /^[A-Z]{3}\d{5}$/;
      const groupRe = /^[0-9]$/;
      if (!moduleRe.test(moduleCode)) return sendJson(res, { error: 'Invalid module code' }, 400);
      if (!groupRe.test(groupCode)) return sendJson(res, { error: 'Invalid group number' }, 400);
      if (!deviceIdRaw || typeof deviceIdRaw !== 'string' || !deviceIdRaw.trim()) {
        return sendJson(res, { error: 'Invalid device information' }, 400);
      }
      const stableDeviceId = deviceIdRaw.trim();
      const deviceKey = buildDeviceKey({ sid, phase, deviceId: stableDeviceId, req });
      const lock = peekDeviceLock(deviceKey);
      if (lock) {
        return sendJson(res, { error: 'This device already completed a verification for another student recently.' }, 409);
      }
      return sendJson(res, { ok: true });
    }

    if (pathname === '/api/manual-override/complete' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase: rawPhase, module: moduleCodeRaw, group: groupRaw, device_id: deviceIdRaw, page_session_id, teacher_password } = body;
      const phase = normalizePhaseInput(rawPhase);
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!VALID_PHASES.has(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      const moduleCode = (moduleCodeRaw || '').toString().trim().toUpperCase();
      const groupCode = (groupRaw || '').toString().trim();
      const moduleRe = /^[A-Z]{3}\d{5}$/;
      const groupRe = /^[0-9]$/;
      if (!moduleRe.test(moduleCode)) return sendJson(res, { error: 'Invalid module code' }, 400);
      if (!groupRe.test(groupCode)) return sendJson(res, { error: 'Invalid group number' }, 400);
      if (!deviceIdRaw || typeof deviceIdRaw !== 'string' || !deviceIdRaw.trim()) {
        return sendJson(res, { error: 'Invalid device information' }, 400);
      }
      if (!MANUAL_OVERRIDE_PASSWORD_BUFFER) {
        return sendJson(res, { error: 'Manual override is not configured.' }, 503);
      }
      const rateLimitKey = deviceIdRaw.trim();
      if (!checkOverrideRateLimit(rateLimitKey)) {
        return sendJson(res, { error: 'Too many failed attempts from this device. Please wait 15 minutes before trying again.' }, 429);
      }
      const passwordCandidate = (teacher_password || '').toString();
      if (!passwordCandidate) {
        return sendJson(res, { error: 'Manual override password required.' }, 400);
      }
      if (!verifyManualOverridePassword(passwordCandidate)) {
        recordOverrideFailure(rateLimitKey);
        return sendJson(res, { error: 'Manual override password is incorrect.' }, 403);
      }
      resetOverrideFailures(rateLimitKey);
      const stableDeviceId = deviceIdRaw.trim();
      const deviceKey = buildDeviceKey({ sid, phase, deviceId: stableDeviceId, req });
      const lock = peekDeviceLock(deviceKey);
      if (lock) {
        return sendJson(res, { error: 'This device already completed a verification for another student recently.' }, 409);
      }
      const connectionKey = page_session_id || '';
      const token = issueVerification(connectionKey);
      registerManualOverride(token, {
        sid,
        phase,
        module: moduleCode,
        group: groupCode,
        deviceId: stableDeviceId,
        passwordVersion: MANUAL_OVERRIDE_PASSWORD_VERSION || 'unversioned',
      });
      return sendJson(res, { verified: true, verification_id: token, ttl_ms: 300000 });
    }

    if (pathname === '/api/checkin' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase: rawPhase, student_id, verification_id, page_session_id, device_id, module: moduleCodeRaw, group: groupRaw, intake: intakeRaw } = body;
      const phase = normalizePhaseInput(rawPhase);
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!VALID_PHASES.has(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      if (!student_id || !/^[0-9]{6,12}$/.test(student_id)) return sendJson(res, { error: 'Invalid student_id' }, 400);
      if (!verification_id) return sendJson(res, { error: 'Verification required' }, 400);
      const moduleCode = (moduleCodeRaw || '').toString().trim().toUpperCase();
      const groupCode = (groupRaw || '').toString().trim();
      const intake = (intakeRaw || '').toString().trim();
      const moduleRe = /^[A-Z]{3}\d{5}$/;
      const groupRe = /^[0-9]$/;
      if (!moduleRe.test(moduleCode)) return sendJson(res, { error: 'Invalid module code' }, 400);
      if (!groupRe.test(groupCode)) return sendJson(res, { error: 'Invalid group number' }, 400);
      const connectionKey = page_session_id || '';
      if (!consumeVerification(verification_id, connectionKey)) {
        return sendJson(res, { error: 'Verification required' }, 400);
      }
      const manualOverrideMeta = consumeManualOverride(verification_id);
      if (!canCheckin(connectionKey)) {
        return sendJson(res, { error: `Duplicate submission too soon (wait ${CHECKIN_WINDOW_MS}ms)` }, 429);
      }
      const stableDeviceId = (device_id || '').toString().trim();
      const deviceKey = buildDeviceKey({ sid, phase, deviceId: stableDeviceId, req });
      const lock = acquireDeviceLock(deviceKey, student_id);
      if (!lock.ok) {
        logAnomaly({ type: 'device_lock_conflict', deviceKey, student_id, existingStudentId: lock.existingStudentId, sid, phase });
        return sendJson(res, { error: 'This device has already been used for submitting a student ID in this verification session.' }, 409);
      }
      const tsUtc = new Date().toISOString();
      const ua = req.headers['user-agent'] || '';
      await appendCsvRow([tsUtc, moduleCode, `Group ${groupCode}`, intake, sid, phase, student_id, '', ua]);
      if (manualOverrideMeta) {
        logManualOverrideUsage({
          ...manualOverrideMeta,
          studentId: student_id,
          verificationId: verification_id,
        });
      }
      return sendJson(res, { ok: true });
    }

    if (pathname === '/api/csv/current' && req.method === 'GET') {
      const csvPath = currentCsvPath();
      if (!fs.existsSync(csvPath)) {
        return sendJson(res, { error: 'CSV not found' }, 404);
      }
      const headers = {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${path.basename(csvPath)}"`
      };
      if (process.env.ALLOW_CORS_ALL === '1') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      fs.createReadStream(csvPath).pipe(res);
      return;
    }

    if (pathname === '/api/intakes' && req.method === 'PUT') {
      const body = await parseRequestBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, { error: 'Invalid payload' }, 400);
      try {
        fs.writeFileSync(INTAKES_PATH, JSON.stringify(body, null, 2), 'utf8');
        return sendJson(res, { ok: true });
      } catch (err) {
        console.error('Failed to write intakes', err);
        return sendJson(res, { error: 'Failed to save' }, 500);
      }
    }

    if (pathname === '/api/roster' && req.method === 'GET') {
      if (!fs.existsSync(ROSTER_PATH)) return sendJson(res, { error: 'No roster' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Cache-Control': 'no-store' });
      fs.createReadStream(ROSTER_PATH).pipe(res);
      return;
    }

    if (pathname === '/api/roster' && req.method === 'POST') {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 5e6) { req.connection.destroy(); resolve(); } });
        req.on('end', () => {
          try {
            fs.writeFileSync(ROSTER_PATH, body, 'utf8');
            sendJson(res, { ok: true, bytes: Buffer.byteLength(body) });
          } catch (err) {
            console.error('Failed to write roster', err);
            sendJson(res, { error: 'Failed to save roster' }, 500);
          }
          resolve();
        });
      });
    }

    if (pathname === '/api/roster' && req.method === 'DELETE') {
      try {
        if (fs.existsSync(ROSTER_PATH)) fs.unlinkSync(ROSTER_PATH);
        return sendJson(res, { ok: true });
      } catch (err) {
        return sendJson(res, { error: 'Failed to delete' }, 500);
      }
    }

    if (pathname === '/api/under18' && req.method === 'GET') {
      if (!fs.existsSync(UNDER18_PATH)) return sendJson(res, { error: 'No under-18 list' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Cache-Control': 'no-store' });
      fs.createReadStream(UNDER18_PATH).pipe(res);
      return;
    }

    if (pathname === '/api/under18' && req.method === 'POST') {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 2e6) { req.connection.destroy(); resolve(); } });
        req.on('end', () => {
          try {
            fs.writeFileSync(UNDER18_PATH, body, 'utf8');
            sendJson(res, { ok: true, bytes: Buffer.byteLength(body) });
          } catch (err) {
            console.error('Failed to write under-18 list', err);
            sendJson(res, { error: 'Failed to save' }, 500);
          }
          resolve();
        });
      });
    }

    if (pathname === '/api/under18' && req.method === 'DELETE') {
      try {
        if (fs.existsSync(UNDER18_PATH)) fs.unlinkSync(UNDER18_PATH);
        return sendJson(res, { ok: true });
      } catch (err) {
        return sendJson(res, { error: 'Failed to delete' }, 500);
      }
    }

    if (pathname === '/health') {
      return sendJson(res, { ok: true });
    }

    return sendJson(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: 'Server error' }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = server;
