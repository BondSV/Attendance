(() => {
  // Helper to decode base64url to JSON
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

  // Parse payload from URL fragment
  const fragment = window.location.hash.substring(1);
  const payload = decodePayload(fragment);
  if (!payload) {
    document.getElementById('status').textContent = 'Invalid QR payload.';
    return;
  }
  const { sid, p: phase, d: delta = 300, sd: seed } = payload;
  if (!sid || !phase || typeof seed !== 'number') {
    document.getElementById('status').textContent = 'Missing parameters.';
    return;
  }

  // Generate a page_session_id to bind WS/init -> checkin
  function generatePageSessionId() {
    // RFC4122-style simple random UUID v4 (not cryptographically strong here)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  const pageSessionId = generatePageSessionId();

  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const statusEl = document.getElementById('status');
  const debugEl = document.getElementById('debug');
  const idForm = document.getElementById('id-form');
  const idInput = document.getElementById('student-id');
  const submitBtn = document.getElementById('submit-btn');
  let verificationId = null;
  let ws = null;
  let useWebSocket = false;
  let captureLoopActive = false;
  const flipToggle = document.getElementById('flip-toggle');
  const progressCanvas = document.getElementById('progress-ring');
  const progressText = document.getElementById('progress-text');
  const progressCtx = progressCanvas.getContext('2d');
  const fullframeToggle = document.getElementById('fullframe-toggle');
  const downloadBtn = document.getElementById('download-log');
  const clearLogBtn = document.getElementById('clear-log');
  const debugRows = [];
  let serverOffsetMs = 0;

  // Start camera with mobile-friendly constraints and request continuous focus
  navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      focusMode: 'continuous',
      advanced: [{ focusMode: 'continuous' }]
    },
    audio: false
  })
  .then((stream) => {
    video.srcObject = stream;
    // Try to enforce continuous autofocus if supported
    const track = stream.getVideoTracks && stream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      const constraints = {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        constraints.advanced = [{ focusMode: 'continuous' }];
      }
      if (caps.zoom && typeof caps.zoom.max === 'number') {
        // Slight zoom helps some phones focus on the sign region
        const midZoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, (caps.zoom.max || 2) * 0.3));
        (constraints.advanced || (constraints.advanced = [])).push({ zoom: midZoom });
      }
      if (Object.keys(constraints).length) {
        try { track.applyConstraints(constraints); } catch (e) {}
      }
    }
  })
  .catch((err) => {
    console.error('Camera error', err);
    statusEl.textContent = 'Unable to access camera.';
  });

  // Sync to server time to align sampling to bit boundaries
  async function syncServerTime() {
    try {
      const r = await fetch('/api/time');
      const j = await r.json();
      serverOffsetMs = j.now_ms - Date.now();
    } catch (e) {
      serverOffsetMs = 0;
    }
  }
  syncServerTime();

  /**
   * Sample the ROI for a single bit. The ROI is defined relative to the
   * overlay canvas: we choose the top right quadrant (x 0.5..0.9, y 0.1..0.4).
   * Within the ROI, we compute the average luminance of the left and
   * right halves. If right > left, bit = 1; else 0.
   */
  function sampleBit() {
    // Ensure overlay size matches video element size
    const vw = video.clientWidth || overlay.width || 320;
    const vh = video.clientHeight || overlay.height || 240;
    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
    }
    const w = overlay.width;
    const h = overlay.height;
    // ROI selection. If fullframe is enabled, use entire frame; otherwise use a centered region.
    let roiX, roiY, roiW, roiH;
    if (fullframeToggle && fullframeToggle.checked) {
      roiX = 0; roiY = 0; roiW = w; roiH = h;
    } else {
      roiW = Math.floor(w * 0.5);
      roiH = Math.floor(h * 0.4);
      roiX = Math.floor((w - roiW) / 2);
      roiY = Math.floor((h - roiH) / 2);
    }
    // Draw current video frame to overlay
    if (flipToggle && flipToggle.checked) {
      // Flip horizontally
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -w, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }
    // Visualize ROI
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(roiX, roiY, roiW, roiH);
    // Extract left and right halves
    const halfW = roiW / 2;
    const leftData = ctx.getImageData(roiX, roiY, halfW, roiH).data;
    const rightData = ctx.getImageData(roiX + halfW, roiY, halfW, roiH).data;
    const mean = (data) => {
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        // luminance (Rec. 709): 0.2126R + 0.7152G + 0.0722B
        const r = data[i], g = data[i + 1], b = data[i + 2];
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      return sum / (data.length / 4);
    };
    const leftAvg = mean(leftData);
    const rightAvg = mean(rightData);
    if (debugEl) debugEl.textContent = `L:${leftAvg.toFixed(1)} R:${rightAvg.toFixed(1)}`;
    return rightAvg > leftAvg ? 1 : 0;
  }

  /**
   * Capture a sequence of bits over a period and send to server for
   * validation. On success, reveals the ID form. On failure, prompts
   * retry.
   */
  async function captureAndValidate() {
    statusEl.textContent = 'Capturing…';
    const bits = [];
    const count = 12;
    // Align to server time bit boundary to reduce phase error
    const nowAdj = Date.now() + serverOffsetMs;
    const waitMs = delta - (nowAdj % delta);
    await new Promise((r) => setTimeout(r, waitMs));
    for (let i = 0; i < count; i++) {
      bits.push(sampleBit());
      drawProgress(i + 1, count);
      await new Promise((r) => setTimeout(r, delta));
    }
    statusEl.textContent = 'Validating…';
    // Prefer WebSocket validation when available
    if (useWebSocket && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'bits', bits }));
        // The WS handler will set verificationId on 'verified' message
        return;
      } catch (err) {
        console.error('WS send failed', err);
        // fall through to POST fallback
      }
    }

    // Fallback to POST /api/validate
    try {
      const resp = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, phase, seed, delta, bits, page_session_id: pageSessionId }),
      });
      const data = await resp.json();
      if (data.verified) {
        verificationId = data.verification_id;
        statusEl.textContent = 'Verified! Enter your ID.';
        idForm.classList.remove('hidden');
        // Stop capture loop on verified
        stopCaptureLoop();
      } else {
        // Show server progress details if provided
        const matched = typeof data.matched === 'number' ? data.matched : 0;
        const needed = typeof data.needed === 'number' ? data.needed : 12;
        const offset = typeof data.offset === 'number' ? data.offset : 0;
        statusEl.textContent = `Progress ${matched}/${needed} (offset ${offset})`;
        debugRows.push({ ts: Date.now(), type: 'post_progress', matched, needed, offset });
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Validation error.';
    }
  }

  function drawProgress(current, total) {
    const pct = current / total;
    const ctx = progressCtx;
    const w = progressCanvas.width;
    const h = progressCanvas.height;
    ctx.clearRect(0, 0, w, h);
    // background circle
    ctx.beginPath();
    ctx.arc(w/2, h/2, w/2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = '#eee';
    ctx.fill();
    // progress arc
    ctx.beginPath();
    ctx.moveTo(w/2, h/2);
    ctx.fillStyle = '#4caf50';
    ctx.arc(w/2, h/2, w/2 - 4, -Math.PI/2, -Math.PI/2 + pct * Math.PI * 2);
    ctx.lineTo(w/2, h/2);
    ctx.fill();
    progressText.textContent = `${current}/${total}`;
  }

  // Capture loop control
  function startCaptureLoop() {
    if (captureLoopActive) return;
    captureLoopActive = true;
    (async function loop() {
      // small initial delay for auto-exposure
      await new Promise((r) => setTimeout(r, 500));
      while (captureLoopActive && !verificationId) {
        try {
          await captureAndValidate();
        } catch (e) {
          console.error('capture error', e);
        }
        // brief pause between attempts to avoid tight looping
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  }

  function stopCaptureLoop() {
    captureLoopActive = false;
  }

  // Kick off capture loop after video is ready
  video.addEventListener('playing', () => {
    startCaptureLoop();
  });

  // Try to open WebSocket connection for live validation
  try {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/validate');
    ws.addEventListener('open', () => {
      useWebSocket = true;
      // Send init
      ws.send(JSON.stringify({ type: 'init', sid, phase, delta, seed, page_session_id: pageSessionId }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'init_ack') return;
        if (msg.type === 'progress') {
          const matched = typeof msg.matched === 'number' ? msg.matched : 0;
          const needed = typeof msg.needed === 'number' ? msg.needed : 12;
          const offset = typeof msg.offset === 'number' ? msg.offset : 0;
          statusEl.textContent = `Progress ${matched}/${needed} (offset ${offset})`;
          debugRows.push({ ts: Date.now(), type: 'ws_progress', matched, needed, offset });
          if (debugEl) debugEl.textContent += `  off:${offset}`;
        }
        if (msg.type === 'verified') {
          verificationId = msg.verification_id;
          statusEl.textContent = 'Verified! Enter your ID.';
          idForm.classList.remove('hidden');
          // Stop capture loop on verified
          stopCaptureLoop();
        }
      } catch (err) { console.error(err); }
    });
    ws.addEventListener('close', () => { useWebSocket = false; });
    ws.addEventListener('error', () => { useWebSocket = false; });
  } catch (err) {
    console.warn('WebSocket not available, falling back to POST');
  }

  // Handle submit
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
    body: JSON.stringify({ sid, phase, student_id: studentId, verification_id: verificationId, page_session_id: pageSessionId }),
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

  // Download debug log as CSV
  function downloadCsv(rows) {
    const header = 'ts,source,matched,needed,offset\n';
    const body = rows.map(r => `${new Date(r.ts).toISOString()},${r.type},${r.matched},${r.needed},${r.offset}`).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'debug_log.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => downloadCsv(debugRows));
  }
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => { debugRows.length = 0; if (debugEl) debugEl.textContent = ''; });
  }
})();