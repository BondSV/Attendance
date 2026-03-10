(() => {
  /* ========================================================================
     Payload decoding & session setup
     (UNCHANGED — all verification logic is preserved exactly)
     ======================================================================== */
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
  const intake = payload.i || payload.intake || '';
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

  const pageSessionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `ps-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

  /* ========================================================================
     DOM Elements
     ======================================================================== */
  // -- Progress bar --
  const sessionLabel       = document.getElementById('sessionLabel');
  const stepNode2          = document.getElementById('stepNode2');
  const stepNode3          = document.getElementById('stepNode3');
  const stepCircle2        = document.getElementById('stepCircle2');
  const stepCircle3        = document.getElementById('stepCircle3');
  const stepLine           = document.getElementById('stepLine');

  // -- Screen panels --
  const screenScan         = document.getElementById('screenScan');
  const screenTransition   = document.getElementById('screenTransition');
  const screenId           = document.getElementById('screenId');
  const screenDone         = document.getElementById('screenDone');

  // -- Scanner (Screen 1) --
  const scanBtn            = document.getElementById('scanBtn');
  const cameraFrame        = document.getElementById('cameraFrame');
  const scannerPlaceholder = document.getElementById('scannerPlaceholder');
  const statusCard         = document.getElementById('statusCard');
  const statusIcon         = document.getElementById('statusIcon');
  const statusHeading      = document.getElementById('statusHeading');
  const statusMessage      = document.getElementById('statusMessage');
  const video              = document.getElementById('video');
  const cameraHint         = document.getElementById('cameraHint');
  const scannerStatus      = document.getElementById('scannerStatus');

  // -- Transition (Screen 2) --
  const transitionContinueBtn = document.getElementById('transitionContinueBtn');

  // -- Student ID (Screen 3) --
  const idInput            = document.getElementById('student-id');
  const submitBtn          = document.getElementById('submit-btn');
  const idStatusCard       = document.getElementById('idStatusCard');
  const idStatusIcon       = document.getElementById('idStatusIcon');
  const idStatusHeading    = document.getElementById('idStatusHeading');
  const idStatusMessage    = document.getElementById('idStatusMessage');

  // -- Done (Screen 4) --
  const doneDetail         = document.getElementById('doneDetail');

  // -- Manual override --
  const manualOverrideDetails  = document.getElementById('manualOverrideDetails');
  const manualOverrideBtn      = document.getElementById('manual-override-btn');
  const manualOverrideStatus   = document.getElementById('manualOverrideStatus');
  const manualOverrideForm     = document.getElementById('manualOverrideForm');
  const manualOverridePasswordInput = document.getElementById('manualOverridePassword');
  const manualOverrideSubmit   = document.getElementById('manualOverrideSubmit');

  /* ========================================================================
     Session label
     ======================================================================== */
  sessionLabel.textContent = `${moduleCode} — Group ${groupNumber}`;

  /* ========================================================================
     Screen navigation helpers
     ======================================================================== */
  const allScreens = [screenScan, screenTransition, screenId, screenDone];

  function showScreen(target) {
    allScreens.forEach(s => {
      s.removeAttribute('hidden');
      s.classList.remove('screen--active', 'screen--fade-in');
    });
    allScreens.forEach(s => {
      if (s !== target) s.setAttribute('hidden', '');
    });
    target.classList.add('screen--active', 'screen--fade-in');
  }

  function setProgress(step) {
    // step = 2 (scan active), 2.5 (scan done, transitioning), 3 (id active), 4 (all done)
    stepNode2.classList.remove('active', 'done');
    stepNode3.classList.remove('active', 'done');
    stepLine.classList.remove('filled');

    if (step === 2) {
      stepNode2.classList.add('active');
      stepCircle2.textContent = '2';
    } else if (step >= 2.5) {
      stepNode2.classList.add('done');
      stepCircle2.textContent = '✓';
      stepLine.classList.add('filled');
    }

    if (step === 3) {
      stepNode3.classList.add('active');
      stepCircle3.textContent = '3';
    } else if (step >= 4) {
      stepNode3.classList.add('done');
      stepCircle3.textContent = '✓';
    }
  }

  // Initialize
  setProgress(2);

  /* ========================================================================
     Scanner status helpers
     ======================================================================== */
  let mediaStream = null;
  let barcodeDetector = null;
  let scanning = false;
  let verificationId = null;
  const challengeCache = new Set();
  const supportsBarcodeDetector = 'BarcodeDetector' in window;

  function setScannerStatus(message = '', tone = 'info') {
    if (!scannerStatus) return;
    const colors = { error: '#dc2626', success: '#16a34a', info: '#667085' };
    const normalizedTone = colors[tone] ? tone : 'info';
    scannerStatus.textContent = message || '';
    scannerStatus.style.color = message ? colors[normalizedTone] : colors.info;
  }

  function setManualOverrideStatus(message = '', tone = 'info') {
    if (!manualOverrideStatus) return;
    const colors = { error: '#dc2626', success: '#16a34a', info: '#667085' };
    const normalizedTone = colors[tone] ? tone : 'info';
    manualOverrideStatus.textContent = message || '';
    manualOverrideStatus.style.color = message ? colors[normalizedTone] : colors.info;
    if (message && manualOverrideDetails) {
      manualOverrideDetails.open = true;
    }
  }

  /* ========================================================================
     Status card helpers (Screen 1 — scanner)
     ======================================================================== */
  function updateScanStatus({ type = 'error', heading, message }) {
    const styles = {
      success: { icon: '✔', iconBg: '#16a34a', cls: 'status-card--success' },
      error:   { icon: '!', iconBg: '#dc2626', cls: 'status-card--error' },
      info:    { icon: 'ℹ', iconBg: '#2563eb', cls: 'status-card--info' }
    };
    const theme = styles[type] || styles.error;
    statusCard.className = 'status-card ' + theme.cls;
    statusIcon.textContent = theme.icon;
    statusIcon.style.background = theme.iconBg;
    statusHeading.textContent = heading;
    statusMessage.textContent = message;
    statusCard.removeAttribute('hidden');
  }

  /* ========================================================================
     Status card helpers (Screen 3 — student ID)
     ======================================================================== */
  function updateIdStatus({ type = 'error', heading, message }) {
    const styles = {
      success: { icon: '✔', iconBg: '#16a34a', cls: 'status-card--success' },
      error:   { icon: '!', iconBg: '#dc2626', cls: 'status-card--error' },
      info:    { icon: '⏳', iconBg: '#2563eb', cls: 'status-card--info' }
    };
    const theme = styles[type] || styles.error;
    idStatusCard.className = 'status-card ' + theme.cls;
    idStatusIcon.textContent = theme.icon;
    idStatusIcon.style.background = theme.iconBg;
    idStatusHeading.textContent = heading;
    idStatusMessage.textContent = message;
    idStatusCard.removeAttribute('hidden');
  }

  function clearIdStatus() {
    idStatusCard.setAttribute('hidden', '');
  }

  /* ========================================================================
     Camera helpers (UNCHANGED logic)
     ======================================================================== */
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
    cameraFrame.classList.remove('scanning');
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

  /* ========================================================================
     Challenge submission (UNCHANGED logic)
     ======================================================================== */
  async function submitChallenge(challenge) {
    const body = { sid, module: moduleCode, group: groupNumber, intake, phase, challenge, page_session_id: pageSessionId, device_id: deviceId };
    const resp = await fetch('/api/validate-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok || !data.verified) {
      throw new Error(data.error || 'That code has expired. Keep the camera pointed at the screen — a new code will appear shortly.');
    }
    verificationId = data.verification_id;
  }

  function parseChallengePayload(text) {
    if (typeof text !== 'string') return null;
    if (text.length === 0 || text.length > 256) return null;
    return text;
  }

  /* ========================================================================
     Scanning (UNCHANGED detection logic, updated UI hooks)
     ======================================================================== */
  async function startScanning() {
    if (scanning) return;
    scanning = true;
    statusCard.setAttribute('hidden', '');
    setScannerStatus('');
    scannerPlaceholder.setAttribute('hidden', '');
    cameraFrame.removeAttribute('hidden');
    cameraFrame.classList.add('scanning');
    scanBtn.disabled = true;

    try {
      const stream = await ensureCamera();
      video.srcObject = stream;
      if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
      if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      await new Promise((resolve) => {
        const onReady = () => { video.removeEventListener('loadedmetadata', onReady); resolve(); };
        if (video.readyState >= 1) return resolve();
        video.addEventListener('loadedmetadata', onReady, { once: true });
        setTimeout(resolve, 500);
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
      const msg = err && err.message ? err.message : 'Camera error. Please try again.';
      // Provide specific messages for common camera errors
      if (err && err.name === 'NotAllowedError') {
        updateScanStatus({ type: 'error', heading: 'Camera access needed', message: 'Please allow camera access in your browser settings and try again.' });
      } else if (err && (err.name === 'NotFoundError' || err.name === 'NotReadableError')) {
        updateScanStatus({ type: 'error', heading: 'Camera not available', message: 'Unable to access the camera. Try closing other apps using the camera, or use a different browser.' });
      } else {
        updateScanStatus({ type: 'error', heading: 'Camera error', message: msg });
      }
      stopScanning('', 'error');
    }
  }

  async function scanWithDetector(detector) {
    let slowScanTimer = setTimeout(() => {
      if (scanning) setScannerStatus('Still looking… keep the QR code steady in the frame', 'info');
    }, 8000);

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
            try {
              await submitChallenge(challenge);
              clearTimeout(slowScanTimer);
              handleVerified();
              return;
            } catch (submitErr) {
              updateScanStatus({ type: 'error', heading: 'Code expired', message: 'That code has expired. Keep the camera pointed at the screen — a new code will appear shortly.' });
            }
          }
        }
      } catch (err) {
        console.warn('Detector error', err);
      }
      await new Promise(r => setTimeout(r, 150));
    }
    clearTimeout(slowScanTimer);
  }

  async function scanWithFallback() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!window.jsQR) {
      stopScanning('QR scanning is not supported on this browser. Update iOS or try a different browser.', 'error');
      updateScanStatus({ type: 'error', heading: 'Scanner not available', message: 'QR scanning is not supported on this browser. Please update iOS or try a different browser.' });
      return;
    }

    let slowScanTimer = setTimeout(() => {
      if (scanning) setScannerStatus('Still looking… keep the QR code steady in the frame', 'info');
    }, 8000);

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
            try {
              await submitChallenge(challenge);
              clearTimeout(slowScanTimer);
              handleVerified();
              return;
            } catch (submitErr) {
              updateScanStatus({ type: 'error', heading: 'Code expired', message: 'That code has expired. Keep the camera pointed at the screen — a new code will appear shortly.' });
            }
          }
        }
      } catch (err) {
        if (!scanning) return;
        console.warn('Fallback decode error', err);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    clearTimeout(slowScanTimer);
  }

  /* ========================================================================
     Handle verified — transition from Screen 1 → Screen 2 → Screen 3
     ======================================================================== */
  let transitionTimer = null;

  function handleVerified() {
    scanning = false;
    // Stop camera
    const cleanup = (stream) => {
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach(track => track.stop());
      }
    };
    cleanup(video.srcObject);
    video.srcObject = null;
    cleanup(mediaStream);
    mediaStream = null;
    cameraFrame.classList.remove('scanning');

    // Show transition screen
    setProgress(2.5);
    showScreen(screenTransition);

    // Auto-advance after 2.5s
    transitionTimer = setTimeout(() => {
      advanceToIdScreen();
    }, 2500);
  }

  function advanceToIdScreen() {
    if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
    setProgress(3);
    showScreen(screenId);
    // Auto-focus the input
    setTimeout(() => { idInput.focus(); }, 300);
  }

  // Tap to continue on transition screen
  if (transitionContinueBtn) {
    transitionContinueBtn.addEventListener('click', () => {
      advanceToIdScreen();
    });
  }

  /* ========================================================================
     Scan button
     ======================================================================== */
  scanBtn.addEventListener('click', () => {
    startScanning();
  });

  /* ========================================================================
     Manual Override (UNCHANGED logic, updated UI hooks)
     ======================================================================== */
  let manualOverrideReady = false;

  if (manualOverrideBtn) {
    manualOverrideBtn.addEventListener('click', async () => {
      manualOverrideReady = false;
      if (manualOverrideForm) manualOverrideForm.setAttribute('hidden', '');
      if (manualOverridePasswordInput) {
        manualOverridePasswordInput.value = '';
        manualOverridePasswordInput.disabled = false;
      }
      if (manualOverrideSubmit) manualOverrideSubmit.disabled = false;
      manualOverrideBtn.disabled = true;
      setManualOverrideStatus('Checking device status…', 'info');
      try {
        const checkResp = await fetch('/api/manual-override/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, intake, phase, device_id: deviceId, page_session_id: pageSessionId })
        });
        const checkData = await checkResp.json();
        if (!checkResp.ok || !checkData.ok) {
          throw new Error(checkData.error || 'Manual override is unavailable right now.');
        }
        manualOverrideReady = true;
        if (manualOverrideForm) manualOverrideForm.removeAttribute('hidden');
        setManualOverrideStatus('Ask your teacher to enter the password.', 'info');
        if (manualOverridePasswordInput) {
          manualOverridePasswordInput.focus();
        }
      } catch (err) {
        console.error('Manual override pre-check failed', err);
        setManualOverrideStatus(err && err.message ? err.message : 'Manual override could not start. Please try again or use the scanner.', 'error');
        manualOverrideBtn.disabled = false;
      }
    });
  }

  if (manualOverrideForm) {
    manualOverrideForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!manualOverrideReady) {
        setManualOverrideStatus('Run the manual override check first.', 'error');
        if (manualOverrideBtn && !manualOverrideBtn.disabled) manualOverrideBtn.focus();
        return;
      }
      const passwordValue = manualOverridePasswordInput ? manualOverridePasswordInput.value.trim() : '';
      if (!passwordValue) {
        setManualOverrideStatus('Password is required to continue.', 'error');
        if (manualOverridePasswordInput) manualOverridePasswordInput.focus();
        return;
      }
      setManualOverrideStatus('Awaiting teacher confirmation…', 'info');
      if (manualOverridePasswordInput) manualOverridePasswordInput.disabled = true;
      if (manualOverrideSubmit) manualOverrideSubmit.disabled = true;
      try {
        const completeResp = await fetch('/api/manual-override/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, intake, phase, device_id: deviceId, page_session_id: pageSessionId, teacher_password: passwordValue })
        });
        const completeData = await completeResp.json();
        if (!completeResp.ok || !completeData.verified || !completeData.verification_id) {
          throw new Error(completeData.error || 'Manual override failed.');
        }
        verificationId = completeData.verification_id;
        setManualOverrideStatus('Override approved!', 'success');
        manualOverrideReady = false;
        if (manualOverrideBtn) manualOverrideBtn.disabled = true;
        handleVerified();
      } catch (err) {
        console.error('Manual override completion failed', err);
        setManualOverrideStatus(err && err.message ? err.message : 'Manual override failed. Please try again.', 'error');
        if (manualOverridePasswordInput) {
          manualOverridePasswordInput.disabled = false;
          manualOverridePasswordInput.focus();
          manualOverridePasswordInput.select();
        }
        if (manualOverrideSubmit) manualOverrideSubmit.disabled = false;
      }
    });
  }

  /* ========================================================================
     Submit Student ID (UNCHANGED logic, updated UI)
     ======================================================================== */
  submitBtn.addEventListener('click', async () => {
    clearIdStatus();
    const studentId = idInput.value.trim();
    if (!studentId) {
      updateIdStatus({ type: 'error', heading: 'Student ID missing', message: 'Please enter your student ID before submitting.' });
      idInput.focus();
      return;
    }
    if (!/^9\d{7}$/.test(studentId)) {
      updateIdStatus({ type: 'error', heading: 'Check your student ID', message: 'Student ID must be 8 digits starting with 9. Please check and try again.' });
      idInput.focus();
      idInput.select();
      return;
    }
    if (!verificationId) {
      updateIdStatus({ type: 'error', heading: 'Verification required', message: 'Please complete the QR code scan before submitting your student ID.' });
      return;
    }
    submitBtn.disabled = true;
    idInput.disabled = true;
    updateIdStatus({ type: 'info', heading: 'Recording attendance…', message: 'Please wait while we save your check-in.' });
    try {
      const resp = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, module: moduleCode, group: groupNumber, intake, phase, student_id: studentId, verification_id: verificationId, page_session_id: pageSessionId, device_id: deviceId })
      });
      const data = await resp.json();
      if (data.ok) {
        handleCheckinSuccess();
      } else {
        throw new Error(data.error || 'Submission failed');
      }
    } catch (err) {
      console.error(err);
      const msg = err.message || 'Something went wrong. Please try again.';
      updateIdStatus({ type: 'error', heading: 'Submission failed', message: msg });
      submitBtn.disabled = false;
      idInput.disabled = false;
      idInput.focus();
    }
  });

  /* ========================================================================
     Checkin success — transition to Screen 4 (done)
     ======================================================================== */
  function handleCheckinSuccess() {
    setProgress(4);
    doneDetail.textContent = `Attendance recorded for ${moduleCode} — Group ${groupNumber}`;
    showScreen(screenDone);
  }

})();
