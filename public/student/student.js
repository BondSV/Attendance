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
  const phase = payload.p || payload.phase || 'start';
  const sessionLabel = document.getElementById('sessionLabel');
  const sessionTitle = document.getElementById('sessionTitle');
  const scanBtn = document.getElementById('scanBtn');
  const cameraFrame = document.getElementById('cameraFrame');
  const scannerPlaceholder = document.getElementById('scannerPlaceholder');
  const successCard = document.getElementById('successCard');
  const video = document.getElementById('video');
  const idCard = document.getElementById('idCard');
  const submitBtn = document.getElementById('submit-btn');
  const idInput = document.getElementById('student-id');
  const submitStatus = document.getElementById('submitStatus');
  const cameraHint = document.getElementById('cameraHint');

  const pageSessionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `ps-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

  sessionLabel.textContent = sid;
  sessionTitle.textContent = 'Attendance Check-in';

  let mediaStream = null;
  let barcodeDetector = null;
  let scanning = false;
  let verificationId = null;
  const challengeCache = new Set();

  const supportsBarcodeDetector = 'BarcodeDetector' in window;

  async function ensureCamera() {
    if (mediaStream) return mediaStream;
    const constraintsPrimary = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    const constraintsFallback = { video: { facingMode: 'environment' }, audio: false };
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraintsPrimary);
    } catch (e1) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraintsFallback);
      } catch (e2) {
        // As a last resort, try any camera
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }
    return mediaStream;
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

  function stopScanning(reason) {
    scanning = false;
    cameraFrame.setAttribute('hidden', '');
    scannerPlaceholder.setAttribute('hidden', '');
    scanBtn.disabled = false;
    if (reason) submitStatus.textContent = reason;
    const stream = video.srcObject;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach(track => track.stop());
    }
    video.srcObject = null;
  }

  async function submitChallenge(challenge) {
    const body = { sid, phase, challenge, page_session_id: pageSessionId, device_id: deviceId };
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
    successCard.setAttribute('hidden', '');
    idCard.setAttribute('hidden', '');
    submitStatus.textContent = '';
    scannerPlaceholder.setAttribute('hidden', '');
    cameraFrame.removeAttribute('hidden');
    scanBtn.disabled = true;

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
      submitStatus.textContent = err.message || 'Camera error. Please try again.';
      stopScanning();
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
      submitStatus.textContent = 'QR scanning not supported on this device. Please try a different browser.';
      stopScanning();
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

  function handleVerified() {
    scanning = false;
    cameraFrame.setAttribute('hidden', '');
    scannerPlaceholder.setAttribute('hidden', '');
    successCard.removeAttribute('hidden');
    idCard.removeAttribute('hidden');
    submitStatus.textContent = 'Presence verified. Enter your student ID to finish.';
    submitStatus.style.color = '#16a34a';
    stopScanning();
  }

  scanBtn.addEventListener('click', () => {
    startScanning();
  });

  submitBtn.addEventListener('click', async () => {
    const studentId = idInput.value.trim();
    if (!studentId) {
      submitStatus.textContent = 'Please enter your student ID.';
      submitStatus.style.color = '#dc2626';
      return;
    }
    if (!verificationId) {
      submitStatus.textContent = 'You must scan the verification QR first.';
      submitStatus.style.color = '#dc2626';
      return;
    }
    submitBtn.disabled = true;
    submitStatus.textContent = 'Submitting…';
    submitStatus.style.color = '#475467';
    try {
      const resp = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, phase, student_id: studentId, verification_id: verificationId, page_session_id: pageSessionId, device_id: deviceId })
      });
      const data = await resp.json();
      if (data.ok) {
        submitStatus.textContent = 'Attendance recorded. Thank you!';
        submitStatus.style.color = '#16a34a';
        submitBtn.disabled = true;
        idInput.disabled = true;
        scanBtn.disabled = true;
      } else {
        throw new Error(data.error || 'Submission failed');
      }
    } catch (err) {
      console.error(err);
      submitStatus.textContent = err.message || 'Submission failed. Try again.';
      submitStatus.style.color = '#dc2626';
      submitBtn.disabled = false;
    }
  });
})();