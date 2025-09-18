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

  // Start camera
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then((stream) => {
      video.srcObject = stream;
    })
    .catch((err) => {
      console.error('Camera error', err);
      statusEl.textContent = 'Unable to access camera.';
    });

  /**
   * Sample the ROI for a single bit. The ROI is defined relative to the
   * overlay canvas: we choose the top right quadrant (x 0.5..0.9, y 0.1..0.4).
   * Within the ROI, we compute the average luminance of the left and
   * right halves. If right > left, bit = 1; else 0.
   */
  function sampleBit() {
    const w = overlay.width;
    const h = overlay.height;
    const roiX = Math.floor(w * 0.5);
    const roiY = Math.floor(h * 0.15);
    const roiW = Math.floor(w * 0.4);
    const roiH = Math.floor(h * 0.3);
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
        // luminance: simple average of R,G,B
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      return sum / (data.length / 4);
    };
    const leftAvg = mean(leftData);
    const rightAvg = mean(rightData);
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
})();