const http = require('http');
const fs = require('fs');
const path = require('path');

const { issueVerification, consumeVerification, acquireDeviceLock } = require('./memoryState');
const { appendCsvRow, CSV_PATH } = require('./csvWriter');
const { canCheckin, CHECKIN_WINDOW_MS } = require('./checkins');
const { issueChallenge, validateChallenge, DEFAULT_TTL_MS } = require('./challenges');

const PORT = process.env.PORT || 8080;
const ANOMALY_LOG_PATH = process.env.ANOMALY_LOG_PATH || null;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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
    try { fs.appendFileSync(ANOMALY_LOG_PATH, msg + '\n'); } catch (e) {}
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

function readModuleListFromCsv() {
  if (!fs.existsSync(CSV_PATH)) return [];
  try {
    const text = fs.readFileSync(CSV_PATH, 'utf8');
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
  if (pathname === 'analysis.html') {
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

    if (pathname === '/api/challenge' && req.method === 'GET') {
      const sid = parsed.searchParams.get('sid');
      const phase = parsed.searchParams.get('phase') || 'start';
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!['start', 'break', 'end'].includes(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      const { challenge, expiresAt, ttlMs } = issueChallenge(sid, phase);
      return sendJson(res, { challenge, expires_at_ms: expiresAt, ttl_ms: ttlMs || DEFAULT_TTL_MS });
    }

    if (pathname === '/api/validate-challenge' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, challenge, page_session_id, device_id } = body;
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!['start', 'break', 'end'].includes(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
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

    if (pathname === '/api/checkin' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, student_id, verification_id, page_session_id, device_id, module: moduleCodeRaw, group: groupRaw } = body;
      const sidRe = /^[A-Za-z0-9 _\-:.,]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!['start', 'break', 'end'].includes(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      if (!student_id || !/^[0-9]{6,12}$/.test(student_id)) return sendJson(res, { error: 'Invalid student_id' }, 400);
      if (!verification_id) return sendJson(res, { error: 'Verification required' }, 400);
      const moduleCode = (moduleCodeRaw || '').toString().trim().toUpperCase();
      const groupCode = (groupRaw || '').toString().trim();
      const moduleRe = /^[A-Z]{3}\d{5}$/;
      const groupRe = /^[0-9]$/;
      if (!moduleRe.test(moduleCode)) return sendJson(res, { error: 'Invalid module code' }, 400);
      if (!groupRe.test(groupCode)) return sendJson(res, { error: 'Invalid group number' }, 400);
      const connectionKey = page_session_id || '';
      if (!consumeVerification(verification_id, connectionKey)) {
        return sendJson(res, { error: 'Verification required' }, 400);
      }
      if (!canCheckin(connectionKey)) {
        return sendJson(res, { error: `Duplicate submission too soon (wait ${CHECKIN_WINDOW_MS}ms)` }, 429);
      }
      const stableDeviceId = device_id || (req.headers['user-agent'] || '');
      const deviceKey = [stableDeviceId].join('|');
      const lock = acquireDeviceLock(deviceKey, student_id);
      if (!lock.ok) {
        logAnomaly({ type: 'device_lock_conflict', deviceKey, student_id, existingStudentId: lock.existingStudentId, sid, phase });
        return sendJson(res, { error: 'This device has already been used for submitting a student ID in this verification session.' }, 409);
      }
      const tsUtc = new Date().toISOString();
      const ua = req.headers['user-agent'] || '';
      await appendCsvRow([tsUtc, moduleCode, `Group ${groupCode}`, sid, phase, student_id, '', ua]);
      return sendJson(res, { ok: true });
    }

    if (pathname === '/api/csv/current' && req.method === 'GET') {
      if (!fs.existsSync(CSV_PATH)) {
        return sendJson(res, { error: 'CSV not found' }, 404);
      }
      const headers = {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${path.basename(CSV_PATH)}"`
      };
      if (process.env.ALLOW_CORS_ALL === '1') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      fs.createReadStream(CSV_PATH).pipe(res);
      return;
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