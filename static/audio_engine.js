/**
 * HEARTIX — Web Audio API Clinical Telemetry & IEC 60601-1-8 Inspired Alarm Engine
 * Zero external audio assets; pure synthesized sine tones with click-free ADSR envelopes.
 */
class HeartixAudioEngine {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.qrsBeepEnabled = true;
    this.alarmLevel = "none";

    // Repeating alarm scheduler state
    this._alarmIntervalId = null;
    this._scheduledTimeoutIds = [];

    // 2-minute ICU audio pause state
    this._muted = false;
    this._muteRemaining = 0;
    this._muteTimerId = null;
    this._onMuteTick = null;
  }

  /**
   * Creates or resumes AudioContext cleanly on a user gesture.
   */
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    if (this.ctx) {
      this.unlocked = true;
    }
    return this.unlocked;
  }

  /**
   * Internal helper to synthesize a single click-free sine tone burst.
   */
  _playTone(freqHz, durationSec, peakGain = 0.14, delaySec = 0) {
    if (!this.unlocked || !this.ctx) return;
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }

    const now = this.ctx.currentTime + delaySec;
    const attack = 0.005;  // 5 ms smooth attack
    const release = 0.005; // 5 ms smooth release
    const sustainEnd = Math.max(now + attack, now + durationSec - release);

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freqHz, now);

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), now + attack);
    gainNode.gain.setValueAtTime(Math.max(0.0002, peakGain), sustainEnd);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.01);
  }

  /**
   * Plays a crisp 880 Hz, 55 ms R-peak QRS tone with 5 ms attack/release.
   */
  playQrsBeep() {
    if (!this.unlocked || !this.qrsBeepEnabled || this._muted) return;
    this._playTone(880, 0.055, 0.11, 0);
  }

  /**
   * Enables or disables the R-peak QRS systolic tone.
   * @param {boolean} enabled
   */
  setQrsBeepEnabled(enabled) {
    this.qrsBeepEnabled = Boolean(enabled);
  }

  /**
   * Clears any active alarm intervals and pending burst pulse timeouts.
   */
  _clearAlarmTimers() {
    if (this._alarmIntervalId !== null) {
      clearInterval(this._alarmIntervalId);
      this._alarmIntervalId = null;
    }
    while (this._scheduledTimeoutIds.length > 0) {
      clearTimeout(this._scheduledTimeoutIds.pop());
    }
  }

  /**
   * Schedules an urgent 5-pulse High Priority burst: (beep-beep-beep — beep-beep) at 960 Hz.
   */
  _emitHighBurst() {
    if (this._muted || !this.unlocked) return;
    // Pattern offsets in ms: 3 rapid pulses, brief pause, 2 rapid pulses
    const offsetsMs = [0, 140, 280, 520, 660];
    offsetsMs.forEach((offset) => {
      const id = setTimeout(() => {
        if (!this._muted && this.alarmLevel === "high") {
          this._playTone(960, 0.085, 0.18, 0);
        }
      }, offset);
      this._scheduledTimeoutIds.push(id);
    });
  }

  /**
   * Schedules a 3-pulse Medium Priority warning burst: (beep — beep — beep) at 660 Hz.
   */
  _emitMediumBurst() {
    if (this._muted || !this.unlocked) return;
    const offsetsMs = [0, 240, 480];
    offsetsMs.forEach((offset) => {
      const id = setTimeout(() => {
        if (!this._muted && this.alarmLevel === "medium") {
          this._playTone(660, 0.11, 0.15, 0);
        }
      }, offset);
      this._scheduledTimeoutIds.push(id);
    });
  }

  /**
   * Sets clinical alarm priority level and manages IEC 60601-1-8 inspired repeating bursts.
   * @param {"none" | "technical" | "low" | "medium" | "high"} level
   */
  setAlarmLevel(level) {
    const normalized = String(level || "none").toLowerCase();
    if (this.alarmLevel === normalized && (this._alarmIntervalId !== null || (normalized !== "high" && normalized !== "medium"))) {
      return;
    }

    this.alarmLevel = normalized;
    this._clearAlarmTimers();

    if (normalized === "high") {
      this._emitHighBurst();
      this._alarmIntervalId = setInterval(() => {
        this._emitHighBurst();
      }, 5000);
    } else if (normalized === "medium") {
      this._emitMediumBurst();
      this._alarmIntervalId = setInterval(() => {
        this._emitMediumBurst();
      }, 8000);
    }
    // "none", "technical", "low" stop repeating clinical alarms
  }

  /**
   * Plays a gentle 2-tone 440 Hz -> 370 Hz chime once for technical events (Leads Off / Disconnect).
   */
  triggerTechnicalAlert() {
    if (this._muted || !this.unlocked) return;
    this._playTone(440, 0.13, 0.14, 0);
    const id = setTimeout(() => {
      if (!this._muted) {
        this._playTone(370, 0.18, 0.14, 0);
      }
    }, 150);
    this._scheduledTimeoutIds.push(id);
  }

  /**
   * Toggles a 120-second ICU Audio Pause countdown; invokes onTickCallback(remainingSeconds) every second.
   * @param {function(number): void} [onTickCallback]
   * @returns {boolean} Current muted state after toggle
   */
  toggleMute2Min(onTickCallback) {
    if (typeof onTickCallback === "function") {
      this._onMuteTick = onTickCallback;
    }

    if (this._muted) {
      // Unmute immediately
      this._muted = false;
      this._muteRemaining = 0;
      if (this._muteTimerId !== null) {
        clearInterval(this._muteTimerId);
        this._muteTimerId = null;
      }
      if (this._onMuteTick) {
        this._onMuteTick(0);
      }
      return false;
    }

    // Activate 120-second audio pause
    this._muted = true;
    this._muteRemaining = 120;
    while (this._scheduledTimeoutIds.length > 0) {
      clearTimeout(this._scheduledTimeoutIds.pop());
    }

    if (this._onMuteTick) {
      this._onMuteTick(this._muteRemaining);
    }

    this._muteTimerId = setInterval(() => {
      this._muteRemaining -= 1;
      if (this._muteRemaining <= 0) {
        this._muted = false;
        this._muteRemaining = 0;
        clearInterval(this._muteTimerId);
        this._muteTimerId = null;
        if (this._onMuteTick) {
          this._onMuteTick(0);
        }
      } else if (this._onMuteTick) {
        this._onMuteTick(this._muteRemaining);
      }
    }, 1000);

    return true;
  }

  /**
   * Returns true if ICU 2-minute Audio Pause is currently active.
   * @returns {boolean}
   */
  isMuted() {
    return this._muted;
  }

  /**
   * Immediately halts all active alarm timers and mute countdowns.
   */
  stopAll() {
    this.alarmLevel = "none";
    this._clearAlarmTimers();
    if (this._muteTimerId !== null) {
      clearInterval(this._muteTimerId);
      this._muteTimerId = null;
    }
    this._muted = false;
    this._muteRemaining = 0;
  }
}

window.heartixAudio = new HeartixAudioEngine();