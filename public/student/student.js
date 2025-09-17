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

  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const statusEl = document.getElementById('status');
  const idForm = document.getElementById('id-form');
  const idInput = document.getElementById('student-id');
  const submitBtn = document.getElementById('submit-btn');
  let verificationId = null;

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
    ctx.drawImage(video, 0, 0, w, h);
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
      await new Promise((r) => setTimeout(r, delta));
    }
    statusEl.textContent = 'Validating…';
    // Send bits to server for validation
    try {
      const resp = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, phase, seed, delta, bits }),
      });
      const data = await resp.json();
      if (data.verified) {
        verificationId = data.verification_id;
        statusEl.textContent = 'Verified! Enter your ID.';
        idForm.classList.remove('hidden');
      } else {
        statusEl.textContent = 'Verification failed. Try again.';
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Validation error.';
    }
  }

  // Kick off capture after video is ready
  video.addEventListener('playing', () => {
    // Wait a brief moment for camera auto‑exposure
    setTimeout(captureAndValidate, 500);
  });

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
        body: JSON.stringify({ sid, phase, student_id: studentId, verification_id: verificationId }),
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