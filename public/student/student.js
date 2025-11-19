(() => {
  // --- State & Config ---
  const state = {
    scanning: false,
    mediaStream: null,
    verificationId: null,
    payload: null,
    deviceId: getOrCreateDeviceId(),
    pageSessionId: crypto.randomUUID()
  };

  const elements = {
    // Sections
    scannerSection: document.getElementById('scannerSection'),
    inputSection: document.getElementById('inputSection'),
    passCard: document.getElementById('passCard'),
    manualOverrideSection: document.getElementById('manualOverrideSection'),
    historySection: document.getElementById('historySection'),
    
    // Elements
    video: document.getElementById('video'),
    sessionLabel: document.getElementById('sessionLabel'),
    scannerStatus: document.getElementById('scannerStatus'),
    startScanBtn: document.getElementById('startScanBtn'),
    studentIdInput: document.getElementById('studentIdInput'),
    submitIdBtn: document.getElementById('submitIdBtn'),
    manualOverrideBtn: document.getElementById('manualOverrideBtn'),
    manualOverridePassword: document.getElementById('manualOverridePassword'),
    manualOverrideSubmitBtn: document.getElementById('manualOverrideSubmitBtn'),
    manualOverrideStatus: document.getElementById('manualOverrideStatus'),
    
    // Pass Card Elements
    passTime: document.getElementById('passTime'),
    passModule: document.getElementById('passModule'),
    passStudentId: document.getElementById('passStudentId'),
    passDate: document.getElementById('passDate'),
    historyList: document.getElementById('historyList')
  };

  // --- Initialization ---
  function init() {
    renderHistory();
    
    const fragment = window.location.hash.slice(1);
    state.payload = decodePayload(fragment);

    if (!state.payload || !state.payload.sid) {
      showError('Invalid Session. Please rescan the QR code.');
      return;
    }

    const { m, module, g, group } = state.payload;
    const moduleCode = m || module || 'Unknown';
    const groupNum = g || group || '';
    elements.sessionLabel.textContent = `${moduleCode} ${groupNum ? '· G' + groupNum : ''}`;

    // Event Listeners
    elements.startScanBtn.addEventListener('click', startScanning);
    elements.submitIdBtn.addEventListener('click', handleSubmitId);
    elements.manualOverrideBtn.addEventListener('click', toggleManualOverride);
    elements.manualOverrideSubmitBtn.addEventListener('click', submitManualOverride);

    // Auto-start scanning if permission was granted previously
    startScanning();
  }

  // --- Core Logic ---

  async function startScanning() {
    if (state.scanning) return;
    
    try {
      elements.scannerStatus.textContent = 'Starting camera...';
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      
      state.mediaStream = stream;
      elements.video.srcObject = stream;
      elements.video.setAttribute('playsinline', true); // iOS fix
      await elements.video.play();
      
      state.scanning = true;
      elements.startScanBtn.classList.add('hidden');
      elements.scannerSection.classList.add('scanner-active');
      elements.scannerStatus.textContent = 'Align QR code to verify';
      
      requestAnimationFrame(scanFrame);
    } catch (err) {
      console.error(err);
      elements.scannerStatus.textContent = 'Camera access denied. Use Manual Verification.';
      elements.scannerStatus.classList.add('text-error');
    }
  }

  function stopScanning() {
    state.scanning = false;
    elements.scannerSection.classList.remove('scanner-active');
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
  }

  function scanFrame() {
    if (!state.scanning) return;
    
    if (elements.video.readyState === elements.video.HAVE_ENOUGH_DATA) {
      const canvas = document.createElement('canvas');
      canvas.width = elements.video.videoWidth;
      canvas.height = elements.video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(elements.video, 0, 0, canvas.width, canvas.height);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code) {
        handleQrDetected(code.data);
        return;
      }
    }
    requestAnimationFrame(scanFrame);
  }

  async function handleQrDetected(data) {
    // Simple debounce/validation
    if (!data || data.length > 256) return;
    
    stopScanning();
    vibrateSuccess();
    elements.scannerStatus.textContent = 'Verifying...';
    
    try {
      await submitChallenge(data);
      // Success
      elements.scannerSection.classList.add('hidden');
      elements.inputSection.classList.remove('hidden');
      elements.studentIdInput.focus();
    } catch (err) {
      elements.scannerStatus.textContent = err.message || 'Verification failed. Try again.';
      elements.scannerStatus.classList.add('text-error');
      elements.startScanBtn.classList.remove('hidden');
    }
  }

  async function submitChallenge(challenge) {
    const { sid, p, phase, m, module, g, group } = state.payload;
    
    const res = await fetch('/api/validate-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sid,
        phase: p || phase,
        challenge,
        page_session_id: state.pageSessionId,
        device_id: state.deviceId
      })
    });
    
    const data = await res.json();
    if (!data.verified) throw new Error(data.error || 'Invalid code');
    state.verificationId = data.verification_id;
  }

  async function handleSubmitId() {
    const studentId = elements.studentIdInput.value.trim();
    if (!/^\d{6,12}$/.test(studentId)) {
      alert('Please enter a valid Student ID (6-12 digits).');
      return;
    }

    elements.submitIdBtn.disabled = true;
    elements.submitIdBtn.textContent = 'Submitting...';

    try {
      const { sid, p, phase, m, module, g, group } = state.payload;
      
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid,
          phase: p || phase,
          student_id: studentId,
          verification_id: state.verificationId,
          page_session_id: state.pageSessionId,
          device_id: state.deviceId,
          module: m || module,
          group: g || group
        })
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Submission failed');

      showPass(studentId);
    } catch (err) {
      alert(err.message);
      elements.submitIdBtn.disabled = false;
      elements.submitIdBtn.textContent = 'Submit';
    }
  }

  function showPass(studentId) {
    vibrateSuccess();
    elements.inputSection.classList.add('hidden');
    elements.manualOverrideSection.classList.add('hidden');
    elements.manualOverrideBtn.classList.add('hidden');
    elements.passCard.classList.remove('hidden');

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const { m, module } = state.payload;

    elements.passTime.textContent = timeStr;
    elements.passDate.textContent = dateStr;
    elements.passModule.textContent = m || module || 'N/A';
    elements.passStudentId.textContent = studentId;

    saveToHistory({
      module: m || module || 'N/A',
      studentId,
      timestamp: now.toISOString()
    });
  }

  // --- Manual Override ---
  
  async function toggleManualOverride() {
    elements.manualOverrideSection.classList.toggle('hidden');
    if (!elements.manualOverrideSection.classList.contains('hidden')) {
      // Pre-check
      try {
        const { sid, p, phase, m, module, g, group } = state.payload;
        await fetch('/api/manual-override/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sid, phase: p || phase, module: m || module, group: g || group,
            device_id: state.deviceId, page_session_id: state.pageSessionId
          })
        });
      } catch (e) {
        console.warn(e);
      }
    }
  }

  async function submitManualOverride() {
    const password = elements.manualOverridePassword.value;
    if (!password) return;

    elements.manualOverrideSubmitBtn.disabled = true;
    elements.manualOverrideStatus.textContent = 'Verifying...';
    elements.manualOverrideStatus.className = 'text-center text-sm mt-2 text-muted';

    try {
      const { sid, p, phase, m, module, g, group } = state.payload;
      const res = await fetch('/api/manual-override/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid, phase: p || phase, module: m || module, group: g || group,
          device_id: state.deviceId, page_session_id: state.pageSessionId,
          teacher_password: password
        })
      });

      const data = await res.json();
      if (!data.verified) throw new Error(data.error || 'Incorrect password');

      state.verificationId = data.verification_id;
      
      // Success
      elements.manualOverrideSection.classList.add('hidden');
      elements.scannerSection.classList.add('hidden');
      elements.inputSection.classList.remove('hidden');
      elements.studentIdInput.focus();
      
    } catch (err) {
      elements.manualOverrideStatus.textContent = err.message;
      elements.manualOverrideStatus.className = 'text-center text-sm mt-2 text-error';
      elements.manualOverrideSubmitBtn.disabled = false;
    }
  }

  // --- History & Utils ---

  function saveToHistory(item) {
    try {
      const history = JSON.parse(localStorage.getItem('attendance_history') || '[]');
      history.unshift(item);
      if (history.length > 5) history.pop();
      localStorage.setItem('attendance_history', JSON.stringify(history));
      renderHistory();
    } catch (e) {
      console.warn('LocalStorage failed', e);
    }
  }

  function renderHistory() {
    try {
      const history = JSON.parse(localStorage.getItem('attendance_history') || '[]');
      if (history.length === 0) return;

      elements.historySection.classList.remove('hidden');
      elements.historyList.innerHTML = history.map((item, index) => {
        const date = new Date(item.timestamp);
        const isRecent = index === 0 && (Date.now() - date.getTime() < 60000);
        return `
          <div class="history-item ${isRecent ? 'recent' : ''}">
            <div>
              <div class="font-bold">${item.module}</div>
              <div class="text-xs text-muted">${date.toLocaleDateString()} ${date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
            </div>
            <div class="font-mono text-sm">${item.studentId}</div>
          </div>
        `;
      }).join('');
    } catch (e) {
      console.warn(e);
    }
  }

  function decodePayload(hash) {
    if (!hash) return null;
    try {
      const base64 = hash.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(base64));
    } catch { return null; }
  }

  function getOrCreateDeviceId() {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('device_id', id);
    }
    return id;
  }

  function vibrateSuccess() {
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
  }

  function showError(msg) {
    document.body.innerHTML = `<div style="padding:20px; color:var(--error); text-align:center;">${msg}</div>`;
  }

  // Start
  init();
})();
