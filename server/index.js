const http = require('http');
const fs = require('fs');
const path = require('path');

const { issueVerification, consumeVerification, acquireDeviceLock } = require('./memoryState');
const { appendCsvRow } = require('./csvWriter');
const { getSalts, validateCode } = require('./salt');
const { canCheckin, CHECKIN_WINDOW_MS } = require('./checkins');

const PORT = process.env.PORT || 8080;
const ANOMALY_LOG_PATH = process.env.ANOMALY_LOG_PATH || null;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, payload, status = 200) {
  const data = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
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

function serveStatic(req, res) {
  if (req.method !== 'GET') return false;
  const parsed = new URL(req.url, 'http://localhost');
  let pathname = path.normalize(parsed.pathname).replace(/^\/+/,'');
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
  if (pathname === '' || pathname === 'teacher.html') {
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
  return false;
}

function validateCodePayload(body) {
  const { sid, phase, code } = body;
  const sidRe = /^[A-Za-z0-9\-_:]{3,80}$/;
  if (!sid || !sidRe.test(sid)) return 'Invalid sid';
  if (!['start', 'break', 'end'].includes(phase)) return 'Invalid phase';
  if (typeof code !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(code)) return 'Invalid code format';
  return null;
}

const server = http.createServer(async (req, res) => {
  if (serveStatic(req, res)) return;
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  try {
    if (pathname === '/api/time' && req.method === 'GET') {
      const salts = getSalts();
      return sendJson(res, {
        now_ms: Date.now(),
        salt: salts.current.value,
        salt_expires_ms: salts.current.expiresAt,
        rotation_ms: salts.rotationMs,
        accept_window_ms: salts.acceptWindowMs,
      });
    }

    if (pathname === '/api/validate-code' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const error = validateCodePayload(body);
      if (error) return sendJson(res, { error }, 400);
      const result = validateCode(body.code);
      if (!result.ok) {
        const reason = result.reason === 'time' ? 'Code out of time window' : result.reason === 'salt' ? 'Salt expired' : 'Invalid code';
        return sendJson(res, { error: reason, expected_code: result.expected }, 400);
      }
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], body.sid, body.phase, body.page_session_id || ''].join('|');
      const token = issueVerification(connectionKey);
      return sendJson(res, { verified: true, verification_id: token });
    }

    if (pathname === '/api/checkin' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, student_id, verification_id, page_session_id } = body;
      const sidRe = /^[A-Za-z0-9\-_:]{3,80}$/;
      if (!sid || !sidRe.test(sid)) return sendJson(res, { error: 'Invalid sid' }, 400);
      if (!['start', 'break', 'end'].includes(phase)) return sendJson(res, { error: 'Invalid phase' }, 400);
      if (!student_id || !/^[0-9]{6,12}$/.test(student_id)) return sendJson(res, { error: 'Invalid student_id' }, 400);
      if (!verification_id) return sendJson(res, { error: 'Verification required' }, 400);
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase, page_session_id || ''].join('|');
      if (!consumeVerification(verification_id, connectionKey)) {
        return sendJson(res, { error: 'Verification required' }, 400);
      }
      if (!canCheckin(connectionKey)) {
        return sendJson(res, { error: `Duplicate submission too soon (wait ${CHECKIN_WINDOW_MS}ms)` }, 429);
      }
      const deviceKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase].join('|');
      const lock = acquireDeviceLock(deviceKey, student_id);
      if (!lock.ok) {
        logAnomaly({ type: 'device_lock_conflict', deviceKey, student_id, existingStudentId: lock.existingStudentId, sid, phase, ip: req.socket.remoteAddress });
      }
      const tsUtc = new Date().toISOString();
      const ua = req.headers['user-agent'] || '';
      await appendCsvRow([tsUtc, sid, phase, student_id, req.socket.remoteAddress, ua]);
      return sendJson(res, { ok: true, warning: lock.ok ? undefined : 'Device used for multiple students' });
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