const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');

const { hash32, validateBits } = require('./validator');
const { issueVerification, consumeVerification, acquireDeviceLock } = require('./memoryState');
const { appendCsvRow } = require('./csvWriter');

// Configuration
const PORT = process.env.PORT || 8080;
const CHECKIN_PER_MIN = parseInt(process.env.CHECKIN_PER_MIN || '10', 10);
const WS_MAX_PER_IP = parseInt(process.env.WS_MAX_PER_IP || '2', 10);
const WS_IDLE_TIMEOUT_MS = parseInt(process.env.WS_IDLE_TIMEOUT_MS || '20000', 10);
const ANOMALY_LOG_PATH = process.env.ANOMALY_LOG_PATH || null; // optional file path
// Directory containing static assets for the student UI
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Utility to send a JSON response. Handles common headers and stringifies
 * the payload. If statusCode is omitted, defaults to 200.
 */
function sendJson(res, payload, statusCode = 200) {
  const data = JSON.stringify(payload);
  // Restrict CORS to same origin in production; for local testing allow all
  const corsOrigin = process.env.ALLOW_CORS_ALL === '1' ? '*' : (res && res.getHeader && res.getHeader('origin')) || undefined;
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  res.writeHead(statusCode, headers);
  res.end(data);
}

/**
 * Read and parse the body of an incoming request. Supports JSON only.
 * Returns a promise that resolves with the parsed object or rejects
 * on error.
 */
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Protect against large payloads
      if (body.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const obj = body ? JSON.parse(body) : {};
        resolve(obj);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Simple anomaly logger (console + optional file)
function logAnomaly(obj) {
  const msg = `[ANOMALY] ${new Date().toISOString()} ${JSON.stringify(obj)}`;
  console.warn(msg);
  if (ANOMALY_LOG_PATH) {
    try { fs.appendFileSync(ANOMALY_LOG_PATH, msg + '\n'); } catch (e) { /* ignore */ }
  }
}

/**
 * Map certain user agent substrings to a shorter, normalised identifier.
 * This is used in the CSV log to avoid storing full user agent strings.
 */
function uaShort(ua) {
  if (!ua) return 'unknown';
  ua = ua.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os')) return 'macos';
  return ua.split(' ')[0];
}

/**
 * Serve static files from the public directory. Only allow files
 * within PUBLIC_DIR to be served. Returns true if a file was
 * successfully served, false otherwise.
 */
function serveStatic(req, res) {
  // Only handle GET requests
  if (req.method !== 'GET') return false;
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname;
  // Normalize and prevent directory traversal
  pathname = path.normalize(pathname).replace(/^\/+/, '');
  // Special-case: /student should serve the student index
  if (pathname === 'student' || pathname === 'student/') {
    const filePathIndex = path.join(PUBLIC_DIR, 'student', 'index.html');
    try {
      const data = fs.readFileSync(filePathIndex);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
      return true;
    } catch (e) {
      return false;
    }
  }
  // Serve student static files under public/student
  if (pathname.startsWith('student')) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return false;
    fs.readFile(filePath, (err, data) => {
      if (err) return sendJson(res, { error: 'Not found' }, 404);
      let contentType = 'text/plain';
      if (filePath.endsWith('.html')) contentType = 'text/html';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.css')) contentType = 'text/css';
      else if (filePath.endsWith('.png')) contentType = 'image/png';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return true;
  }

  // Serve teacher.html from repo root at '/teacher.html' or '/'
  if (pathname === '' || pathname === 'teacher.html') {
    const filePath = path.join(__dirname, '..', 'teacher.html');
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
      return true;
    } catch (err) {
      return false;
    }
  }
  return false;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Handle static assets first
  if (serveStatic(req, res)) {
    return;
  }
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;
  try {
    if (pathname === '/api/time' && req.method === 'GET') {
      return sendJson(res, { now_ms: Date.now() });
    }
    if (pathname === '/api/validate' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, seed, delta, bits, page_session_id } = body;
      // Input validation per spec
      const sidRe = /^[A-Za-z0-9\-_:]{3,80}$/;
      const phaseRe = /^(start|break|end)$/;
      const studentBitsOk = Array.isArray(bits) && bits.every(b => b === 0 || b === 1);
      if (!sid || !sidRe.test(sid) || !phase || !phaseRe.test(phase) || typeof seed !== 'number' || !studentBitsOk) {
        return sendJson(res, { error: 'Invalid payload' }, 400);
      }
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase, page_session_id || ''].join('|');
      // Validate bits using server time with tolerance per spec (>=10/12, small jitter)
      const vres = validateBits(bits, seed, delta || 300, { lenWindow: 4, threshold: 10 });
      if (!vres || !vres.ok) {
        // return progress info so client can show matched/needed/offset
        return sendJson(res, { verified: false, matched: vres ? vres.matched : 0, needed: vres ? vres.needed : bits.length, offset: vres ? vres.offset : 0 });
      }
      // Issue verification token
      const token = issueVerification(connectionKey);
      return sendJson(res, { verified: true, verification_id: token });
    }
    if (pathname === '/api/checkin' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, student_id, verification_id, page_session_id } = body;
      // Validate inputs per spec
      const sidRe = /^[A-Za-z0-9\-_:]{3,80}$/;
      const phaseRe = /^(start|break|end)$/;
      const studentIdRe = /^[0-9]{6,12}$/;
      if (!sid || !sidRe.test(sid) || !phase || !phaseRe.test(phase) || !student_id || !studentIdRe.test(student_id) || !verification_id) {
        return sendJson(res, { error: 'Invalid payload' }, 400);
      }
      // Build connection key using the same shape as /api/validate and WS init
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase, page_session_id || ''].join('|');
      // Consume token
      const ok = consumeVerification(verification_id, connectionKey);
      if (!ok) {
        return sendJson(res, { error: 'Verification required' }, 400);
      }
      // Acquire device lock
      const deviceKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase].join('|');
      const lock = acquireDeviceLock(deviceKey, student_id);
      if (!lock.ok) {
        // Log anomaly: device used for multiple students
        logAnomaly({ type: 'device_lock_conflict', deviceKey, student_id, existingStudentId: lock.existingStudentId, sid, phase, ip: req.socket.remoteAddress });
      }
      // Log to CSV
      const tsUtc = new Date().toISOString();
      const ua = uaShort(req.headers['user-agent']);
      await appendCsvRow([tsUtc, sid, phase, student_id, req.socket.remoteAddress, ua]);
      return sendJson(res, { ok: true, warning: lock.ok ? undefined : 'Device used for multiple students' });
    }
    // Health check or not found
    if (pathname === '/health') {
      return sendJson(res, { ok: true });
    }

    // Testing helper: stream the current UTC day's CSV
    if (pathname === '/api/csv/current' && req.method === 'GET') {
      const CSV_DIR = process.env.CSV_DIR || path.join(__dirname, '..', 'data');
      const date = new Date();
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const fileName = `${yyyy}-${mm}-${dd}.csv`;
      const filePath = path.join(CSV_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        return sendJson(res, { error: 'CSV not found' }, 404);
      }
      const headers = { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${fileName}"` };
      if (process.env.ALLOW_CORS_ALL === '1') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    }

    return sendJson(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: 'Server error' }, 500);
  }
});

