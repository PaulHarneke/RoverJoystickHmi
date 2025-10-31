(() => {
  const modeSwitch = document.getElementById('modeSwitch');
  const statusText = document.getElementById('statusText');
  const joystickPad = document.getElementById('joystickPad');
  const joystickThumb = document.getElementById('joystickThumb');
  const modeValue = document.getElementById('modeValue');
  const xValue = document.getElementById('xValue');
  const yValue = document.getElementById('yValue');
  const magValue = document.getElementById('magValue');
  const degValue = document.getElementById('degValue');

  const UI_THROTTLE_MS = 33; // ~30 Hz updates towards the server
  let socket;
  let reconnectTimer;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 10000;
  let isDragging = false;
  let activePointerId = null;
  let lastStickSend = 0;
  let pendingStickTimeout = null;

  const state = {
    mode: 'automatic',
    stick: { x: 0, y: 0, mag: 0, deg: 0 }
  };

  function setStatus(message, stateName) {
    statusText.textContent = message;
    statusText.dataset.state = stateName;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function calculateJoystickDegrees(x, y) {
    if (Math.abs(x) < Number.EPSILON && Math.abs(y) < Number.EPSILON) {
      return 0;
    }
    const standardDegrees = Math.atan2(y, x) * (180 / Math.PI);
    return normalizeDegrees(90 - standardDegrees);
  }

  function updateTelemetryDisplay() {
    modeValue.textContent = state.mode;
    xValue.textContent = state.stick.x.toFixed(2);
    yValue.textContent = state.stick.y.toFixed(2);
    magValue.textContent = state.stick.mag.toFixed(2);
    degValue.textContent = `${Math.round(state.stick.deg)}°`;
  }

  function setThumbPosition(x, y) {
    const rect = joystickPad.getBoundingClientRect();
    const maxRadius = rect.width / 2;
    const thumbRadius = joystickThumb.offsetWidth / 2;
    const travel = maxRadius - thumbRadius;
    const offsetX = clamp(x, -1, 1) * travel;
    const offsetY = clamp(-y, -1, 1) * travel;
    joystickThumb.style.setProperty('--dx', `${offsetX}px`);
    joystickThumb.style.setProperty('--dy', `${offsetY}px`);
  }

  function applyStickData(stick, { fromServer = false } = {}) {
    const x = clamp(Number(stick.x) || 0, -1, 1);
    const y = clamp(Number(stick.y) || 0, -1, 1);
    const magValue = Number(stick.mag);
    const mag = clamp(Number.isFinite(magValue) ? magValue : Math.hypot(x, y), 0, 1);
    let deg = Number(stick.deg);
    if (!Number.isFinite(deg)) {
      deg = calculateJoystickDegrees(x, y);
    } else {
      deg = normalizeDegrees(deg);
    }
    state.stick = { x, y, mag, deg };
    updateTelemetryDisplay();
    if (!isDragging || !fromServer) {
      setThumbPosition(x, y);
    }
  }

  function setMode(mode, { fromServer = false } = {}) {
    if (mode !== 'automatic' && mode !== 'manual') {
      return;
    }
    state.mode = mode;
    modeSwitch.checked = state.mode === 'manual';
    joystickPad.classList.toggle('is-disabled', state.mode !== 'manual');
    if (state.mode !== 'manual' && !isDragging) {
      applyStickData({ x: 0, y: 0, mag: 0, deg: 0 });
    }
    updateTelemetryDisplay();
    if (!fromServer) {
      sendMessage({ type: 'setMode', mode: state.mode, ts: Date.now() });
    }
  }

  function sendStickPayload() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    lastStickSend = Date.now();
    pendingStickTimeout = null;
    sendMessage({
      type: 'stick',
      x: state.stick.x,
      y: state.stick.y,
      mag: state.stick.mag,
      deg: state.stick.deg,
      ts: lastStickSend
    });
  }

  function queueStickSend() {
    const now = Date.now();
    if (now - lastStickSend >= UI_THROTTLE_MS) {
      sendStickPayload();
      return;
    }
    if (pendingStickTimeout) {
      return;
    }
    pendingStickTimeout = window.setTimeout(() => {
      pendingStickTimeout = null;
      sendStickPayload();
    }, UI_THROTTLE_MS - (now - lastStickSend));
  }

  function resetStick() {
    applyStickData({ x: 0, y: 0, mag: 0, deg: 0 });
    queueStickSend();
  }

  function handlePointerEvent(event) {
    if (state.mode !== 'manual') {
      return;
    }
    const rect = joystickPad.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let rawX = (event.clientX - centerX) / radius;
    let rawY = (event.clientY - centerY) / radius;
    const distance = Math.hypot(rawX, rawY);
    if (distance > 1) {
      rawX /= distance;
      rawY /= distance;
    }
    const normalizedX = clamp(rawX, -1, 1);
    const normalizedY = clamp(-rawY, -1, 1);
    const magnitude = clamp(Math.hypot(normalizedX, normalizedY), 0, 1);
    const degrees = calculateJoystickDegrees(normalizedX, normalizedY);

    const nextStick = {
      x: normalizedX,
      y: normalizedY,
      mag: magnitude,
      deg: degrees
    };

    applyStickData(nextStick);
    queueStickSend();
  }

  function sendMessage(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      console.error('[WS] Failed to send payload', error);
    }
  }

  function connectSocket() {
    clearTimeout(reconnectTimer);
    setStatus('Connecting…', 'connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.error('[WS] Connection failed:', error);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      setStatus('Connected', 'connected');
      reconnectDelay = 1000;
      if (state.mode === 'manual') {
        queueStickSend();
      } else {
        resetStick();
      }
      sendMessage({ type: 'setMode', mode: state.mode, ts: Date.now() });
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'state':
            if (message.mode) {
              setMode(message.mode, { fromServer: true });
            }
            if (message.stick) {
              applyStickData(message.stick, { fromServer: true });
            }
            break;
          case 'mode':
            if (message.mode) {
              setMode(message.mode, { fromServer: true });
            }
            break;
          case 'stick':
            if (message.stick) {
              applyStickData(message.stick, { fromServer: true });
            }
            break;
          default:
            console.warn('[WS] Unhandled message type', message.type);
        }
      } catch (error) {
        console.error('[WS] Failed to parse message', error);
      }
    });

    socket.addEventListener('close', () => {
      setStatus('Reconnecting…', 'reconnecting');
      scheduleReconnect();
    });

    socket.addEventListener('error', (error) => {
      console.error('[WS] Socket error', error);
      setStatus('Connection error', 'error');
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
      connectSocket();
    }, reconnectDelay);
  }

  modeSwitch.addEventListener('change', () => {
    const desiredMode = modeSwitch.checked ? 'manual' : 'automatic';
    setMode(desiredMode);
    if (desiredMode === 'automatic') {
      resetStick();
    }
  });

  joystickPad.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'manual') {
      return;
    }
    event.preventDefault();
    joystickPad.classList.add('is-dragging');
    joystickPad.setPointerCapture(event.pointerId);
    isDragging = true;
    activePointerId = event.pointerId;
    handlePointerEvent(event);
  });

  joystickPad.addEventListener('pointermove', (event) => {
    if (!isDragging || event.pointerId !== activePointerId) {
      return;
    }
    event.preventDefault();
    handlePointerEvent(event);
  });

  const endPointer = (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    joystickPad.classList.remove('is-dragging');
    try {
      joystickPad.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore if capture already released
    }
    isDragging = false;
    activePointerId = null;
    resetStick();
  };

  joystickPad.addEventListener('pointerup', endPointer);
  joystickPad.addEventListener('pointercancel', endPointer);
  joystickPad.addEventListener('lostpointercapture', () => {
    if (isDragging) {
      isDragging = false;
      activePointerId = null;
      joystickPad.classList.remove('is-dragging');
      resetStick();
    }
  });

  window.addEventListener('resize', () => {
    setThumbPosition(state.stick.x, state.stick.y);
  });

  updateTelemetryDisplay();
  setMode(state.mode, { fromServer: true });
  connectSocket();
})();
