const CHECKIN_WINDOW_MS = parseInt(process.env.CHECKIN_WINDOW_MS || '6000', 10);

const lastCheckins = new Map(); // key => timestamp

function canCheckin(key) {
  const now = Date.now();
  const last = lastCheckins.get(key) || 0;
  if (now - last < CHECKIN_WINDOW_MS) {
    return false;
  }
  lastCheckins.set(key, now);
  return true;
}

module.exports = { canCheckin, CHECKIN_WINDOW_MS };

