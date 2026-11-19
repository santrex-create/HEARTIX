/**
 * HEARTIX — Phase 4: Live ECG Canvas, WebSocket Engine & Monitor Controls
 * Production-ready frontend controller managing WebSocket telemetry, 60 FPS sweeping ECG canvas,
 * clinical parameter cards, audio alarms, event logs, PDF reporting, and simulator controls.
 */

(function () {
  "use strict";

  // --- STATE MANAGEMENT ---
  const state = {
    serverConnected: false,
    esp32Connected: false,
    simMode: false,
    monitoringStopped: false,
    frozen: false,
    leadsOff: false,
    calibrating: false,
    validSignal: false,
    
    // Display configuration
    sweepSpeedMmPerSec: 25, // 25 or 50 mm/s
    gainMode: "AUTO",       // "AUTO", "1X", "2X"
    qrsBeepOn: true,
    
    // Patient Data
    patient: {
      name: "UNASSIGNED PATIENT",
      age: "--",
      gender: "--",
      id: "HTX-2026-001",
      bed: "Bed --",
      minHr: 60,
      maxHr: 100,
      notes: ""
    },

    // Latest metric telemetry
    metrics: {
      bpm: "---",
      rrMs: "---",
      hrvMs: "---",
      qrsMs: "---",
      stMv: "---",
      stStatus: "Screening",
      sqi: "---",
      aiLabel: "WAITING FOR ESP32 HARDWARE",
      aiConfidence: "---",
      aiReason: "Real-time morphological & interval classifier standing by.",
      bradycardia: false,
      tachycardia: false,
      arrhythmia: false,
      eventCount: 0,
      alarmLevel: "none",
      alarmText: "SYSTEM STANDBY — NO ACTIVE CLINICAL ALARMS",
      alarmReason: "Awaiting physiological telemetry stream"
    },

    // ECG Sample Buffers (250 Hz sample rate)
    // 25 mm/s = 5 seconds = 1250 samples; 50 mm/s = 2.5 seconds = 625 samples
    ecgBuffer: [], // objects: { sample: number, rPeak: boolean, timestamp: number }
    renderHead: 0, // current pixel or index write head
    
    // Rolling 10-second ring buffer (2500 samples) for PDF printing & snapshot review
    rollingPrintBuffer: [],
    
    // Incoming sample queue for smooth 60 FPS rendering
    sampleQueue: [],
    
    // WebSocket reconnection state
    ws: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    
    // Events log cache
    eventsListCache: []
  };

  // --- DOM ELEMENT REFERENCES ---
  const DOM = {};

  function cacheDomElements() {
    const ids = [
      "hdrPatientName", "hdrPatientMeta", "hdrPatientId", "badgeServer", "badgeEsp32",
      "badgePacketLoss", "badgeSqi", "sqiBarFill", "hdrClock",
      "alarmBanner", "alarmText", "alarmReason", "simWatermark",
      "ecgCanvas", "metaSpeedGain", "metaSource", "canvasOverlay", "canvasOverlayTitle", "canvasOverlaySub", "frozenBadge",
      "heartIcon", "valBpm", "valHrLimits", "valRr", "valHrv", "valQrs", "valSt", "valStStatus",
      "aiStatusPill", "valAiConfidence", "valAiReason", "flagBrady", "flagTachy", "flagArrhythmia",
      "btnFreeze", "btnStop", "btnReset", "btnSaveCsv", "btnPdfReport", "btnMuteAlarms",
      "btnQrsBeep", "btnSpeed", "btnGain", "btnEvents", "eventCountBadge", "btnPatient", "btnLabTest",
      "labTestBar", "btnSimStop",
      "patientModal", "patientForm", "inpPatientName", "inpPatientAge", "inpPatientGender",
      "inpPatientId", "inpPatientBed", "inpMinHr", "inpMaxHr", "inpNotes", "btnStartMonitoring", "btnGuestMode",
      "eventsDrawer", "btnCloseEvents", "eventsList", "eventSnapshotCanvas", "eventSnapshotMeta",
      "printReportContainer", "printPatientInfo", "printEcgCanvas", "printMetricsTable", "printEventsTable", "printTimestamp"
    ];

    ids.forEach(id => {
      DOM[id] = document.getElementById(id);
    });
  }

  // --- INITIALIZATION & CLOCK ---
  window.addEventListener("DOMContentLoaded", () => {
    cacheDomElements();
    initPatientIdPlaceholder();
    initClock();
    initWebSocket();
    initEventListeners();
    initCanvasResize();
    requestAnimationFrame(renderLoop);
  });

  function initPatientIdPlaceholder() {
    if (DOM.inpPatientId && !DOM.inpPatientId.value) {
      const randNum = Math.floor(100 + Math.random() * 900);
      DOM.inpPatientId.value = `HTX-2026-${randNum}`;
    }
  }

  function initClock() {
    setInterval(() => {
      const now = new Date();
      if (DOM.hdrClock) {
        DOM.hdrClock.textContent = now.toTimeString().split(" ")[0] + "." + String(now.getMilliseconds()).padStart(3, "0").slice(0, 2);
      }
    }, 50);
  }

  // --- WEBSOCKET ENGINE WITH EXPONENTIAL BACKOFF ---
  function initWebSocket() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/web`;

    if (DOM.badgeServer) {
      DOM.badgeServer.textContent = "CONNECTING";
      DOM.badgeServer.className = "badge-value status-sim";
    }

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.serverConnected = true;
      state.reconnectAttempt = 0;
      updateServerBadge(true);
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    state.ws.onclose = () => {
      state.serverConnected = false;
      state.esp32Connected = false;
      updateServerBadge(false);
      updateEsp32Badge(false);
      scheduleReconnect();
    };

    state.ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      try { state.ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempt), 10000);
    state.reconnectAttempt++;
    state.reconnectTimer = setTimeout(() => {
      initWebSocket();
    }, delay);
  }

  function updateServerBadge(connected) {
    if (!DOM.badgeServer) return;
    if (connected) {
      DOM.badgeServer.textContent = "ONLINE";
      DOM.badgeServer.className = "badge-value status-online";
    } else {
      DOM.badgeServer.textContent = "OFFLINE";
      DOM.badgeServer.className = "badge-value status-offline";
    }
  }

  function updateEsp32Badge(connected) {
    if (!DOM.badgeEsp32) return;
    if (connected) {
      DOM.badgeEsp32.textContent = "CONNECTED";
      DOM.badgeEsp32.className = "badge-value status-online";
    } else {
      DOM.badgeEsp32.textContent = "DISCONNECTED";
      DOM.badgeEsp32.className = "badge-value status-offline";
    }
  }

  // --- WEBSOCKET MESSAGE ROUTER ---
  function handleWsMessage(msg) {
    switch (msg.type) {
      case "ping":
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ action: "pong" }));
        }
        break;

      case "state":
        state.esp32Connected = Boolean(msg.esp32_connected);
        state.simMode = Boolean(msg.sim_mode);
        updateEsp32Badge(state.esp32Connected);
        
        if (DOM.badgePacketLoss && msg.packet_loss_pct !== undefined) {
          DOM.badgePacketLoss.textContent = Number(msg.packet_loss_pct).toFixed(1) + "%";
        }

        if (msg.patient) {
          syncPatientData(msg.patient);
        }

        applyHardwarePriorityUI();
        evaluateSystemState();
        break;

      case "ecg_batch":
        if (state.monitoringStopped) return;
        state.leadsOff = Boolean(msg.leads_off);
        state.calibrating = Boolean(msg.calibrating);
        
        if (msg.source && DOM.metaSource) {
          DOM.metaSource.textContent = `SOURCE: ${String(msg.source).toUpperCase()}`;
        }

        if (Array.isArray(msg.samples)) {
          const rPeaks = Array.isArray(msg.r_peak_offsets) ? msg.r_peak_offsets : [];
          for (let i = 0; i < msg.samples.length; i++) {
            const sampleVal = msg.samples[i];
            const isRPeak = Boolean(rPeaks[i]);
            state.sampleQueue.push({ sample: sampleVal, rPeak: isRPeak, timestamp: Date.now() });
          }
        }
        evaluateSystemState();
        break;

      case "metrics":
        updateMetricsDisplay(msg);
        break;

      case "reset":
        resetEcgBuffers();
        break;

      default:
        break;
    }
  }

  function sendWsCommand(action, payload = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ action, ...payload }));
    }
  }

  // --- SYSTEM STATE MACHINE & HARDWARE PRIORITY ---
  function applyHardwarePriorityUI() {
    if (state.esp32Connected) {
      if (DOM.labTestBar) DOM.labTestBar.classList.add("hidden");
      if (DOM.btnLabTest) DOM.btnLabTest.classList.remove("active");
      if (DOM.simWatermark) DOM.simWatermark.classList.add("hidden");
      state.simMode = false;
    } else if (state.simMode) {
      if (DOM.simWatermark) DOM.simWatermark.classList.remove("hidden");
    } else {
      if (DOM.simWatermark) DOM.simWatermark.classList.add("hidden");
    }
  }

  function evaluateSystemState() {
    const isOfflineOrStopped = (!state.esp32Connected && !state.simMode) || state.monitoringStopped;

    if (isOfflineOrStopped) {
      if (DOM.canvasOverlay) DOM.canvasOverlay.classList.remove("hidden");
      if (DOM.canvasOverlayTitle) {
        DOM.canvasOverlayTitle.textContent = state.monitoringStopped 
          ? "MONITORING STOPPED" 
          : "ESP32 NOT CONNECTED — POWER ON HEARTIX DEVICE TO BEGIN";
      }
      if (DOM.canvasOverlaySub) {
        DOM.canvasOverlaySub.textContent = state.monitoringStopped
          ? "Press STOP / RUN soft-key to resume telemetry acquisition"
          : "Verify USB-Serial / WebSocket telemetry bridge or enable Lab Test Mode below";
      }

      // Blank metrics
      blankAllMetrics();
      if (window.heartixAudio) {
        window.heartixAudio.setAlarmLevel("none");
      }
      updateAlarmBanner("none", "SYSTEM STANDBY — NO ACTIVE CLINICAL ALARMS", "Awaiting physiological telemetry stream");
      return;
    }

    if (state.leadsOff || state.calibrating || !state.validSignal) {
      if (DOM.canvasOverlay) DOM.canvasOverlay.classList.remove("hidden");
      if (DOM.canvasOverlayTitle) {
        DOM.canvasOverlayTitle.textContent = state.leadsOff 
          ? "LEADS OFF — CHECK ELECTRODE CONTACT" 
          : state.calibrating ? "CALIBRATING SENSOR..." : "LOW SIGNAL QUALITY (SQI < 60%)";
      }
      if (DOM.canvasOverlaySub) {
        DOM.canvasOverlaySub.textContent = "Ensure patient electrodes and leads II placement are secure.";
      }

      blankDerivedMetrics();
      if (state.leadsOff) {
        if (window.heartixAudio) {
          window.heartixAudio.triggerTechnicalAlert();
          window.heartixAudio.setAlarmLevel("technical");
        }
        updateAlarmBanner("technical", "TECHNICAL ALERT — LEADS OFF / POOR CONTACT", "Verify Lead II ECG electrode impedance");
      }
      return;
    }

    // Normal valid signal stream
    if (DOM.canvasOverlay) DOM.canvasOverlay.classList.add("hidden");
  }

  function blankAllMetrics() {
    const ids = ["valBpm", "valRr", "valHrv", "valQrs", "valSt", "badgeSqi", "valAiConfidence"];
    ids.forEach(id => {
      if (DOM[id]) DOM[id].textContent = "---";
    });
    if (DOM.sqiBarFill) DOM.sqiBarFill.style.width = "0%";
    if (DOM.aiStatusPill) {
      DOM.aiStatusPill.textContent = "WAITING FOR ESP32 HARDWARE";
      DOM.aiStatusPill.className = "ai-status-pill";
    }
    if (DOM.valAiReason) {
      DOM.valAiReason.textContent = "Real-time morphological & interval classifier standing by.";
    }
    resetRhythmFlags();
  }

  function blankDerivedMetrics() {
    const ids = ["valRr", "valHrv", "valQrs", "valSt", "badgeSqi", "valAiConfidence"];
    ids.forEach(id => {
      if (DOM[id]) DOM[id].textContent = "---";
    });
    if (DOM.sqiBarFill) DOM.sqiBarFill.style.width = "0%";
    resetRhythmFlags();
  }

  function resetRhythmFlags() {
    ["flagBrady", "flagTachy", "flagArrhythmia"].forEach(id => {
      if (DOM[id]) DOM[id].className = "rhythm-flag";
    });
  }

  function updateAlarmBanner(level, text, reason) {
    if (!DOM.alarmBanner) return;
    DOM.alarmBanner.className = `alarm-banner alarm-${level}`;
    if (DOM.alarmText) DOM.alarmText.textContent = text;
    if (DOM.alarmReason) DOM.alarmReason.textContent = reason;
  }

  function updateMetricsDisplay(m) {
    state.validSignal = Boolean(m.valid_signal);

    if (DOM.valBpm) DOM.valBpm.textContent = m.bpm !== undefined && m.bpm !== null ? m.bpm : "---";
    if (DOM.valRr) DOM.valRr.textContent = m.rr_ms !== undefined && m.rr_ms !== null ? m.rr_ms : "---";
    if (DOM.valHrv) DOM.valHrv.textContent = m.hrv_ms !== undefined && m.hrv_ms !== null ? m.hrv_ms : "---";
    if (DOM.valQrs) DOM.valQrs.textContent = m.qrs_ms !== undefined && m.qrs_ms !== null ? m.qrs_ms : "---";
    
    if (DOM.valSt) {
      const stVal = m.st_mv !== undefined && m.st_mv !== null ? Number(m.st_mv).toFixed(2) : "---";
      DOM.valSt.textContent = (stVal > 0 ? "+" : "") + stVal;
    }

    if (DOM.valStStatus) {
      DOM.valStStatus.textContent = m.st_status || "Screening";
      if (m.st_status && m.st_status.toLowerCase().includes("elevation")) {
        DOM.valStStatus.className = "st-status-pill st-alert";
      } else {
        DOM.valStStatus.className = "st-status-pill";
      }
    }

    if (DOM.badgeSqi && m.sqi !== undefined) {
      const sqiNum = Number(m.sqi);
      DOM.badgeSqi.textContent = Math.round(sqiNum) + "%";
      if (DOM.sqiBarFill) {
        DOM.sqiBarFill.style.width = Math.min(Math.max(sqiNum, 0), 100) + "%";
        DOM.sqiBarFill.style.backgroundColor = sqiNum < 60 ? "var(--alarm-red)" : sqiNum < 80 ? "var(--alert-amber)" : "var(--ecg-green)";
      }
    }

    // AI Classification
    if (DOM.aiStatusPill && m.ai_label) {
      DOM.aiStatusPill.textContent = m.ai_label;
      const lowerLbl = String(m.ai_label).toLowerCase();
      if (lowerLbl.includes("normal") || lowerLbl.includes("sinus rhythm")) {
        DOM.aiStatusPill.className = "ai-status-pill rhythm-normal";
      } else if (lowerLbl.includes("tachy") || lowerLbl.includes("brady") || lowerLbl.includes("st elevation")) {
        DOM.aiStatusPill.className = "ai-status-pill rhythm-warning";
      } else if (lowerLbl.includes("fibrillation") || lowerLbl.includes("arrhythmia") || lowerLbl.includes("vtach")) {
        DOM.aiStatusPill.className = "ai-status-pill rhythm-critical";
      } else {
        DOM.aiStatusPill.className = "ai-status-pill";
      }
    }

    if (DOM.valAiConfidence && m.ai_confidence != null) {
      DOM.valAiConfidence.textContent = Math.round(Number(m.ai_confidence)) + "%";
    }

    if (DOM.valAiReason && m.ai_reason) {
      DOM.valAiReason.textContent = m.ai_reason;
    }

    // Rhythm flags
    if (DOM.flagBrady) {
      DOM.flagBrady.className = m.bradycardia ? "rhythm-flag flag-active-amber" : "rhythm-flag";
    }
    if (DOM.flagTachy) {
      DOM.flagTachy.className = m.tachycardia ? "rhythm-flag flag-active-amber" : "rhythm-flag";
    }
    if (DOM.flagArrhythmia) {
      DOM.flagArrhythmia.className = m.arrhythmia ? "rhythm-flag flag-active-red" : "rhythm-flag";
    }

    // Event count badge
    if (DOM.eventCountBadge && m.event_count !== undefined) {
      DOM.eventCountBadge.textContent = m.event_count;
    }

    // Audio Alarms
    if (m.alarm_level && window.heartixAudio) {
      window.heartixAudio.setAlarmLevel(m.alarm_level);
      updateAlarmBanner(m.alarm_level, m.status || "CLINICAL ALARM ACTIVE", m.ai_reason || "Physiological abnormality detected");
    }
  }

  function resetEcgBuffers() {
    state.ecgBuffer = [];
    state.renderHead = 0;
    state.sampleQueue = [];
    state.rollingPrintBuffer = [];
  }

  function syncPatientData(p) {
    if (!p) return;
    state.patient.name = p.name || state.patient.name;
    state.patient.age = p.age !== undefined ? p.age : state.patient.age;
    state.patient.gender = p.gender || state.patient.gender;
    state.patient.id = p.patient_id || state.patient.id;
    state.patient.bed = p.bed || state.patient.bed;
    state.patient.minHr = p.min_hr !== undefined ? p.min_hr : state.patient.minHr;
    state.patient.maxHr = p.max_hr !== undefined ? p.max_hr : state.patient.maxHr;
    state.patient.notes = p.notes || state.patient.notes;

    if (DOM.hdrPatientName) DOM.hdrPatientName.textContent = state.patient.name.toUpperCase();
    if (DOM.hdrPatientMeta) DOM.hdrPatientMeta.textContent = `${state.patient.age} yrs | ${state.patient.gender} | Bed ${state.patient.bed}`;
    if (DOM.hdrPatientId) DOM.hdrPatientId.textContent = `ID: ${state.patient.id}`;
    if (DOM.valHrLimits) DOM.valHrLimits.textContent = `${state.patient.minHr}–${state.patient.maxHr}`;
  }

  // --- 60 FPS HOSPITAL SWEEPING ECG CANVAS ENGINE ---
  function initCanvasResize() {
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!DOM.ecgCanvas) return;
    const parent = DOM.ecgCanvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const width = parent.clientWidth;
    const height = parent.clientHeight;

    DOM.ecgCanvas.width = width * dpr;
    DOM.ecgCanvas.height = height * dpr;
    DOM.ecgCanvas.style.width = width + "px";
    DOM.ecgCanvas.style.height = height + "px";

    const ctx = DOM.ecgCanvas.getContext("2d");
    ctx.scale(dpr, dpr);
  }

  function renderLoop() {
    drawEcgCanvas();
    requestAnimationFrame(renderLoop);
  }

  function drawEcgCanvas() {
    const canvas = DOM.ecgCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    // 1. Clear background & draw ECG grid
    ctx.fillStyle = "#04070B";
    ctx.fillRect(0, 0, width, height);

    drawEcgGrid(ctx, width, height);

    // 2. Process incoming sample queue into buffer
    if (!state.frozen && !state.monitoringStopped && state.sampleQueue.length > 0) {
      // Consume up to 8 samples per frame to maintain real-time sync without backlog lag
      const batchSize = Math.min(state.sampleQueue.length, 8);
      for (let i = 0; i < batchSize; i++) {
        const item = state.sampleQueue.shift();
        state.ecgBuffer.push(item);
        state.rollingPrintBuffer.push(item);
        if (state.rollingPrintBuffer.length > 2500) {
          state.rollingPrintBuffer.shift();
        }
      }
    }

    const maxPoints = state.sweepSpeedMmPerSec === 50 ? 625 : 1250; // 250 Hz * 2.5s or 5.0s
    if (state.ecgBuffer.length > maxPoints) {
      state.ecgBuffer = state.ecgBuffer.slice(state.ecgBuffer.length - maxPoints);
    }

    if (state.ecgBuffer.length < 2) return;

    // 3. Determine vertical scaling (Gain)
    let scaleY = height * 0.18; // default 1x
    if (state.gainMode === "2X") scaleY *= 2;
    if (state.gainMode === "AUTO") {
      // Auto-scale based on peak amplitudes in buffer
      let maxAbs = 1.0;
      for (let p of state.ecgBuffer) {
        if (Math.abs(p.sample) > maxAbs) maxAbs = Math.abs(p.sample);
      }
      scaleY = (height * 0.38) / Math.max(maxAbs, 0.5);
    }

    const centerY = height / 2;
    const dx = width / maxPoints;

    // 4. Draw sweeping ECG trace
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = "#00E676"; // Hospital Green
    ctx.shadowColor = "rgba(0, 230, 118, 0.55)";
    ctx.shadowBlur = 6;

    ctx.beginPath();
    for (let i = 0; i < state.ecgBuffer.length; i++) {
      const pt = state.ecgBuffer[i];
      const x = i * dx;
      const y = centerY - (pt.sample * scaleY);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);

      // Trigger QRS beep & heart pulse if R-peak is encountered near write head
      if (pt.rPeak && !state.frozen && state.validSignal && i === state.ecgBuffer.length - 1) {
        triggerHeartBeatFx();
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset shadow

    // 5. Draw R-peak markers (small cyan/red triangles above R peaks)
    ctx.fillStyle = "#38BDF8";
    for (let i = 0; i < state.ecgBuffer.length; i++) {
      const pt = state.ecgBuffer[i];
      if (pt.rPeak) {
        const x = i * dx;
        const y = centerY - (pt.sample * scaleY) - 14;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4, y - 6);
        ctx.lineTo(x + 4, y - 6);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 6. Draw moving eraser/sweep head bar if not frozen
    if (!state.frozen && !state.monitoringStopped) {
      const headX = (state.ecgBuffer.length - 1) * dx;
      ctx.fillStyle = "rgba(0, 230, 118, 0.35)";
      ctx.fillRect(headX, 0, 4, height);
    }
  }

  function drawEcgGrid(ctx, width, height) {
    const minorSize = 5; // mm approx pixels
    const majorSize = 25;

    // Minor grid lines
    ctx.strokeStyle = "rgba(10, 30, 20, 0.4)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x < width; x += minorSize) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += minorSize) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();

    // Major grid lines
    ctx.strokeStyle = "rgba(18, 60, 40, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x += majorSize) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += majorSize) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  function triggerHeartBeatFx() {
    if (window.heartixAudio) {
      window.heartixAudio.playQrsBeep();
    }
    if (DOM.heartIcon) {
      DOM.heartIcon.classList.add("beat-pulse");
      setTimeout(() => {
        if (DOM.heartIcon) DOM.heartIcon.classList.remove("beat-pulse");
      }, 90);
    }
  }

  // --- CONTROLS & SOFT-KEY EVENT LISTENERS ---
  function initEventListeners() {
    // 1. Freeze
    if (DOM.btnFreeze) {
      DOM.btnFreeze.addEventListener("click", () => {
        state.frozen = !state.frozen;
        if (DOM.btnFreeze) DOM.btnFreeze.classList.toggle("active", state.frozen);
        if (DOM.frozenBadge) DOM.frozenBadge.classList.toggle("hidden", !state.frozen);
      });
    }

    // 2. Stop / Run Stream
    if (DOM.btnStop) {
      DOM.btnStop.addEventListener("click", () => {
        state.monitoringStopped = !state.monitoringStopped;
        if (DOM.btnStop) DOM.btnStop.classList.toggle("active", state.monitoringStopped);
        evaluateSystemState();
      });
    }

    // 3. Reset Session
    if (DOM.btnReset) {
      DOM.btnReset.addEventListener("click", async () => {
        try {
          await fetch("/api/session/reset", { method: "POST" });
          resetEcgBuffers();
        } catch (err) {
          console.error("Failed to reset session:", err);
        }
      });
    }

    // 4. Sweep Speed Toggle (25 <-> 50 mm/s)
    if (DOM.btnSpeed) {
      DOM.btnSpeed.addEventListener("click", () => {
        state.sweepSpeedMmPerSec = state.sweepSpeedMmPerSec === 25 ? 50 : 25;
        const sub = DOM.btnSpeed.querySelector(".sk-sub");
        if (sub) sub.textContent = `${state.sweepSpeedMmPerSec} mm/s`;
        if (DOM.metaSpeedGain) {
          DOM.metaSpeedGain.textContent = `${state.sweepSpeedMmPerSec} mm/s | 10 mm/mV`;
        }
      });
    }

    // 5. Gain Toggle (AUTO -> 1X -> 2X)
    if (DOM.btnGain) {
      DOM.btnGain.addEventListener("click", () => {
        if (state.gainMode === "AUTO") state.gainMode = "1X";
        else if (state.gainMode === "1X") state.gainMode = "2X";
        else state.gainMode = "AUTO";

        const sub = DOM.btnGain.querySelector(".sk-sub");
        if (sub) sub.textContent = `GAIN: ${state.gainMode}`;
      });
    }

    // 6. QRS Tone Toggle
    if (DOM.btnQrsBeep) {
      DOM.btnQrsBeep.addEventListener("click", () => {
        state.qrsBeepOn = !state.qrsBeepOn;
        if (window.heartixAudio) {
          window.heartixAudio.setQrsBeepEnabled(state.qrsBeepOn);
        }
        DOM.btnQrsBeep.classList.toggle("active", state.qrsBeepOn);
        const sub = DOM.btnQrsBeep.querySelector(".sk-sub");
        if (sub) sub.textContent = state.qrsBeepOn ? "ON" : "OFF";
      });
    }

    // 7. Audio Pause / Mute Alarms (120-sec countdown)
    if (DOM.btnMuteAlarms) {
      DOM.btnMuteAlarms.addEventListener("click", () => {
        if (!window.heartixAudio) return;
        window.heartixAudio.unlock();
        window.heartixAudio.toggleMute2Min((remainingSec) => {
          const topEl = DOM.btnMuteAlarms.querySelector(".sk-top");
          const subEl = DOM.btnMuteAlarms.querySelector(".sk-sub");
          if (remainingSec > 0) {
            const mins = Math.floor(remainingSec / 60);
            const secs = remainingSec % 60;
            if (topEl) topEl.textContent = "MUTE ACTIVE";
            if (subEl) subEl.textContent = `${mins}:${String(secs).padStart(2, "0")}`;
            DOM.btnMuteAlarms.classList.add("muted-active");
          } else {
            if (topEl) topEl.textContent = "AUDIO PAUSE";
            if (subEl) subEl.textContent = "2 MIN MUTE";
            DOM.btnMuteAlarms.classList.remove("muted-active");
          }
        });
      });
    }

    // 8. Events Drawer
    if (DOM.btnEvents) {
      DOM.btnEvents.addEventListener("click", () => {
        openEventsDrawer();
      });
    }
    if (DOM.btnCloseEvents) {
      DOM.btnCloseEvents.addEventListener("click", () => {
        if (DOM.eventsDrawer) DOM.eventsDrawer.classList.add("hidden");
      });
    }

    // 9. Export CSV
    if (DOM.btnSaveCsv) {
      DOM.btnSaveCsv.addEventListener("click", () => {
        window.location.href = "/api/export/csv";
      });
    }

    // 10. PDF Report / Print
    if (DOM.btnPdfReport) {
      DOM.btnPdfReport.addEventListener("click", () => {
        generatePrintReport();
      });
    }

    // 11. Patient Modal
    if (DOM.btnPatient) {
      DOM.btnPatient.addEventListener("click", () => {
        openPatientModal();
      });
    }

    // 12. Lab Test Simulator Bar Toggle
    if (DOM.btnLabTest) {
      DOM.btnLabTest.addEventListener("click", () => {
        if (state.esp32Connected) return; // disabled when hardware connected
        const isHidden = DOM.labTestBar.classList.contains("hidden");
        if (isHidden) {
          DOM.labTestBar.classList.remove("hidden");
          DOM.btnLabTest.classList.add("active");
        } else {
          DOM.labTestBar.classList.add("hidden");
          DOM.btnLabTest.classList.remove("active");
        }
      });
    }

    // Lab Test Mode buttons
    const simButtons = document.querySelectorAll("[data-sim-mode]");
    simButtons.forEach(btn => {
      btn.addEventListener("click", (e) => {
        const mode = e.currentTarget.getAttribute("data-sim-mode");
        simButtons.forEach(b => b.classList.remove("active"));
        e.currentTarget.classList.add("active");
        sendWsCommand("simulate", { mode });
        state.simMode = true;
        applyHardwarePriorityUI();
      });
    });

    if (DOM.btnSimStop) {
      DOM.btnSimStop.addEventListener("click", () => {
        simButtons.forEach(b => b.classList.remove("active"));
        sendWsCommand("stop_sim");
        state.simMode = false;
        applyHardwarePriorityUI();
      });
    }

    // Patient Form Submission
    if (DOM.patientForm) {
      DOM.patientForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await submitPatientAdmission(false);
      });
    }

    if (DOM.btnGuestMode) {
      DOM.btnGuestMode.addEventListener("click", async () => {
        await submitPatientAdmission(true);
      });
    }
  }

  // --- PATIENT ADMISSION MODAL HANDLERS ---
  function openPatientModal() {
    if (DOM.patientModal) DOM.patientModal.classList.remove("hidden");
  }

  async function submitPatientAdmission(isGuest) {
    if (window.heartixAudio) {
      window.heartixAudio.unlock();
    }

    let patientPayload = {
      name: state.patient.name,
      age: Number(state.patient.age) || 45,
      gender: state.patient.gender,
      patient_id: state.patient.id,
      bed: state.patient.bed,
      min_hr: Number(state.patient.minHr) || 60,
      max_hr: Number(state.patient.maxHr) || 100,
      notes: state.patient.notes
    };

    if (!isGuest && DOM.patientForm) {
      patientPayload = {
        name: DOM.inpPatientName.value || "Aarav Sharma",
        age: Number(DOM.inpPatientAge.value) || 45,
        gender: DOM.inpPatientGender.value || "Male",
        patient_id: DOM.inpPatientId.value || "HTX-2026-001",
        bed: DOM.inpPatientBed.value || "ICU-01",
        min_hr: Number(DOM.inpMinHr.value) || 60,
        max_hr: Number(DOM.inpMaxHr.value) || 100,
        notes: DOM.inpNotes.value || ""
      };
    }

    try {
      const res = await fetch("/api/patient", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patientPayload)
      });
      if (res.ok) {
        const data = await res.json();
        syncPatientData(data.patient || patientPayload);
      }
    } catch (err) {
      console.error("Failed to submit patient admission:", err);
      syncPatientData(patientPayload);
    }

    if (DOM.patientModal) {
      DOM.patientModal.classList.add("hidden");
    }
  }

  // --- EVENTS DRAWER & SNAPSHOT VIEWER ---
  async function openEventsDrawer() {
    if (DOM.eventsDrawer) DOM.eventsDrawer.classList.remove("hidden");
    try {
      const res = await fetch("/api/events");
      if (res.ok) {
        const data = await res.json();
        state.eventsListCache = data.events || [];
        renderEventsList(state.eventsListCache);
      }
    } catch (err) {
      console.error("Failed to fetch events log:", err);
    }
  }

  function renderEventsList(events) {
    if (!DOM.eventsList) return;
    if (!events || events.length === 0) {
      DOM.eventsList.innerHTML = `<div class="empty-events">No clinical arrhythmia or threshold events recorded in current session.</div>`;
      return;
    }

    DOM.eventsList.innerHTML = events.map((ev, idx) => `
      <div class="event-item ${ev.severity === 'high' ? 'severity-high' : ''}" data-index="${idx}">
        <div style="display:flex; justify-content:space-between; font-weight:700; font-size:12px; margin-bottom:3px;">
          <span style="color:var(--text-primary);">${ev.type || 'CLINICAL EVENT'}</span>
          <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);">${ev.timestamp || '--:--:--'}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary);">${ev.description || ev.reason || 'Telemetry threshold breach'}</div>
      </div>
    `).join("");

    const itemEls = DOM.eventsList.querySelectorAll(".event-item");
    itemEls.forEach(el => {
      el.addEventListener("click", (e) => {
        itemEls.forEach(i => i.classList.remove("selected"));
        e.currentTarget.classList.add("selected");
        const idx = Number(e.currentTarget.getAttribute("data-index"));
        renderEventSnapshot(events[idx]);
      });
    });

    // Auto-select first event if available
    if (events.length > 0) {
      itemEls[0].classList.add("selected");
      renderEventSnapshot(events[0]);
    }
  }

  function renderEventSnapshot(ev) {
    if (DOM.eventSnapshotMeta) {
      DOM.eventSnapshotMeta.textContent = `${ev.type} @ ${ev.timestamp} (${ev.severity || 'medium'} severity)`;
    }
    const canvas = DOM.eventSnapshotCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.clientWidth || 380;
    const height = canvas.clientHeight || 120;
    canvas.width = width * (window.devicePixelRatio || 1);
    canvas.height = height * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    ctx.fillStyle = "#04070B";
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = "rgba(10, 30, 20, 0.5)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < width; x += 20) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += 20) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();

    // Plot waveform snapshot samples if present in event, else sample rolling buffer
    const samples = (ev.waveform_strip && ev.waveform_strip.length > 0) 
      ? ev.waveform_strip 
      : state.rollingPrintBuffer.map(p => p.sample).slice(-300);

    if (!samples || samples.length === 0) return;

    const dx = width / samples.length;
    const centerY = height / 2;
    ctx.strokeStyle = "#38BDF8";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const val = typeof samples[i] === 'object' ? samples[i].sample : samples[i];
      const x = i * dx;
      const y = centerY - (val * (height * 0.28));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- PDF REPORT & PRINT STYLESHEET GENERATOR ---
  function generatePrintReport() {
    if (DOM.printTimestamp) {
      DOM.printTimestamp.textContent = new Date().toLocaleString();
    }

    if (DOM.printPatientInfo) {
      DOM.printPatientInfo.innerHTML = `
        <div><strong>Patient Name:</strong> ${state.patient.name}</div>
        <div><strong>Patient ID:</strong> ${state.patient.id}</div>
        <div><strong>Age / Gender:</strong> ${state.patient.age} yrs / ${state.patient.gender}</div>
        <div><strong>Bed / Ward:</strong> ${state.patient.bed}</div>
      `;
    }

    // Render static pink-grid ECG strip canvas for print
    const printCanvas = DOM.printEcgCanvas;
    if (printCanvas) {
      const width = printCanvas.clientWidth || 900;
      const height = printCanvas.clientHeight || 190;
      printCanvas.width = width * (window.devicePixelRatio || 1);
      printCanvas.height = height * (window.devicePixelRatio || 1);
      const ctx = printCanvas.getContext("2d");
      ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

      ctx.fillStyle = "#FFF5F5";
      ctx.fillRect(0, 0, width, height);

      // Pink ECG grid lines
      ctx.strokeStyle = "rgba(225, 29, 72, 0.22)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let x = 0; x < width; x += 25) {
        ctx.moveTo(x, 0); ctx.lineTo(x, height);
      }
      for (let y = 0; y < height; y += 25) {
        ctx.moveTo(0, y); ctx.lineTo(width, y);
      }
      ctx.stroke();

      const printSamples = state.rollingPrintBuffer.length > 0 
        ? state.rollingPrintBuffer 
        : state.ecgBuffer;

      if (printSamples.length > 0) {
        const dx = width / Math.max(printSamples.length, 1250);
        const centerY = height / 2;
        ctx.strokeStyle = "#9F1239"; // Rose / Magenta clinical trace
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < printSamples.length; i++) {
          const pt = printSamples[i];
          const val = typeof pt === 'object' ? pt.sample : pt;
          const x = i * dx;
          const y = centerY - (val * (height * 0.3));
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // Populate Metrics Summary Table
    if (DOM.printMetricsTable) {
      DOM.printMetricsTable.innerHTML = `
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Measured Value</th>
            <th>Clinical Reference Range</th>
            <th>Status / Screening</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Heart Rate (HR)</td>
            <td><strong>${DOM.valBpm ? DOM.valBpm.textContent : '---'} BPM</strong></td>
            <td>60 – 100 BPM</td>
            <td>${state.patient.minHr}–${state.patient.maxHr} limit configured</td>
          </tr>
          <tr>
            <td>R-R Interval</td>
            <td>${DOM.valRr ? DOM.valRr.textContent : '---'} ms</td>
            <td>600 – 1000 ms</td>
            <td>Normal Sinus Interval</td>
          </tr>
          <tr>
            <td>HRV (RMSSD)</td>
            <td>${DOM.valHrv ? DOM.valHrv.textContent : '---'} ms</td>
            <td>20 – 200 ms</td>
            <td>Autonomic Tone Index</td>
          </tr>
          <tr>
            <td>QRS Duration</td>
            <td>${DOM.valQrs ? DOM.valQrs.textContent : '---'} ms</td>
            <td>60 – 100 ms</td>
            <td>Intraventricular Conduction</td>
          </tr>
          <tr>
            <td>ST Segment Deviation</td>
            <td>${DOM.valSt ? DOM.valSt.textContent : '---'} mV</td>
            <td>-0.05 to +0.10 mV</td>
            <td>${DOM.valStStatus ? DOM.valStStatus.textContent : 'Screening'}</td>
          </tr>
          <tr>
            <td>Signal Quality Index (SQI)</td>
            <td>${DOM.badgeSqi ? DOM.badgeSqi.textContent : '---'}</td>
            <td>> 80%</td>
            <td>Artifact Free Telemetry</td>
          </tr>
          <tr>
            <td>AI Rhythm Classification</td>
            <td><strong>${DOM.aiStatusPill ? DOM.aiStatusPill.textContent : '---'}</strong></td>
            <td>Normal Sinus</td>
            <td>Confidence: ${DOM.valAiConfidence ? DOM.valAiConfidence.textContent : '---'}</td>
          </tr>
        </tbody>
      `;
    }

    // Populate Events Table
    if (DOM.printEventsTable) {
      const events = state.eventsListCache || [];
      if (events.length === 0) {
        DOM.printEventsTable.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#64748B;">No clinical alarms or abnormality episodes recorded during session.</td></tr>`;
      } else {
        DOM.printEventsTable.innerHTML = `
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Episode Type</th>
              <th>Clinical Details / Reason</th>
            </tr>
          </thead>
          <tbody>
            ${events.map(ev => `
              <tr>
                <td>${ev.timestamp || '--'}</td>
                <td><strong>${ev.type || 'ALARM'}</strong></td>
                <td>${ev.description || ev.reason || 'Threshold breach'}</td>
              </tr>
            `).join("")}
          </tbody>
        `;
      }
    }

    // Trigger browser print dialog
    setTimeout(() => {
      window.print();
    }, 350);
  }

})();