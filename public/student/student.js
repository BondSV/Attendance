(() => {
  function decodePayload(hash) {
    if (!hash) return null;
    try {
      const base64 = hash.replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = atob(base64);
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error('Failed to decode payload', err);
      return null;
    }
  }

  const fragment = window.location.hash.substring(1);
  const payload = decodePayload(fragment);
  const statusEl = document.getElementById('status');
  if (!payload || !payload.sid) {
    statusEl.textContent = 'Invalid QR payload.';
    return;
  }

  const sid = payload.sid;
  const phase = payload.p || payload.phase || 'start';

  function generatePageSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'ps-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
  const pageSessionId = generatePageSessionId();

  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const debugEl = document.getElementById('debug');
  const cameraWrapper = document.getElementById('camera-wrapper');
  const fullframeToggle = document.getElementById('fullframe-toggle');
  const refocusBtn = document.getElementById('refocus-btn');
  const downloadBtn = document.getElementById('download-log');
  const clearLogBtn = document.getElementById('clear-log');
  const progressCanvas = document.getElementById('progress-ring');
  const progressCtx = progressCanvas.getContext('2d');
  const progressText = document.getElementById('progress-text');
  const idForm = document.getElementById('id-form');
  const idInput = document.getElementById('student-id');
  const submitBtn = document.getElementById('submit-btn');

  const debugRows = [];

  const MAX_ATTEMPTS = 12;
  const ATTEMPT_INTERVAL_MS = 700;
  const PIXEL_THRESHOLD = 180;
  const MIN_SCORE_THRESHOLD = 0.65;
  const DIGIT_WIDTH = 3;
  const DIGIT_HEIGHT = 5;
  const DIGIT_GAP = 1;
  const CODE_LAYOUT = ['digit', 'digit', 'colon', 'digit', 'digit', 'colon', 'digit', 'digit'];
  const DIGIT_CHARS = ['0','1','2','3','4','5','6','7','8','9'];
  const DIGIT_PATTERNS = {
    '0': [1,1,1, 1,0,1, 1,0,1, 1,0,1, 1,1,1],
    '1': [0,1,0, 1,1,0, 0,1,0, 0,1,0, 1,1,1],
    '2': [1,1,1, 0,0,1, 1,1,1, 1,0,0, 1,1,1],
    '3': [1,1,1, 0,0,1, 1,1,1, 0,0,1, 1,1,1],
    '4': [1,0,1, 1,0,1, 1,1,1, 0,0,1, 0,0,1],
    '5': [1,1,1, 1,0,0, 1,1,1, 0,0,1, 1,1,1],
    '6': [1,1,1, 1,0,0, 1,1,1, 1,0,1, 1,1,1],
    '7': [1,1,1, 0,0,1, 0,1,0, 1,0,0, 1,0,0],
    '8': [1,1,1, 1,0,1, 1,1,1, 1,0,1, 1,1,1],
    '9': [1,1,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1],
    ':': [0,0,0, 0,1,0, 0,0,0, 0,1,0, 0,0,0],
  };

  let verificationId = null;
  let captureLoopActive = false;
  let attemptCount = 0;
  let serverOffsetMs = 0;

  function logDebug(entry) {
    debugRows.push({ ts: Date.now(), ...entry });
  }

  function drawProgress(current, total) {
    const w = progressCanvas.width;
    const h = progressCanvas.height;
    progressCtx.clearRect(0, 0, w, h);
    progressCtx.beginPath();
    progressCtx.arc(w / 2, h / 2, w / 2 - 4, 0, Math.PI * 2);
    progressCtx.fillStyle = '#202020';
    progressCtx.fill();
    const segments = total;
    const anglePer = (Math.PI * 2) / segments;
    for (let i = 0; i < segments; i++) {
      const start = -Math.PI / 2 + i * anglePer;
      const end = start + anglePer;
      progressCtx.beginPath();
      progressCtx.moveTo(w / 2, h / 2);
      progressCtx.arc(w / 2, h / 2, w / 2 - 4, start, end);
      progressCtx.closePath();
      progressCtx.fillStyle = i < current ? '#2ECC71' : '#E74C3C';
      progressCtx.fill();
    }
    progressCtx.beginPath();
    progressCtx.arc(w / 2, h / 2, (w / 2 - 4) * 0.6, 0, Math.PI * 2);
    progressCtx.fillStyle = '#111';
    progressCtx.fill();
    progressText.textContent = `${current}/${total}`;
  }

  function ensureOverlaySize() {
    const wrapperW = cameraWrapper ? cameraWrapper.clientWidth : 0;
    const wrapperH = cameraWrapper ? cameraWrapper.clientHeight : 0;
    const vw = video.clientWidth || wrapperW || overlay.width || 320;
    const vh = video.clientHeight || wrapperH || overlay.height || 240;
    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
    }
  }

  function sampleCode() {
    ensureOverlaySize();
    const w = overlay.width;
    const h = overlay.height;
    ctx.drawImage(video, 0, 0, w, h);

    const cell = Math.max(2, Math.floor(Math.min(w, h) / 12));
    const charPixelWidth = DIGIT_WIDTH * cell;
    const charGap = DIGIT_GAP * cell;
    const totalWidth = CODE_LAYOUT.length * charPixelWidth + (CODE_LAYOUT.length - 1) * charGap;
    const startX = Math.max(0, Math.floor((w - totalWidth) / 2));
    const startY = Math.max(0, Math.floor((h - DIGIT_HEIGHT * cell) / 2));

    let code = '';
    const scores = [];

    for (let index = 0; index < CODE_LAYOUT.length; index++) {
      const allowedChars = CODE_LAYOUT[index] === 'colon' ? [':'] : DIGIT_CHARS;
      const pattern = [];
      const baseX = startX + index * (charPixelWidth + charGap);
      for (let row = 0; row < DIGIT_HEIGHT; row++) {
        for (let col = 0; col < DIGIT_WIDTH; col++) {
          const sampleX = baseX + col * cell;
          const sampleY = startY + row * cell;
          const data = ctx.getImageData(sampleX, sampleY, cell, cell).data;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sum += luminance;
          }
          const avg = sum / (data.length / 4);
          pattern.push(avg > PIXEL_THRESHOLD ? 1 : 0);
        }
      }

      let bestChar = '?';
      let bestScore = -Infinity;
      const templateLength = DIGIT_PATTERNS['0'].length;
      allowedChars.forEach((char) => {
        const template = DIGIT_PATTERNS[char];
        let score = 0;
        for (let i = 0; i < templateLength; i++) {
          if (template[i] === pattern[i]) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestChar = char;
        }
      });

      code += bestChar;
      scores.push(bestScore / DIGIT_PATTERNS['0'].length);
    }

    const avgScore = scores.reduce((acc, val) => acc + val, 0) / scores.length;
    const minScore = Math.min(...scores);

    return { code, scores, avgScore, minScore };
  }

  async function syncServerState() {
    try {
      const resp = await fetch('/api/time');
      if (!resp.ok) return;
      const data = await resp.json();
      serverOffsetMs = data.now_ms - Date.now();
    } catch (err) {
      console.warn('Failed to sync time', err);
    }
  }

  async function attemptVerification() {
    if (verificationId) return;
    attemptCount += 1;
    drawProgress(Math.min(attemptCount, MAX_ATTEMPTS), MAX_ATTEMPTS);

    const sample = sampleCode();
    const region = fullframeToggle && fullframeToggle.checked ? 'full' : 'center';
    logDebug({ type: 'capture', code: sample.code, avgScore: sample.avgScore, minScore: sample.minScore, scores: sample.scores.join('|'), region });

    if (debugEl) {
      debugEl.textContent = `Code ${sample.code} | avg ${sample.avgScore.toFixed(2)} | min ${sample.minScore.toFixed(2)}`;
    }

    if (sample.code.includes('?') || sample.minScore < MIN_SCORE_THRESHOLD) {
      statusEl.textContent = 'Display not clear. Hold steady…';
      return;
    }

    statusEl.textContent = `Validating ${sample.code}…`;
    try {
      const resp = await fetch('/api/validate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, phase, code: sample.code, page_session_id: pageSessionId })
      });
      const data = await resp.json();
      if (resp.ok && data.verified) {
        verificationId = data.verification_id;
        statusEl.textContent = 'Verified! Enter your ID.';
        idForm.classList.remove('hidden');
        drawProgress(MAX_ATTEMPTS, MAX_ATTEMPTS);
        logDebug({ type: 'verified', code: sample.code });
        stopCaptureLoop();
      } else {
        const expected = data.expected_code || '';
        statusEl.textContent = data.error || (expected ? `Code mismatch (expected ${expected})` : 'Code mismatch. Hold steady…');
        logDebug({ type: 'server_fail', code: sample.code, expected, error: data.error || 'code_mismatch' });
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Validation error.';
      logDebug({ type: 'error', code: sample.code, message: err.message });
    }
  }

  function startCaptureLoop() {
    if (captureLoopActive || verificationId) return;
    captureLoopActive = true;
    attemptCount = 0;
    drawProgress(0, MAX_ATTEMPTS);
    const loop = async () => {
      if (!captureLoopActive || verificationId) return;
      await attemptVerification();
      if (!verificationId && captureLoopActive) {
        setTimeout(loop, ATTEMPT_INTERVAL_MS);
      }
    };
    loop();
  }

  function stopCaptureLoop() {
    captureLoopActive = false;
  }

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, focusMode: 'continuous', advanced: [{ focusMode: 'continuous' }] },
    audio: false
  }).then((stream) => {
    video.srcObject = stream;
  }).catch((err) => {
    console.error('Camera error', err);
    statusEl.textContent = 'Unable to access camera.';
  });

  video.addEventListener('playing', () => {
    drawProgress(0, MAX_ATTEMPTS);
    startCaptureLoop();
  });

  if (refocusBtn) {
    refocusBtn.addEventListener('click', () => {
      const stream = video.srcObject;
      if (!stream) return;
      const track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (track && track.applyConstraints) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous', focusDistance: 'near' }] }).catch(() => {
          console.warn('Refocus not supported');
        });
      }
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const header = 'ts,type,code,avgScore,minScore,scores,region,error,expected\n';
      const body = debugRows.map((row) => [
        new Date(row.ts).toISOString(),
        row.type,
        row.code || '',
        row.avgScore ?? '',
        row.minScore ?? '',
        row.scores || '',
        row.region || '',
        row.error || '',
        row.expected || ''
      ].join(',')).join('\n');
      const blob = new Blob([header + body], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'debug_log.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      debugRows.length = 0;
      if (debugEl) debugEl.textContent = '';
    });
  }

  submitBtn.addEventListener('click', async () => {
    const studentId = idInput.value.trim();
    if (!studentId) {
      statusEl.textContent = 'Please enter your Student ID.';
      return;
    }
    if (!verificationId) {
      statusEl.textContent = 'Not verified yet.';
      return;
    }
    statusEl.textContent = 'Submitting…';
    try {
      const resp = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, phase, student_id: studentId, verification_id: verificationId, page_session_id: pageSessionId })
      });
      const data = await resp.json();
      if (data.ok) {
        statusEl.textContent = 'Thank you! Your attendance has been recorded.';
        idForm.classList.add('hidden');
      } else {
        statusEl.textContent = data.error || 'Submission failed.';
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Submission error.';
    }
  });

  syncServerState();
  setInterval(syncServerState, 15000);
})();