// Attach WebSocket server for live validation
const wss = new WebSocket.Server({ noServer: true });

// Simple per-socket state: awaiting init then bits messages
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let connectionKey = null;
  let pageSessionId = null;

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (err) { return; }
    if (data.type === 'init') {
      // Expect: { type: 'init', sid, phase, delta, seed, page_session_id }
      pageSessionId = data.page_session_id || '';
      connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], data.sid, data.phase, pageSessionId].join('|');
      ws._connectionKey = connectionKey;
      ws._sid = data.sid;
      ws._phase = data.phase;
      ws._delta = data.delta || 300;
      ws._seed = data.seed;
      ws.send(JSON.stringify({ type: 'init_ack' }));
      return;
    }
    if (data.type === 'bits') {
      if (!ws._seed || !ws._delta) return ws.send(JSON.stringify({ type: 'error', error: 'Not initialised' }));
      const vres = validateBits(data.bits, ws._seed, ws._delta, { lenWindow: 4, threshold: 10 });
      if (!vres || !vres.ok) {
        return ws.send(JSON.stringify({ type: 'progress', matched: vres ? vres.matched : 0, needed: vres ? vres.needed : 12, offset: vres ? vres.offset : 0 }));
      }
      // Issue verification token bound to the connectionKey
      const token = issueVerification(ws._connectionKey);
      ws.send(JSON.stringify({ type: 'verified', verification_id: token, ttl_ms: 30000 }));
    }
  });

  ws.on('close', () => {});
  // enforce idle timeout per socket
  ws._idleTimer = setTimeout(() => {
    try { ws.terminate(); } catch (e) {}
  }, WS_IDLE_TIMEOUT_MS);
  const refreshIdle = () => {
    if (ws._idleTimer) clearTimeout(ws._idleTimer);
    ws._idleTimer = setTimeout(() => { try { ws.terminate(); } catch (e) {} }, WS_IDLE_TIMEOUT_MS);
  };
  ws.on('message', refreshIdle);
  ws.on('pong', refreshIdle);
});

// Health-check for dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Upgrade HTTP server to handle WebSocket at /ws/validate
server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname === '/ws/validate') {
    // Enforce per-IP concurrent WS limit
    const ip = req.socket.remoteAddress || 'unknown';
    const count = Array.from(wss.clients).filter(c => c._remoteIp === ip).length;
    if (count >= WS_MAX_PER_IP) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._remoteIp = req.socket.remoteAddress;
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start server if this module is executed directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = server;