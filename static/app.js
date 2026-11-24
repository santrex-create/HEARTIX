/**
 * HEARTIX — Phase 4: Live ECG Canvas, WebSocket Engine & Monitor Controls
 * Continuous parameter visibility (no <60% SQI lockout), rolling baseline centering,
 * 60-sec HR sparkline, Poincare R-R plot, 1 mV CAL pulse, PNG export, and observer links.
 */

(function () {
  "use strict";

  const urlParams = new URLSearchParams(window.location.search);

  // --- STATE MANAGEMENT ---
  const state = {
    serverConnected: false,
    esp32Connected: false,
    simMode: false,
    monitoringStopped: false,
    frozen: false,
    leadsOff: false,
    validSignal: false,
    observerMode: urlParams.get("mode") === "observer",
    adminPin: urlParams.get("pin") || "",
    pinRequired: false,

    // Display configuration
    sweepSpeedMmPerSec: 25, // 25 or 50 mm/s
    gainMode: "AUTO",       // "AUTO", "1X", "2X"
    calPulseOn: true,
    qrsBeepOn: true,
    poincareVisible: false,

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
      pvcCount: 0,
      eventCount: 0,
      alarmLevel: "none"
    },

    // ECG Sample Buffers (250 Hz sample rate)
    ecgBuffer: [],
    rollingPrintBuffer: [],
    sampleQueue: [],

    // Trend & Poincare buffers
    hrHistory: [],
    rrHistory: [],

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
      "hdrPatientName", "hdrPatientMeta", "hdrPatientId", "observerBadge",
      "badgeServer", "badgeEsp32", "badgePacketLoss", "badgeSqi", "sqiBarFill",
      "btnShareObserver", "hdrClock",
      "alarmBanner", "alarmText", "alarmReason", "simWatermark",
      "ecgCanvas", "metaSpeedGain", "metaSource", "canvasOverlay", "canvasOverlayTitle", "canvasOverlaySub", "frozenBadge",
      "heartIcon", "valBpm", "valHrLimits", "hrSparklineCanvas",
      "valRr", "valHrv", "btnTogglePoincare", "poincareWrap", "poincareCanvas",
      "valQrs", "valSt", "valStStatus",
      "aiStatusPill", "valAiConfidence", "valAiReason", "flagBrady", "flagTachy", "flagArrhythmia", "flagPvc",
      "btnFreeze", "btnStop", "btnReset", "btnSaveCsv", "btnSavePng", "btnPdfReport", "btnMuteAlarms",
      "btnQrsBeep", "btnSpeed", "btnGain", "btnCalPulse", "btnEvents", "eventCountBadge", "btnPatient", "btnLabTest",
      "labTestBar", "btnSimStop",
      "patientModal", "patientForm", "inpPatientName", "inpPatientAge", "inpPatientGender",
      "inpPatientId", "inpPatientBed", "inpMinHr", "inpMaxHr", "inpNotes", "btnStartMonitoring", "btnGuestMode",
      "eventsDrawer", "btnCloseEvents", "eventsList", "eventSnapshotCanvas", "eventSnapshotMeta",
      "printReportContainer", "printPatientInfo", "printEcgCanvas", "printMetricsTable", "printEventsTable", "printTimestamp"
    ];

    ids.forEach((id) => {
      DOM[id] = document.getElementById(id);
    });
  }

  // --- INITIALIZATION & CLOCK ---
  window.addEventListener("DOMContentLoaded", () => {
    cacheDomElements();
    applyObserverPermissions();
    initPatientIdPlaceholder();
    initClock();
    initWebSocket();
    initEventListeners();
    initCanvasResize();
    requestAnimationFrame(renderLoop);
  });

  function applyObserverPermissions() {
    if (!state.observerMode) return;
    if (DOM.observerBadge) DOM.observerBadge.classList.remove("hidden");
    if (DOM.patientModal) DOM.patientModal.classList.add("hidden");
    if (DOM.btnReset) DOM.btnReset.disabled = true;
    if (DOM.btnPatient) DOM.btnPatient.disabled = true;
    if (DOM.btnLabTest) DOM.btnLabTest.disabled = true;
  }

  function ensureAdminPin() {
    if (!state.pinRequired || state.adminPin) return true;
    const entered = window.prompt("Enter HEARTIX Admin PIN to unlock bedside controls:");
    if (!entered) return false;
    state.adminPin = entered.trim();
    return Boolean(state.adminPin);
  }

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
        DOM.hdrClock.textContent =
          now.toTimeString().split(" ")[0] +
          "." +
          String(now.getMilliseconds()).padStart(3, "0").slice(0, 2);
      }
    }, 50);
  }

  // --- WEBSOCKET ENGINE WITH EXPONENTIAL BACKOFF ---
  function initWebSocket() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const modeParam = state.observerMode ? "observer" : "operator";
    const pinParam = state.adminPin ? `&pin=${encodeURIComponent(state.adminPin)}` : "";
    const wsUrl = `${proto}//${location.host}/ws/web?mode=${modeParam}${pinParam}`;

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

    state.ws.onerror = () => {
      try {
        state.ws.close();
      } catch (e) {}
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
        state.pinRequired = Boolean(msg.pin_required);
        if (msg.observer_mode) {
          state.observerMode = true;
          applyObserverPermissions();
        }
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

        if (msg.source && DOM.metaSource) {
          DOM.metaSource.textContent = `SOURCE: ${String(msg.source).toUpperCase()}`;
        }

        if (Array.isArray(msg.samples)) {
          // r_peak_offsets contains sample indices within the 25-sample batch (e.g., [14])
          const rPeakSet = new Set(Array.isArray(msg.r_peak_offsets) ? msg.r_peak_offsets : []);
          for (let i = 0; i < msg.samples.length; i++) {
            const sampleVal = msg.samples[i];
            const isRPeak = rPeakSet.has(i);
            state.sampleQueue.push({
              sample: sampleVal,
              rPeak: isRPeak,
              timestamp: Date.now()
            });
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
      state.ws.send(JSON.stringify({ action, pin: state.adminPin, ...payload }));
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

      blankAllMetrics();
      if (window.heartixAudio) {
        window.heartixAudio.setAlarmLevel("none");
      }
      updateAlarmBanner("none", "SYSTEM STANDBY — NO ACTIVE CLINICAL ALARMS", "Awaiting physiological telemetry stream");
      return;
    }

    // Only block display when hardware leads are physically detached (LO+ / LO- HIGH).
    // Never hide parameters for SQI < 60% or calibration states.
    if (state.leadsOff) {
      if (DOM.canvasOverlay) DOM.canvasOverlay.classList.remove("hidden");
      if (DOM.canvasOverlayTitle) {
        DOM.canvasOverlayTitle.textContent = "LEADS OFF — CHECK ELECTRODE CONTACT";
      }
      if (DOM.canvasOverlaySub) {
        DOM.canvasOverlaySub.textContent = "Ensure patient electrodes and Lead II placement are secure.";
      }

      blankDerivedMetrics();
      if (window.heartixAudio) {
        window.heartixAudio.triggerTechnicalAlert();
        window.heartixAudio.setAlarmLevel("technical");
      }
      updateAlarmBanner("technical", "TECHNICAL ALERT — LEADS OFF / POOR CONTACT", "Verify Lead II ECG electrode impedance");
      return;
    }

    if (DOM.canvasOverlay) DOM.canvasOverlay.classList.add("hidden");
  }

  function blankAllMetrics() {
    const ids = ["valBpm", "valRr", "valHrv", "valQrs", "valSt", "badgeSqi", "valAiConfidence"];
    ids.forEach((id) => {
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
    const ids = ["valBpm", "valRr", "valHrv", "valQrs", "valSt", "badgeSqi", "valAiConfidence"];
    ids.forEach((id) => {
      if (DOM[id]) DOM[id].textContent = "---";
    });
    if (DOM.sqiBarFill) DOM.sqiBarFill.style.width = "0%";
    resetRhythmFlags();
  }

  function resetRhythmFlags() {
    ["flagBrady", "flagTachy", "flagArrhythmia", "flagPvc"].forEach((id) => {
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

    if (DOM.valBpm) {
      DOM.valBpm.textContent = m.bpm !== undefined && m.bpm !== null ? m.bpm : "---";
    }
    if (DOM.valRr) {
      DOM.valRr.textContent = m.rr_ms !== undefined && m.rr_ms !== null ? m.rr_ms : "---";
    }
    if (DOM.valHrv) {
      DOM.valHrv.textContent = m.hrv_ms !== undefined && m.hrv_ms !== null ? m.hrv_ms : "---";
    }
    if (DOM.valQrs) {
      DOM.valQrs.textContent = m.qrs_ms !== undefined && m.qrs_ms !== null ? m.qrs_ms : "---";
    }

    if (DOM.valSt) {
      if (m.st_mv !== undefined && m.st_mv !== null) {
        const stNum = Number(m.st_mv);
        DOM.valSt.textContent = (stNum > 0 ? "+" : "") + stNum.toFixed(2);
      } else {
        DOM.valSt.textContent = "---";
      }
    }

    if (DOM.valStStatus) {
      DOM.valStStatus.textContent = m.st_status || "Screening";
      if (
        m.st_status &&
        (m.st_status.toLowerCase().includes("elevat") || m.st_status.toLowerCase().includes("depress"))
      ) {
        DOM.valStStatus.className = "st-status-pill st-alert";
      } else {
        DOM.valStStatus.className = "st-status-pill";
      }
    }

    // Passive Color-Coded SQI Indicator (never gates parameter display)
    if (DOM.badgeSqi && m.sqi !== undefined && m.sqi !== null) {
      const sqiNum = Number(m.sqi);
      DOM.badgeSqi.textContent = Math.round(sqiNum) + "%";
      if (DOM.sqiBarFill) {
        DOM.sqiBarFill.style.width = Math.min(Math.max(sqiNum, 0), 100) + "%";
        DOM.sqiBarFill.style.backgroundColor =
          sqiNum < 40
            ? "var(--alarm-red)"
            : sqiNum < 75
              ? "var(--alert-amber)"
              : "var(--ecg-green)";
      }
    }

    // Update 60s HR sparkline and Poincare RR buffers
    if (m.bpm !== undefined && m.bpm !== null && Number(m.bpm) > 0) {
      state.hrHistory.push(Number(m.bpm));
      if (state.hrHistory.length > 60) state.hrHistory.shift();
      drawHrSparkline();
    }
    if (m.rr_ms !== undefined && m.rr_ms !== null && Number(m.rr_ms) > 0) {
      state.rrHistory.push(Number(m.rr_ms));
      if (state.rrHistory.length > 45) state.rrHistory.shift();
      if (state.poincareVisible) drawPoincarePlot();
    }

    // AI Classification
    if (DOM.aiStatusPill && m.ai_label) {
      DOM.aiStatusPill.textContent = m.ai_label;
      const lowerLbl = String(m.ai_label).toLowerCase();
      if (lowerLbl.includes("normal") || lowerLbl.includes("sinus rhythm")) {
        DOM.aiStatusPill.className = "ai-status-pill rhythm-normal";
      } else if (
        lowerLbl.includes("tachy") ||
        lowerLbl.includes("brady") ||
        lowerLbl.includes("st segment") ||
        lowerLbl.includes("artifact")
      ) {
        DOM.aiStatusPill.className = "ai-status-pill rhythm-warning";
      } else if (
        lowerLbl.includes("fibrillation") ||
        lowerLbl.includes("arrhythmia") ||
        lowerLbl.includes("vtach")
      ) {
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
    if (DOM.flagPvc) {
      const hasPvc = Number(m.pvc_count || 0) > 0;
      DOM.flagPvc.className = hasPvc ? "rhythm-flag flag-active-amber" : "rhythm-flag";
      DOM.flagPvc.textContent = hasPvc ? `PVC (${m.pvc_count})` : "PVC";
    }

    if (DOM.eventCountBadge && m.event_count !== undefined) {
      DOM.eventCountBadge.textContent = m.event_count;
    }

    // Audio Alarms & Banner
    if (m.alarm_level && window.heartixAudio) {
      window.heartixAudio.setAlarmLevel(m.alarm_level);
      const bannerTitle =
        m.alarm_level === "none"
          ? `MONITORING ACTIVE — ${m.ai_label || "SINUS RHYTHM"}`
          : m.status || "CLINICAL ALARM ACTIVE";
      updateAlarmBanner(
        m.alarm_level,
        bannerTitle,
        m.ai_reason || "Real-time telemetry active"
      );
    }
  }

  function resetEcgBuffers() {
    state.ecgBuffer = [];
    state.sampleQueue = [];
    state.rollingPrintBuffer = [];
    state.hrHistory = [];
    state.rrHistory = [];
    drawHrSparkline();
    if (state.poincareVisible) drawPoincarePlot();
  }

  function syncPatientData(p) {
    if (!p) return;
    state.patient.name = p.name || state.patient.name;
    state.patient.age = p.age !== undefined && p.age !== null ? p.age : state.patient.age;
    state.patient.gender = p.gender || state.patient.gender;
    state.patient.id = p.patient_id || state.patient.id;
    state.patient.bed = p.bed || state.patient.bed;
    state.patient.minHr = p.min_hr !== undefined ? p.min_hr : state.patient.minHr;
    state.patient.maxHr = p.max_hr !== undefined ? p.max_hr : state.patient.maxHr;
    state.patient.notes = p.notes || state.patient.notes;

    if (DOM.hdrPatientName) DOM.hdrPatientName.textContent = state.patient.name.toUpperCase();
    if (DOM.hdrPatientMeta) {
      DOM.hdrPatientMeta.textContent = `${state.patient.age} yrs | ${state.patient.gender} | Bed ${state.patient.bed}`;
    }
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderLoop() {
    drawEcgCanvas();
    requestAnimationFrame(renderLoop);
  }

  function computeRollingBaseline(samples) {
    if (!samples || samples.length === 0) return 0;
    const sorted = samples.map((p) => p.sample).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function drawEcgCanvas() {
    const canvas = DOM.ecgCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.fillStyle = "#04070B";
    ctx.fillRect(0, 0, width, height);

    drawEcgGrid(ctx, width, height);

    if (!state.frozen && !state.monitoringStopped && state.sampleQueue.length > 0) {
      const batchSize = Math.min(state.sampleQueue.length, 8);
      for (let i = 0; i < batchSize; i++) {
        const item = state.sampleQueue.shift();
        state.ecgBuffer.push(item);
        state.rollingPrintBuffer.push(item);
        if (state.rollingPrintBuffer.length > 2500) {
          state.rollingPrintBuffer.shift();
        }
        if (item.rPeak && !state.leadsOff) {
          triggerHeartBeatFx();
        }
      }
    }

    const maxPoints = state.sweepSpeedMmPerSec === 50 ? 625 : 1250;
    if (state.ecgBuffer.length > maxPoints) {
      state.ecgBuffer = state.ecgBuffer.slice(state.ecgBuffer.length - maxPoints);
    }

    // Auto-center baseline via rolling median
    const baselineOffset = computeRollingBaseline(state.ecgBuffer);

    // Determine vertical scaling (Gain)
    let scaleY = height * 0.22; // 1X (10 mm/mV equivalent)
    if (state.gainMode === "2X") {
      scaleY *= 2.0;
    } else if (state.gainMode === "AUTO" && state.ecgBuffer.length > 1) {
      let maxAbs = 0.6;
      for (let p of state.ecgBuffer) {
        const dev = Math.abs(p.sample - baselineOffset);
        if (dev > maxAbs) maxAbs = dev;
      }
      scaleY = (height * 0.38) / Math.max(maxAbs, 0.35);
    }

    const centerY = height / 2;

    // Draw standard 1.0 mV calibration square-wave pulse on left edge
    if (state.calPulseOn) {
      drawCalibrationPulse(ctx, centerY, scaleY);
    }

    if (state.ecgBuffer.length < 2) return;

    const plotStartX = state.calPulseOn ? 38 : 0;
    const plotWidth = Math.max(50, width - plotStartX);
    const dx = plotWidth / maxPoints;

    // Draw sweeping ECG trace
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = "#00E676";
    ctx.shadowColor = "rgba(0, 230, 118, 0.55)";
    ctx.shadowBlur = 6;

    ctx.beginPath();
    for (let i = 0; i < state.ecgBuffer.length; i++) {
      const pt = state.ecgBuffer[i];
      const x = plotStartX + i * dx;
      const y = centerY - (pt.sample - baselineOffset) * scaleY;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw R-peak markers (small cyan triangles above R peaks)
    ctx.fillStyle = "#38BDF8";
    for (let i = 0; i < state.ecgBuffer.length; i++) {
      const pt = state.ecgBuffer[i];
      if (pt.rPeak) {
        const x = plotStartX + i * dx;
        const y = Math.max(12, centerY - (pt.sample - baselineOffset) * scaleY - 12);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4, y - 6);
        ctx.lineTo(x + 4, y - 6);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Draw moving sweep bar
    if (!state.frozen && !state.monitoringStopped) {
      const headX = plotStartX + (state.ecgBuffer.length - 1) * dx;
      ctx.fillStyle = "rgba(0, 230, 118, 0.35)";
      ctx.fillRect(headX, 0, 4, height);
    }
  }

  function drawCalibrationPulse(ctx, centerY, scaleY) {
    const pulseHeight = 1.0 * scaleY; // 1.0 mV height
    ctx.save();
    ctx.strokeStyle = "#38BDF8";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(6, centerY);
    ctx.lineTo(12, centerY);
    ctx.lineTo(12, centerY - pulseHeight);
    ctx.lineTo(26, centerY - pulseHeight);
    ctx.lineTo(26, centerY);
    ctx.lineTo(32, centerY);
    ctx.stroke();

    ctx.fillStyle = "#64748B";
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText("1mV", 9, centerY + 12);
    ctx.restore();
  }

  function drawEcgGrid(ctx, width, height) {
    const minorSize = 5;
    const majorSize = 25;

    ctx.strokeStyle = "rgba(10, 30, 20, 0.4)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x < width; x += minorSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += minorSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(18, 60, 40, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x += majorSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += majorSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  function drawHrSparkline() {
    const canvas = DOM.hrSparklineCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);
    if (state.hrHistory.length < 2) return;

    const minVal = Math.max(30, Math.min(...state.hrHistory) - 5);
    const maxVal = Math.min(220, Math.max(...state.hrHistory) + 5);
    const span = Math.max(10, maxVal - minVal);
    const dx = w / Math.max(59, state.hrHistory.length - 1);

    ctx.strokeStyle = "#00E676";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    state.hrHistory.forEach((bpm, idx) => {
      const x = idx * dx;
      const y = h - 3 - ((bpm - minVal) / span) * (h - 6);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawPoincarePlot() {
    const canvas = DOM.poincareCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 240;
    const h = canvas.clientHeight || 110;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#04070B";
    ctx.fillRect(0, 0, w, h);

    // Line of identity (RR[n] == RR[n+1])
    ctx.strokeStyle = "rgba(100, 116, 139, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, h - 8);
    ctx.lineTo(w - 8, 8);
    ctx.stroke();

    if (state.rrHistory.length < 2) return;

    const minRr = 300;
    const maxRr = 1500;
    const mapX = (rr) => 8 + ((Math.min(Math.max(rr, minRr), maxRr) - minRr) / (maxRr - minRr)) * (w - 16);
    const mapY = (rr) => h - 8 - ((Math.min(Math.max(rr, minRr), maxRr) - minRr) / (maxRr - minRr)) * (h - 16);

    for (let i = 0; i < state.rrHistory.length - 1; i++) {
      const x = mapX(state.rrHistory[i]);
      const y = mapY(state.rrHistory[i + 1]);
      const isLatest = i === state.rrHistory.length - 2;
      ctx.fillStyle = isLatest ? "#00E676" : "rgba(56, 189, 248, 0.75)";
      ctx.beginPath();
      ctx.arc(x, y, isLatest ? 3.5 : 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
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

  function updateMetaChip() {
    if (DOM.metaSpeedGain) {
      DOM.metaSpeedGain.textContent = `${state.sweepSpeedMmPerSec} mm/s | GAIN: ${state.gainMode}`;
    }
  }

  function saveCanvasPngSnapshot() {
    if (!DOM.ecgCanvas) return;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = DOM.ecgCanvas.width;
    exportCanvas.height = DOM.ecgCanvas.height + 44;
    const ctx = exportCanvas.getContext("2d");

    ctx.fillStyle = "#0B111B";
    ctx.fillRect(0, 0, exportCanvas.width, 44);
    ctx.fillStyle = "#F1F5F9";
    ctx.font = 'bold 14px "JetBrains Mono", monospace';
    const bpmTxt = DOM.valBpm ? DOM.valBpm.textContent : "---";
    const sqiTxt = DOM.badgeSqi ? DOM.badgeSqi.textContent : "---";
    const aiTxt = DOM.aiStatusPill ? DOM.aiStatusPill.textContent : "---";
    ctx.fillText(
      `HEARTIX ECG | ${state.patient.name} (${state.patient.id}) | HR: ${bpmTxt} BPM | SQI: ${sqiTxt} | ${aiTxt} | ${new Date().toLocaleTimeString()}`,
      14,
      27
    );

    ctx.drawImage(DOM.ecgCanvas, 0, 44);

    const link = document.createElement("a");
    link.download = `heartix_ecg_${Date.now()}.png`;
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  }

  // --- CONTROLS & SOFT-KEY EVENT LISTENERS ---
  function initEventListeners() {
    // Share Read-Only Observer URL
    if (DOM.btnShareObserver) {
      DOM.btnShareObserver.addEventListener("click", async () => {
        const shareUrl = `${location.origin}/?mode=observer`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          DOM.btnShareObserver.textContent = "LINK COPIED!";
          setTimeout(() => {
            DOM.btnShareObserver.textContent = "SHARE VIEW";
          }, 2000);
        } catch (err) {
          window.prompt("Copy read-only observer link:", shareUrl);
        }
      });
    }

    // Poincare Toggle
    if (DOM.btnTogglePoincare) {
      DOM.btnTogglePoincare.addEventListener("click", () => {
        state.poincareVisible = !state.poincareVisible;
        DOM.btnTogglePoincare.classList.toggle("active", state.poincareVisible);
        if (DOM.poincareWrap) {
          DOM.poincareWrap.classList.toggle("hidden", !state.poincareVisible);
        }
        if (state.poincareVisible) drawPoincarePlot();
      });
    }

    // 1. Freeze
    if (DOM.btnFreeze) {
      DOM.btnFreeze.addEventListener("click", () => {
        state.frozen = !state.frozen;
        DOM.btnFreeze.classList.toggle("active", state.frozen);
        if (DOM.frozenBadge) DOM.frozenBadge.classList.toggle("hidden", !state.frozen);
      });
    }

    // 2. Stop / Run Stream
    if (DOM.btnStop) {
      DOM.btnStop.addEventListener("click", () => {
        state.monitoringStopped = !state.monitoringStopped;
        DOM.btnStop.classList.toggle("active", state.monitoringStopped);
        evaluateSystemState();
      });
    }

    // 3. Reset Session
    if (DOM.btnReset) {
      DOM.btnReset.addEventListener("click", async () => {
        if (state.observerMode || !ensureAdminPin()) return;
        try {
          const headers = state.adminPin ? { "X-Admin-Pin": state.adminPin } : {};
          const res = await fetch("/api/session/reset", { method: "POST", headers });
          if (res.status === 403) {
            state.adminPin = "";
            alert("Invalid Admin PIN.");
            return;
          }
          resetEcgBuffers();
        } catch (err) {
          console.error("Failed to reset session:", err);
        }
      });
    }

    // 4. Sweep Speed Toggle
    if (DOM.btnSpeed) {
      DOM.btnSpeed.addEventListener("click", () => {
        state.sweepSpeedMmPerSec = state.sweepSpeedMmPerSec === 25 ? 50 : 25;
        const sub = DOM.btnSpeed.querySelector(".sk-sub");
        if (sub) sub.textContent = `${state.sweepSpeedMmPerSec} mm/s`;
        updateMetaChip();
      });
    }

    // 5. Gain Toggle
    if (DOM.btnGain) {
      DOM.btnGain.addEventListener("click", () => {
        if (state.gainMode === "AUTO") state.gainMode = "1X";
        else if (state.gainMode === "1X") state.gainMode = "2X";
        else state.gainMode = "AUTO";

        const sub = DOM.btnGain.querySelector(".sk-sub");
        if (sub) sub.textContent = state.gainMode;
        updateMetaChip();
      });
    }

    // 6. 1 mV Calibration Pulse Toggle
    if (DOM.btnCalPulse) {
      DOM.btnCalPulse.addEventListener("click", () => {
        state.calPulseOn = !state.calPulseOn;
        DOM.btnCalPulse.classList.toggle("active", state.calPulseOn);
        const sub = DOM.btnCalPulse.querySelector(".sk-sub");
        if (sub) sub.textContent = state.calPulseOn ? "PULSE ON" : "PULSE OFF";
      });
    }

    // 7. QRS Tone Toggle
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

    // 8. Audio Pause / Mute Alarms
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

    // 9. Events Drawer
    if (DOM.btnEvents) {
      DOM.btnEvents.addEventListener("click", () => openEventsDrawer());
    }
    if (DOM.btnCloseEvents) {
      DOM.btnCloseEvents.addEventListener("click", () => {
        if (DOM.eventsDrawer) DOM.eventsDrawer.classList.add("hidden");
      });
    }

    // 10. Export CSV & Save PNG
    if (DOM.btnSaveCsv) {
      DOM.btnSaveCsv.addEventListener("click", () => {
        window.location.href = "/api/export/csv";
      });
    }
    if (DOM.btnSavePng) {
      DOM.btnSavePng.addEventListener("click", () => saveCanvasPngSnapshot());
    }

    // 11. PDF Report / Print
    if (DOM.btnPdfReport) {
      DOM.btnPdfReport.addEventListener("click", () => generatePrintReport());
    }

    // 12. Patient Modal
    if (DOM.btnPatient) {
      DOM.btnPatient.addEventListener("click", () => {
        if (state.observerMode || !ensureAdminPin()) return;
        if (DOM.patientModal) DOM.patientModal.classList.remove("hidden");
      });
    }

    // 13. Lab Test Simulator Bar Toggle
    if (DOM.btnLabTest) {
      DOM.btnLabTest.addEventListener("click", () => {
        if (state.observerMode || state.esp32Connected || !ensureAdminPin()) return;
        const isHidden = DOM.labTestBar.classList.contains("hidden");
        DOM.labTestBar.classList.toggle("hidden", !isHidden);
        DOM.btnLabTest.classList.toggle("active", isHidden);
      });
    }

    const simButtons = document.querySelectorAll("[data-sim-mode]");
    simButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (state.observerMode || !ensureAdminPin()) return;
        const mode = e.currentTarget.getAttribute("data-sim-mode");
        simButtons.forEach((b) => b.classList.remove("active"));
        e.currentTarget.classList.add("active");
        sendWsCommand("simulate", { mode });
        state.simMode = true;
        applyHardwarePriorityUI();
      });
    });

    if (DOM.btnSimStop) {
      DOM.btnSimStop.addEventListener("click", () => {
        if (state.observerMode) return;
        simButtons.forEach((b) => b.classList.remove("active"));
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

    // Bedside Keyboard Shortcuts (Space = Freeze, M = Mute, S = Speed, G = Gain)
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space" && DOM.btnFreeze) {
        e.preventDefault();
        DOM.btnFreeze.click();
      } else if (e.key.toLowerCase() === "m" && DOM.btnMuteAlarms) {
        DOM.btnMuteAlarms.click();
      } else if (e.key.toLowerCase() === "s" && DOM.btnSpeed) {
        DOM.btnSpeed.click();
      } else if (e.key.toLowerCase() === "g" && DOM.btnGain) {
        DOM.btnGain.click();
      }
    });
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
      const headers = { "Content-Type": "application/json" };
      if (state.adminPin) headers["X-Admin-Pin"] = state.adminPin;

      const res = await fetch("/api/patient", {
        method: "POST",
        headers,
        body: JSON.stringify(patientPayload)
      });
      if (res.ok) {
        const data = await res.json();
        syncPatientData(data.patient || patientPayload);
      } else {
        syncPatientData(patientPayload);
      }
    } catch (err) {
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

    DOM.eventsList.innerHTML = events
      .map(
        (ev, idx) => `
      <div class="event-item ${ev.severity === "high" ? "severity-high" : ""}" data-index="${idx}">
        <div style="display:flex; justify-content:space-between; font-weight:700; font-size:12px; margin-bottom:3px;">
          <span style="color:var(--text-primary);">${ev.type || ev.ai_label || "CLINICAL EVENT"}</span>
          <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);">${ev.timestamp || "--:--:--"}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary);">${ev.description || ev.reason || "Telemetry threshold breach"}</div>
      </div>
    `
      )
      .join("");

    const itemEls = DOM.eventsList.querySelectorAll(".event-item");
    itemEls.forEach((el) => {
      el.addEventListener("click", (e) => {
        itemEls.forEach((i) => i.classList.remove("selected"));
        e.currentTarget.classList.add("selected");
        const idx = Number(e.currentTarget.getAttribute("data-index"));
        renderEventSnapshot(events[idx]);
      });
    });

    if (events.length > 0) {
      itemEls[0].classList.add("selected");
      renderEventSnapshot(events[0]);
    }
  }

  function renderEventSnapshot(ev) {
    if (DOM.eventSnapshotMeta) {
      DOM.eventSnapshotMeta.textContent = `${ev.type || ev.ai_label} @ ${ev.timestamp} (${ev.severity || "medium"} severity)`;
    }
    const canvas = DOM.eventSnapshotCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.clientWidth || 380;
    const height = canvas.clientHeight || 120;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#04070B";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(10, 30, 20, 0.5)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < width; x += 20) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += 20) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    const samples =
      ev.waveform_strip && ev.waveform_strip.length > 0
        ? ev.waveform_strip
        : ev.waveform_5s && ev.waveform_5s.length > 0
          ? ev.waveform_5s
          : state.rollingPrintBuffer.map((p) => p.sample).slice(-300);

    if (!samples || samples.length === 0) return;

    const dx = width / samples.length;
    const centerY = height / 2;
    ctx.strokeStyle = "#38BDF8";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const val = typeof samples[i] === "object" ? samples[i].sample : samples[i];
      const x = i * dx;
      const y = centerY - val * (height * 0.28);
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

    const printCanvas = DOM.printEcgCanvas;
    if (printCanvas) {
      const width = printCanvas.clientWidth || 900;
      const height = printCanvas.clientHeight || 190;
      const dpr = window.devicePixelRatio || 1;
      printCanvas.width = width * dpr;
      printCanvas.height = height * dpr;
      const ctx = printCanvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = "#FFF5F5";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(225, 29, 72, 0.22)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let x = 0; x < width; x += 25) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = 0; y < height; y += 25) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      const printSamples =
        state.rollingPrintBuffer.length > 0 ? state.rollingPrintBuffer : state.ecgBuffer;

      if (printSamples.length > 0) {
        const dx = width / Math.max(printSamples.length, 1250);
        const centerY = height / 2;
        ctx.strokeStyle = "#9F1239";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < printSamples.length; i++) {
          const pt = printSamples[i];
          const val = typeof pt === "object" ? pt.sample : pt;
          const x = i * dx;
          const y = centerY - val * (height * 0.3);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

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
            <td><strong>${DOM.valBpm ? DOM.valBpm.textContent : "---"} BPM</strong></td>
            <td>60 – 100 BPM</td>
            <td>${state.patient.minHr}–${state.patient.maxHr} limit configured</td>
          </tr>
          <tr>
            <td>R-R Interval</td>
            <td>${DOM.valRr ? DOM.valRr.textContent : "---"} ms</td>
            <td>600 – 1000 ms</td>
            <td>Sinus Cycle Length</td>
          </tr>
          <tr>
            <td>HRV (RMSSD)</td>
            <td>${DOM.valHrv ? DOM.valHrv.textContent : "---"} ms</td>
            <td>20 – 200 ms</td>
            <td>Autonomic Tone Index</td>
          </tr>
          <tr>
            <td>QRS Duration</td>
            <td>${DOM.valQrs ? DOM.valQrs.textContent : "---"} ms</td>
            <td>60 – 100 ms</td>
            <td>Intraventricular Conduction</td>
          </tr>
          <tr>
            <td>ST Segment Deviation</td>
            <td>${DOM.valSt ? DOM.valSt.textContent : "---"} mV</td>
            <td>-0.05 to +0.10 mV</td>
            <td>${DOM.valStStatus ? DOM.valStStatus.textContent : "Screening"}</td>
          </tr>
          <tr>
            <td>Signal Quality Index (SQI)</td>
            <td>${DOM.badgeSqi ? DOM.badgeSqi.textContent : "---"}</td>
            <td>&gt; 75% Optimal</td>
            <td>Continuous Telemetry</td>
          </tr>
          <tr>
            <td>AI Rhythm Classification</td>
            <td><strong>${DOM.aiStatusPill ? DOM.aiStatusPill.textContent : "---"}</strong></td>
            <td>Normal Sinus</td>
            <td>Confidence: ${DOM.valAiConfidence ? DOM.valAiConfidence.textContent : "---"}</td>
          </tr>
        </tbody>
      `;
    }

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
            ${events
              .map(
                (ev) => `
              <tr>
                <td>${ev.timestamp || "--"}</td>
                <td><strong>${ev.type || ev.ai_label || "ALARM"}</strong></td>
                <td>${ev.description || ev.reason || "Threshold breach"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        `;
      }
    }

    setTimeout(() => {
      window.print();
    }, 350);
  }
})();