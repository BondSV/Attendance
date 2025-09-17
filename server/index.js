const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { hash32, validateBits } = require('./validator');
const { issueVerification, consumeVerification, acquireDeviceLock } = require('./memoryState');
const { appendCsvRow } = require('./csvWriter');

// Configuration
const PORT = process.env.PORT || 8080;
// Directory containing static assets for the student UI
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Utility to send a JSON response. Handles common headers and stringifies
 * the payload. If statusCode is omitted, defaults to 200.
 */
function sendJson(res, payload, statusCode = 200) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
  });
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
  // Only serve under 'student'
  if (!pathname.startsWith('student')) return false;
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendJson(res, { error: 'Not found' }, 404);
    }
    // Infer content type
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
      if (!sid || !phase || typeof seed !== 'number' || !Array.isArray(bits)) {
        return sendJson(res, { error: 'Invalid payload' }, 400);
      }
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase, page_session_id || ''].join('|');
      // Validate bits using server time
      const ok = validateBits(bits, seed, delta || 300);
      if (!ok) {
        return sendJson(res, { verified: false, matched: 0 });
      }
      // Issue verification token
      const token = issueVerification(connectionKey);
      return sendJson(res, { verified: true, verification_id: token });
    }
    if (pathname === '/api/checkin' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const { sid, phase, student_id, verification_id } = body;
      if (!sid || !phase || !student_id || !verification_id) {
        return sendJson(res, { error: 'Invalid payload' }, 400);
      }
      const connectionKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase, ''].join('|');
      // Consume token
      const ok = consumeVerification(verification_id, connectionKey);
      if (!ok) {
        return sendJson(res, { error: 'Verification required' }, 400);
      }
      // Acquire device lock
      const deviceKey = [req.socket.remoteAddress, req.headers['user-agent'], sid, phase].join('|');
      const lockOk = acquireDeviceLock(deviceKey, student_id);
      if (!lockOk) {
        // Still accept submission, but flag in response
        // Do not reject; but include warning
      }
      // Log to CSV
      const tsUtc = new Date().toISOString();
      const ua = uaShort(req.headers['user-agent']);
      await appendCsvRow([tsUtc, sid, phase, student_id, req.socket.remoteAddress, ua]);
      return sendJson(res, { ok: true, warning: lockOk ? undefined : 'Device used for multiple students' });
    }
    // Health check or not found
    if (pathname === '/health') {
      return sendJson(res, { ok: true });
    }
    return sendJson(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: 'Server error' }, 500);
  }
});

// Start server if this module is executed directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = server;