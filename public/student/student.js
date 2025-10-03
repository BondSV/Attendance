(() => {
  const decodePayload = (hash) => {
    if (!hash) return null;
    try {
      const base64 = hash.replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = atob(base64);
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error('Failed to decode payload', err);
      return null;
    }
  };

  function getOrCreateDeviceId() {
    try {
      const existing = localStorage.getItem('attendance_device_id');
      if (existing) return existing;
      const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `dev-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem('attendance_device_id', id);
      return id;
    } catch (err) {
      console.warn('Unable to access localStorage, falling back to session device id.', err);
      return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `dev-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }
  }

  const deviceId = getOrCreateDeviceId();

  const fragment = window.location.hash.slice(1);
  const payload = decodePayload(fragment);
  if (!payload || !payload.sid) {
    document.body.innerHTML = '<div style="padding:32px;font-family:Inter,system-ui,sans-serif;color:#dc2626;">Invalid or missing session information.<br/>Please scan the Step 1 QR again.</div>';
    return;
  }

  const sid = payload.sid;
  const moduleCode = payload.m || payload.module || '';
  const groupNumber = payload.g || payload.group || '';
  const normalizePhase = (value) => {
    const raw = (value || 'start').toString().trim().toLowerCase();
    if (raw === 'break' || raw === 'break1' || raw === 'break 1') return 'break1';
    if (raw === 'break2' || raw === 'break 2') return 'break2';
    if (raw === 'start' || raw === 'end') return raw;
    return 'start';
  };
  const phase = normalizePhase(payload.p || payload.phase);
  const moduleRe = /^[A-Z]{3}\d{5}$/;
  const groupRe = /^[0-9]$/;
  if (!moduleRe.test(moduleCode) || !groupRe.test(groupNumber)) {
    document.body.innerHTML = '<div style="padding:32px;font-family:Inter,system-ui,sans-serif;color:#dc2626;">Session data is incomplete. Please return to the QR and try again.</div>';
    return;
  }
  const sessionLabel = document.getElementById('sessionLabel');
  const scanBtn = document.getElementById('scanBtn');
  const cameraFrame = document.getElementById('cameraFrame');
  const scannerPlaceholder = document.getElementById('scannerPlaceholder');
  const statusCard = document.getElementById('statusCard');
  const statusIcon = document.getElementById('statusIcon');
  const statusHeading = document.getElementById('statusHeading');
  const statusMessage = document.getElementById('statusMessage');
  const video = document.getElementById('video');
  const idCard = document.getElementById('idCard');
  const submitBtn = document.getElementById('submit-btn');
  const idInput = document.getElementById('student-id');
  const cameraHint = document.getElementById('cameraHint');
  const scannerStatus = document.getElementById('scannerStatus');
  const manualOverrideDetails = document.getElementById('manualOverrideDetails');
  const manualOverrideBtn = document.getElementById('manual-override-btn');
  const manualOverrideStatus = document.getElementById('manualOverrideStatus');

  const pageSessionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `ps-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

  sessionLabel.textContent = `${moduleCode} — Group ${groupNumber}`;

  let mediaStream = null;
  let barcodeDetector = null;
  let scanning = false;
  let verificationId = null;
  const challengeCache = new Set();

  const supportsBarcodeDetector = 'BarcodeDetector' in window;

  function setScannerStatus(message = '', tone = 'info') {
    if (!scannerStatus) return;
    const colors = { error: '#dc2626', success: '#16a34a', info: '#475467' };
    const normalizedTone = colors[tone] ? tone : 'info';
    scannerStatus.textContent = message || '';
    scannerStatus.style.color = message ? colors[normalizedTone] : colors.info;
  }

  function setManualOverrideStatus(message = '', tone = 'info') {
    if (!manualOverrideStatus) return;
    const colors = { error: '#dc2626', success: '#16a34a', info: '#475467' };
    const normalizedTone = colors[tone] ? tone : 'info';
    manualOverrideStatus.textContent = message || '';
    manualOverrideStatus.style.color = message ? colors[normalizedTone] : colors.info;
    if (message && manualOverrideDetails) {
      manualOverrideDetails.open = true;
    }
  }

  function hasLiveVideoTrack(stream) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return false;
    return stream.getVideoTracks().some(track => track.readyState === 'live');
  }

  async function ensureCamera() {
    if (hasLiveVideoTrack(mediaStream)) return mediaStream;
    const constraintsList = [
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false }
    ];
    let lastError = null;
    for (const constraints of constraintsList) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        return mediaStream;
      } catch (err) {
        lastError = err;
      }
    }
    mediaStream = null;
    throw lastError || new Error('Unable to access the camera.');
  }

  async function ensureDetector() {
    if (!supportsBarcodeDetector) return null;
    if (!barcodeDetector) {
      try {
        barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch (err) {
        console.warn('BarcodeDetector init failed', err);
        barcodeDetector = null;
      }
    }
    return barcodeDetector;
  }

  function stopScanning(reason = '', tone = 'info') {
    scanning = false;
    cameraFrame.setAttribute('hidden', '');
    scannerPlaceholder.removeAttribute('hidden');
    scanBtn.disabled = false;
    setScannerStatus(reason, tone);
    const cleanup = (stream) => {
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach(track => track.stop());
      }
    };
    cleanup(video.srcObject);
    video.srcObject = null;
    cleanup(mediaStream);
    mediaStream = null;
  }

  async function submitChallenge(challenge) {
    const body = { sid, module: moduleCode, group: groupNumber, phase, challenge, page_session_id: pageSessionId, device_id: deviceId };
    const resp = await fetch('/api/validate-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok || !data.verified) {
      throw new Error(data.error || 'Verification failed. Wait for the next code.');
    }
    verificationId = data.verification_id;
  }

  function parseChallengePayload(text) {
    if (typeof text !== 'string') return null;
    if (text.length === 0 || text.length > 256) return null;
    return text;
  }

  async function startScanning() {
    if (scanning) return;
    scanning = true;
    statusCard.setAttribute('hidden', '');
    idCard.setAttribute('hidden', '');
    statusMessage.textContent = '';
    setScannerStatus('');
    scannerPlaceholder.setAttribute('hidden', '');
    cameraFrame.removeAttribute('hidden');
    scanBtn.disabled = true;
    scanBtn.removeAttribute('hidden');

    try {
      const stream = await ensureCamera();
      video.srcObject = stream;
      // iOS often needs metadata before play; also require playsinline & muted attributes
      if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
      if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      await new Promise((resolve) => {
        const onReady = () => { video.removeEventListener('loadedmetadata', onReady); resolve(); };
        if (video.readyState >= 1) return resolve();
        video.addEventListener('loadedmetadata', onReady, { once: true });
        setTimeout(resolve, 500); // safety timeout
      });
      await video.play().catch(() => {});
      const detector = await ensureDetector();
      if (detector) {
        await scanWithDetector(detector);
      } else {
        await scanWithFallback();
      }
    } catch (err) {
      console.error(err);
      const message = err && err.message ? err.message : 'Camera error. Please try again.';
    stopScanning(message, 'error');
    }
  }

  async function scanWithDetector(detector) {
    while (scanning) {
      try {
        if (!video.videoWidth || !video.videoHeight) {
          await new Promise(r => setTimeout(r, 80));
          continue;
        }
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length) {
          const value = barcodes[0].rawValue || '';
          const challenge = parseChallengePayload(value);
          if (challenge && !challengeCache.has(challenge)) {
            challengeCache.add(challenge);
            await submitChallenge(challenge);
            handleVerified();
            return;
          }
        }
      } catch (err) {
        console.warn('Detector error', err);
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  async function scanWithFallback() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!window.jsQR) {
      stopScanning('QR scanning is not supported on this browser. Update iOS or try a different browser.', 'error');
      return;
    }

    while (scanning) {
      try {
        if (!video.videoWidth || !video.videoHeight) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (result && result.data) {
          const challenge = parseChallengePayload(result.data);
          if (challenge && !challengeCache.has(challenge)) {
            challengeCache.add(challenge);
            await submitChallenge(challenge);
            handleVerified();
            return;
          }
        }
      } catch (err) {
        if (!scanning) return;
        console.warn('Fallback decode error', err);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  function updateStatus({ type = 'success', heading, message }) {
    const styles = {
      success: { icon: '✔', bg: 'rgba(22, 163, 74, 0.12)', border: 'rgba(22, 163, 74, 0.24)', iconBg: '#16a34a' },
      error: { icon: '!', bg: 'rgba(220, 38, 38, 0.12)', border: 'rgba(220, 38, 38, 0.24)', iconBg: '#dc2626' },
      info: { icon: 'ℹ', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.24)', iconBg: '#2563eb' }
    };
    const theme = styles[type] || styles.success;
    statusCard.style.background = theme.bg;
    statusCard.style.borderColor = theme.border;
    statusIcon.textContent = theme.icon;
    statusIcon.style.background = theme.iconBg;
    statusHeading.textContent = heading;
    statusMessage.textContent = message;
    statusCard.removeAttribute('hidden');
  }

  function handleVerified() {
    scanning = false;
    stopScanning();
    cameraFrame.setAttribute('hidden', '');
    scannerPlaceholder.setAttribute('hidden', '');
    scanBtn.setAttribute('hidden', '');
    scanBtn.disabled = true;
    setScannerStatus('');
    updateStatus({ type: 'success', heading: 'Presence verified', message: 'Great! Now enter your student ID to finish the check-in.' });
    idCard.removeAttribute('hidden');
  }

  scanBtn.addEventListener('click', () => {
    startScanning();
  });

  if (manualOverrideBtn) {
    manualOverrideBtn.addEventListener('click', async () => {
      manualOverrideBtn.disabled = true;
      setManualOverrideStatus('Checking device status…', 'info');
      try {
        const checkResp = await fetch('/api/manual-override/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, phase, device_id: deviceId, page_session_id: pageSessionId })
        });
        const checkData = await checkResp.json();
        if (!checkResp.ok || !checkData.ok) {
          throw new Error(checkData.error || 'Manual override is unavailable right now.');
        }
      } catch (err) {
        console.error('Manual override pre-check failed', err);
        setManualOverrideStatus(err && err.message ? err.message : 'Manual override could not start. Please try again or use the scanner.', 'error');
        manualOverrideBtn.disabled = false;
        return;
      }

      const password = window.prompt('Teacher password required for manual override:');
      if (password === null) {
        setManualOverrideStatus('Manual override cancelled.', 'info');
        manualOverrideBtn.disabled = false;
        return;
      }
      const trimmedPassword = password.trim();
      if (!trimmedPassword) {
        setManualOverrideStatus('Password is required to continue.', 'error');
        manualOverrideBtn.disabled = false;
        return;
      }

      setManualOverrideStatus('Awaiting teacher confirmation…', 'info');
      try {
        const completeResp = await fetch('/api/manual-override/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, phase, device_id: deviceId, page_session_id: pageSessionId, teacher_password: trimmedPassword })
        });
        const completeData = await completeResp.json();
        if (!completeResp.ok || !completeData.verified || !completeData.verification_id) {
          throw new Error(completeData.error || 'Manual override failed.');
        }
        verificationId = completeData.verification_id;
        handleVerified();
        setManualOverrideStatus('Override approved. Enter your student ID to finish.', 'success');
        manualOverrideBtn.disabled = true;
      } catch (err) {
        console.error('Manual override completion failed', err);
        setManualOverrideStatus(err && err.message ? err.message : 'Manual override failed. Please try again.', 'error');
        manualOverrideBtn.disabled = false;
      }
    });
  }

  submitBtn.addEventListener('click', async () => {
    const studentId = idInput.value.trim();
    if (!studentId) {
      updateStatus({ type: 'error', heading: 'Student ID missing', message: 'Please enter your student ID before submitting.' });
      return;
    }
    if (!/^9\d{7}$/.test(studentId)) {
      updateStatus({ type: 'error', heading: 'Check your student ID', message: 'Student ID must be eight digits starting with 9. Please double-check and try again.' });
      return;
    }
    if (!verificationId) {
      updateStatus({ type: 'error', heading: 'Verification required', message: 'Scan the live verification QR-code before submitting your student ID.' });
      return;
    }
    submitBtn.disabled = true;
    updateStatus({ type: 'info', heading: 'Submitting…', message: 'Please wait while we record your attendance.' });
    try {
      const resp = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, phase, student_id: studentId, verification_id: verificationId, page_session_id: pageSessionId, device_id: deviceId })
      });
      const data = await resp.json();
      if (data.ok) {
        updateStatus({ type: 'success', heading: 'Attendance recorded', message: 'Your check-in has been submitted. You can close this page.' });
        submitBtn.disabled = true;
        idInput.disabled = true;
      } else {
        throw new Error(data.error || 'Submission failed');
      }
    } catch (err) {
      console.error(err);
      updateStatus({ type: 'error', heading: 'Submission failed', message: err.message || 'Something went wrong. Please try again.' });
      submitBtn.disabled = false;
    }
  });
})();
