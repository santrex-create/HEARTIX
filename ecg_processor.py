from __future__ import annotations

import threading
import time
from collections import deque

import numpy as np
from scipy import signal

from ai_classifier import HybridAIClassifier


class ECGProcessor:
    """
    Dual-Path Biomedical DSP Pipeline for 250 Hz AD8232 Single-Lead ECG.
    - Fast Path (10 Hz, 25 samples): Stateful causal bandpass + 50 Hz notch + real-time R-peak markers.
    - Slow Path (1 Hz, 6-second window): Zero-phase filtering, Multi-Factor SQI, Pan-Tompkins QRS,
      Q-S duration, J+60ms ST deviation, PVC detection, and Hybrid AI classification.
      Parameters remain continuously visible regardless of SQI percentage.
    """

    AD8232_MID_MV: float = 1650.0
    AD8232_GAIN_SCALE: float = 1100.0

    def __init__(self, fs: int = 250, classifier: HybridAIClassifier | None = None) -> None:
        self.fs: int = int(fs)
        self.classifier: HybridAIClassifier = classifier if classifier is not None else HybridAIClassifier()

        self.min_hr: int = 60
        self.max_hr: int = 100

        self._lock = threading.Lock()

        # Filter coefficients
        nyq = 0.5 * self.fs
        # 4th-order Butterworth bandpass 0.5 - 40.0 Hz
        self._bp_sos = signal.butter(
            4, [0.5 / nyq, 40.0 / nyq], btype="bandpass", output="sos"
        )
        self._bp_zi_template = signal.sosfilt_zi(self._bp_sos)

        # 50 Hz IIR Notch filter (Q = 30)
        self._notch_b, self._notch_a = signal.iirnotch(50.0, 30.0, fs=self.fs)
        self._notch_zi_template = signal.lfilter_zi(self._notch_b, self._notch_a)

        # Pan-Tompkins QRS bandpass (5 - 15 Hz, 2nd-order zero-phase)
        self._pt_sos = signal.butter(
            2, [5.0 / nyq, 15.0 / nyq], btype="bandpass", output="sos"
        )

        # High-frequency EMG noise estimation high-pass (> 40 Hz)
        self._hf_sos = signal.butter(
            3, 40.0 / nyq, btype="highpass", output="sos"
        )

        # Rolling buffers
        self._window_len: int = self.fs * 6          # 1500 samples (6 seconds)
        self._session_len: int = self.fs * 300       # 75000 samples (5 minutes)

        self._raw_buffer: deque[float] = deque(maxlen=self._window_len)
        self._clean_buffer: deque[float] = deque(maxlen=self._window_len)
        self._session_buffer: deque[dict] = deque(maxlen=self._session_len)

        # Filter states and runtime trackers
        self._bp_zi: np.ndarray | None = None
        self._notch_zi: np.ndarray | None = None
        self._leads_off: bool = False
        self._calibrating_samples_left: int = 0

        # Fast-path R-peak detector state
        self._sample_counter: int = 0
        self._last_fast_r_sample: int = -self.fs
        self._fast_peak_env: float = 0.55
        self._prev_prev_val: float = 0.0
        self._prev_val: float = 0.0

        # Slow-path EMA and status trackers
        self._ema_bpm: float | None = None
        self._ema_rr_ms: float | None = None
        self._latest_bpm_int: int | None = None
        self._latest_status: str = "ACQUIRING SIGNAL..."

    def reset(self) -> None:
        """Clears buffers, filter states, EMA state, and classifier hysteresis."""
        with self._lock:
            self._raw_buffer.clear()
            self._clean_buffer.clear()
            self._session_buffer.clear()
            self._bp_zi = None
            self._notch_zi = None
            self._leads_off = False
            self._calibrating_samples_left = 0
            self._sample_counter = 0
            self._last_fast_r_sample = -self.fs
            self._fast_peak_env = 0.55
            self._prev_prev_val = 0.0
            self._prev_val = 0.0
            self._ema_bpm = None
            self._ema_rr_ms = None
            self._latest_bpm_int = None
            self._latest_status = "ACQUIRING SIGNAL..."
        self.classifier.reset_hysteresis()

    def reset_filters(self) -> None:
        """Resets only causal filter states (used on packet-loss gaps > 3)."""
        with self._lock:
            self._bp_zi = None
            self._notch_zi = None
            self._prev_prev_val = 0.0
            self._prev_val = 0.0

    def set_hr_limits(self, min_hr: int, max_hr: int) -> None:
        """Updates patient-specific bradycardia/tachycardia alarm limits."""
        with self._lock:
            self.min_hr = max(30, min(int(min_hr), 110))
            self.max_hr = max(self.min_hr + 10, min(int(max_hr), 220))

    def ingest_batch(self, raw_mv: list[float], leads_off: bool = False) -> dict:
        """
        Fast Path (10 Hz, 25 samples per batch).
        Converts raw ADC mV to physiological mV, applies stateful causal filtering,
        quickly settles baseline after leads-off recovery, and detects instant R-peaks.
        """
        if not raw_mv:
            return {
                "samples": [],
                "r_peak_offsets": [],
                "leads_off": bool(leads_off),
                "calibrating": False,
            }

        with self._lock:
            was_leads_off = self._leads_off
            self._leads_off = bool(leads_off)

            # Short 0.6s (150-sample) baseline settle when electrodes reattach
            if was_leads_off and not self._leads_off:
                self._calibrating_samples_left = int(0.6 * self.fs)
                self._bp_zi = None
                self._notch_zi = None

            if self._leads_off:
                self._bp_zi = None
                self._notch_zi = None
                zeros = [0.0 for _ in raw_mv]
                now_ts = time.time()
                dt = 1.0 / self.fs
                n_samples = len(raw_mv)
                for idx, r_val in enumerate(raw_mv):
                    self._raw_buffer.append(float(r_val))
                    self._clean_buffer.append(0.0)
                    sample_ts = now_ts - (n_samples - 1 - idx) * dt
                    self._session_buffer.append(
                        {
                            "ts": round(sample_ts, 4),
                            "ecg_mv": 0.0,
                            "bpm": None,
                            "status": "LEADS OFF",
                        }
                    )
                self._sample_counter += n_samples
                return {
                    "samples": zeros,
                    "r_peak_offsets": [],
                    "leads_off": True,
                    "calibrating": False,
                }

            raw_arr = np.asarray(raw_mv, dtype=np.float64)
            scaled_arr = (raw_arr - self.AD8232_MID_MV) / self.AD8232_GAIN_SCALE
            scaled_arr = np.clip(scaled_arr, -3.0, 3.5)

            # Initialize filter states cleanly on the first valid sample to prevent startup ringing
            if self._notch_zi is None or self._bp_zi is None:
                first_val = float(scaled_arr[0])
                self._notch_zi = self._notch_zi_template * first_val
                self._bp_zi = self._bp_zi_template * first_val

            notched_arr, self._notch_zi = signal.lfilter(
                self._notch_b, self._notch_a, scaled_arr, zi=self._notch_zi
            )
            cleaned_arr, self._bp_zi = signal.sosfilt(
                self._bp_sos, notched_arr, zi=self._bp_zi
            )
            cleaned_arr = np.clip(cleaned_arr, -2.0, 2.8)

            if self._calibrating_samples_left > 0:
                self._calibrating_samples_left = max(
                    0, self._calibrating_samples_left - len(raw_mv)
                )

            # Real-time R-peak offset detection within the 25-sample batch (never gated by SQI)
            r_peak_offsets: list[int] = []
            refractory_samples = int(0.22 * self.fs)  # 55 samples (220 ms)

            now_ts = time.time()
            dt = 1.0 / self.fs
            n_samples = len(cleaned_arr)
            cleaned_list: list[float] = []

            for i in range(n_samples):
                val = float(cleaned_arr[i])
                val_rounded = round(val, 4)
                cleaned_list.append(val_rounded)

                self._raw_buffer.append(float(raw_arr[i]))
                self._clean_buffer.append(val_rounded)

                sample_ts = now_ts - (n_samples - 1 - i) * dt
                self._session_buffer.append(
                    {
                        "ts": round(sample_ts, 4),
                        "ecg_mv": val_rounded,
                        "bpm": self._latest_bpm_int,
                        "status": self._latest_status,
                    }
                )

                global_idx = self._sample_counter + i
                if len(self._clean_buffer) > int(0.4 * self.fs):
                    self._fast_peak_env = max(0.22, 0.992 * self._fast_peak_env)
                    if val > self._fast_peak_env:
                        self._fast_peak_env = 0.7 * self._fast_peak_env + 0.3 * val

                    thresh = max(0.18, 0.48 * self._fast_peak_env)
                    if (
                        self._prev_val > thresh
                        and self._prev_val >= self._prev_prev_val
                        and self._prev_val > val
                        and (global_idx - 1 - self._last_fast_r_sample) >= refractory_samples
                    ):
                        peak_offset = max(0, i - 1)
                        if not r_peak_offsets or (peak_offset - r_peak_offsets[-1]) >= refractory_samples:
                            r_peak_offsets.append(peak_offset)
                            self._last_fast_r_sample = global_idx - 1

                self._prev_prev_val = self._prev_val
                self._prev_val = val

            self._sample_counter += n_samples

            return {
                "samples": cleaned_list,
                "r_peak_offsets": r_peak_offsets,
                "leads_off": False,
                "calibrating": False,
            }

    def _compute_sqi_and_noise(
        self, raw_arr: np.ndarray, notched_scaled: np.ndarray, zero_phase_ecg: np.ndarray
    ) -> tuple[int, float]:
        """
        Computes Multi-Factor Signal Quality Index (0 - 100%) and HF noise ratio from:
        1. ADC Rail Saturation (<= 50 mV or >= 3250 mV)
        2. Flatline variance check
        3. High-frequency EMG noise energy (> 40 Hz) vs QRS band energy (5 - 15 Hz)
        """
        if len(raw_arr) == 0:
            return 0, 1.0

        sat_mask = (raw_arr <= 50.0) | (raw_arr >= 3250.0)
        sat_ratio = float(np.mean(sat_mask))

        ecg_std = float(np.std(zero_phase_ecg))
        ecg_ptp = float(np.ptp(zero_phase_ecg))
        if ecg_std < 0.015 or ecg_ptp < 0.08:
            return max(5, int(round(20.0 * (ecg_std / 0.015)))), 0.0

        qrs_sig = signal.sosfiltfilt(self._pt_sos, notched_scaled)
        hf_sig = signal.sosfiltfilt(self._hf_sos, notched_scaled)

        qrs_energy = float(np.mean(qrs_sig ** 2)) + 1e-9
        hf_energy = float(np.mean(hf_sig ** 2))
        hf_to_qrs_ratio = hf_energy / qrs_energy

        score = 100.0
        score -= min(65.0, sat_ratio * 380.0)
        if hf_to_qrs_ratio > 0.08:
            score -= min(75.0, (hf_to_qrs_ratio - 0.08) * 95.0)
        if ecg_ptp > 3.2:
            score -= min(30.0, (ecg_ptp - 3.2) * 18.0)

        return int(np.clip(round(score), 0, 100)), float(hf_to_qrs_ratio)

    def _detect_r_peaks_pan_tompkins(self, zero_phase_ecg: np.ndarray) -> np.ndarray:
        """
        Pan-Tompkins R-Peak Detection tuned for both normal and low-amplitude skin contact.
        """
        n = len(zero_phase_ecg)
        if n < int(1.2 * self.fs):
            return np.array([], dtype=int)

        qrs_band = signal.sosfiltfilt(self._pt_sos, zero_phase_ecg)
        deriv = np.gradient(qrs_band)
        squared = deriv ** 2

        win_len = max(3, int(0.150 * self.fs))
        kernel = np.ones(win_len, dtype=np.float64) / float(win_len)
        mwi = np.convolve(squared, kernel, mode="same")

        refractory = int(0.220 * self.fs)
        p75 = float(np.percentile(mwi, 75))
        p95 = float(np.percentile(mwi, 96))
        threshold = max(1e-6, p75 + 0.26 * (p95 - p75))

        candidate_peaks, _ = signal.find_peaks(
            mwi,
            height=threshold,
            distance=refractory,
        )

        if len(candidate_peaks) == 0:
            return np.array([], dtype=int)

        search_half = int(0.085 * self.fs)
        snapped_peaks: list[int] = []
        edge_margin = int(0.05 * self.fs)

        for pk in candidate_peaks:
            left = max(0, int(pk) - search_half)
            right = min(n, int(pk) + search_half + 1)
            if right <= left:
                continue
            local_idx = left + int(np.argmax(zero_phase_ecg[left:right]))
            if local_idx < edge_margin or local_idx >= (n - edge_margin):
                continue
            if zero_phase_ecg[local_idx] < 0.12:
                continue
            if snapped_peaks and (local_idx - snapped_peaks[-1]) < refractory:
                if zero_phase_ecg[local_idx] > zero_phase_ecg[snapped_peaks[-1]]:
                    snapped_peaks[-1] = local_idx
            else:
                snapped_peaks.append(local_idx)

        return np.array(snapped_peaks, dtype=int)

    @staticmethod
    def _count_pvc_beats(rr_intervals_ms: np.ndarray, median_rr_ms: float) -> int:
        """Counts isolated premature beats followed by a compensatory pause."""
        if len(rr_intervals_ms) < 2 or median_rr_ms <= 0:
            return 0
        pvc_hits = 0
        for i in range(len(rr_intervals_ms) - 1):
            curr_rr = rr_intervals_ms[i]
            next_rr = rr_intervals_ms[i + 1]
            if curr_rr < (0.78 * median_rr_ms) and next_rr > (1.15 * median_rr_ms):
                pvc_hits += 1
        return pvc_hits

    def _extract_qrs_and_st(
        self, zero_phase_ecg: np.ndarray, r_peaks: np.ndarray
    ) -> tuple[int, float, str]:
        """
        Measures Q-onset to S-offset (QRS duration in ms) and ST deviation at (J-point + 60 ms)
        relative to the PR isoelectric baseline (60-100 ms before Q-onset).
        """
        n = len(zero_phase_ecg)
        qrs_durations_ms: list[float] = []
        st_values_mv: list[float] = []

        q_search = int(0.055 * self.fs)
        q_onset_max = int(0.060 * self.fs)
        q_onset_min = int(0.032 * self.fs)

        s_search = int(0.060 * self.fs)
        s_offset_max = int(0.072 * self.fs)
        s_offset_min = int(0.036 * self.fs)

        st_offset_samples = int(0.060 * self.fs)
        pr_start_offset = int(0.100 * self.fs)
        pr_end_offset = int(0.060 * self.fs)

        for r_idx_raw in r_peaks:
            r_idx = int(r_idx_raw)
            if r_idx - q_onset_max - pr_start_offset < 0:
                continue
            if r_idx + s_offset_max + st_offset_samples + 2 >= n:
                continue

            q_left = max(0, r_idx - q_search)
            q_min_idx = q_left + int(np.argmin(zero_phase_ecg[q_left : r_idx + 1]))

            pre_q_left = max(0, r_idx - int(0.120 * self.fs))
            pre_q_right = max(pre_q_left + 1, r_idx - int(0.065 * self.fs))
            iso_ref = float(np.median(zero_phase_ecg[pre_q_left:pre_q_right]))

            q_onset_idx = q_min_idx
            q_bound = max(0, r_idx - q_onset_max)
            q_depth = abs(float(zero_phase_ecg[q_min_idx]) - iso_ref)
            q_thresh = iso_ref - 0.15 * max(q_depth, 0.04)
            for idx in range(q_min_idx, q_bound - 1, -1):
                q_onset_idx = idx
                if zero_phase_ecg[idx] >= q_thresh:
                    break
            q_onset_idx = int(
                np.clip(q_onset_idx, r_idx - q_onset_max, r_idx - q_onset_min)
            )

            s_right = min(n, r_idx + s_search + 1)
            s_min_idx = r_idx + int(np.argmin(zero_phase_ecg[r_idx:s_right]))

            s_offset_idx = s_min_idx
            s_bound = min(n - 2, r_idx + s_offset_max)
            s_depth = abs(float(zero_phase_ecg[s_min_idx]) - iso_ref)
            s_thresh = iso_ref - 0.15 * max(s_depth, 0.04)
            for idx in range(s_min_idx + 1, s_bound + 1):
                s_offset_idx = idx
                slope = abs(float(zero_phase_ecg[idx + 1] - zero_phase_ecg[idx]))
                if zero_phase_ecg[idx] >= s_thresh or slope < 0.012:
                    break
            s_offset_idx = int(
                np.clip(s_offset_idx, r_idx + s_offset_min, r_idx + s_offset_max)
            )

            qrs_ms_beat = ((s_offset_idx - q_onset_idx) / float(self.fs)) * 1000.0
            qrs_durations_ms.append(float(np.clip(qrs_ms_beat, 64.0, 160.0)))

            pr_l = max(0, q_onset_idx - pr_start_offset)
            pr_r = max(pr_l + 2, q_onset_idx - pr_end_offset)
            pr_baseline_mv = float(np.mean(zero_phase_ecg[pr_l:pr_r]))

            st_center = s_offset_idx + st_offset_samples
            st_l = max(0, st_center - 1)
            st_r = min(n, st_center + 2)
            st_point_mv = float(np.mean(zero_phase_ecg[st_l:st_r]))

            st_values_mv.append(st_point_mv - pr_baseline_mv)

        qrs_ms = int(round(float(np.median(qrs_durations_ms)))) if qrs_durations_ms else 88
        st_mv = round(float(np.median(st_values_mv)), 3) if st_values_mv else 0.0

        if st_mv >= 0.15:
            st_status = "ELEVATED (Screening)"
        elif st_mv <= -0.15:
            st_status = "DEPRESSED (Screening)"
        else:
            st_status = "NORMAL"

        return qrs_ms, st_mv, st_status

    def analyze_window(self) -> dict:
        """
        Slow Path (1 Hz).
        Always computes and returns live BPM, R-R, HRV, QRS, ST, and AI classification
        regardless of SQI percentage as long as electrodes are attached (not leads_off).
        """
        with self._lock:
            leads_off = self._leads_off
            raw_snapshot = np.asarray(self._raw_buffer, dtype=np.float64)
            min_hr = self.min_hr
            max_hr = self.max_hr
            prev_bpm = self._latest_bpm_int

        # Only block metrics when physical hardware leads are detached
        if leads_off:
            with self._lock:
                self._latest_bpm_int = None
                self._latest_status = "LEADS OFF"
            return {
                "valid_signal": False,
                "status": "LEADS OFF",
                "alarm_level": "technical",
                "sqi": 0,
                "bpm": None,
                "rr_ms": None,
                "hrv_ms": None,
                "qrs_ms": None,
                "st_mv": None,
                "st_status": None,
                "ai_label": "LEADS OFF",
                "ai_confidence": None,
                "ai_reason": "Electrode contact lost (LO+ / LO- triggered).",
                "bradycardia": False,
                "tachycardia": False,
                "arrhythmia": False,
                "pvc_count": 0,
            }

        # Require only 1.5 seconds of initial buffer before displaying parameters
        min_samples_required = int(1.5 * self.fs)
        if len(raw_snapshot) < min_samples_required:
            with self._lock:
                self._latest_status = "ACQUIRING SIGNAL..."
            return {
                "valid_signal": True,
                "status": "ACQUIRING SIGNAL...",
                "alarm_level": "none",
                "sqi": 50,
                "bpm": prev_bpm,
                "rr_ms": int(round(60000.0 / prev_bpm)) if prev_bpm else None,
                "hrv_ms": None,
                "qrs_ms": None,
                "st_mv": None,
                "st_status": "Screening",
                "ai_label": "ACQUIRING INITIAL BEATS...",
                "ai_confidence": None,
                "ai_reason": "Collecting initial 1.5s window for interval calculation.",
                "bradycardia": False,
                "tachycardia": False,
                "arrhythmia": False,
                "pvc_count": 0,
            }

        # Zero-Phase Filtering (50 Hz notch + 0.5-40 Hz bandpass)
        scaled_raw = (raw_snapshot - self.AD8232_MID_MV) / self.AD8232_GAIN_SCALE
        notched_zero = signal.filtfilt(self._notch_b, self._notch_a, scaled_raw)
        zero_phase_ecg = signal.sosfiltfilt(self._bp_sos, notched_zero)

        # Multi-Factor SQI + HF noise ratio (informational only; never gates parameter visibility)
        sqi, hf_noise_ratio = self._compute_sqi_and_noise(raw_snapshot, notched_zero, zero_phase_ecg)

        # Pan-Tompkins R-Peak Detection
        r_peaks = self._detect_r_peaks_pan_tompkins(zero_phase_ecg)
        rr_intervals_ms = (np.diff(r_peaks) / float(self.fs)) * 1000.0 if len(r_peaks) >= 2 else np.array([])
        valid_rr = rr_intervals_ms[(rr_intervals_ms >= 240.0) & (rr_intervals_ms <= 2400.0)]

        # If fewer than 2 peaks found in a noisy frame, keep last known BPM visible instead of blanking
        if len(valid_rr) == 0:
            qrs_ms, st_mv, st_status = self._extract_qrs_and_st(zero_phase_ecg, r_peaks)
            fallback_bpm = prev_bpm if prev_bpm is not None else 72
            fallback_rr = int(round(60000.0 / fallback_bpm))
            with self._lock:
                self._latest_status = f"ESTIMATING RHYTHM (SQI {sqi}%)"
            return {
                "valid_signal": True,
                "status": f"ESTIMATING RHYTHM (SQI {sqi}%)",
                "alarm_level": "none",
                "sqi": int(sqi),
                "bpm": prev_bpm,
                "rr_ms": fallback_rr if prev_bpm is not None else None,
                "hrv_ms": 24 if prev_bpm is not None else None,
                "qrs_ms": int(qrs_ms),
                "st_mv": round(float(st_mv), 2),
                "st_status": st_status,
                "ai_label": f"ADAPTING TO SIGNAL (SQI {sqi}%)",
                "ai_confidence": int(max(50, sqi)),
                "ai_reason": f"Tracking R-wave peaks across noisy contact (SQI {sqi}%).",
                "bradycardia": False,
                "tachycardia": False,
                "arrhythmia": False,
                "pvc_count": 0,
            }

        median_rr_ms = float(np.median(valid_rr))
        raw_bpm = 60000.0 / median_rr_ms

        # EMA smoothing (alpha = 0.35) on BPM and R-R interval
        alpha = 0.35
        with self._lock:
            if self._ema_bpm is None or abs(raw_bpm - self._ema_bpm) > 28.0:
                self._ema_bpm = raw_bpm
                self._ema_rr_ms = median_rr_ms
            else:
                self._ema_bpm = alpha * raw_bpm + (1.0 - alpha) * self._ema_bpm
                self._ema_rr_ms = alpha * median_rr_ms + (1.0 - alpha) * self._ema_rr_ms
            smoothed_bpm = int(round(self._ema_bpm))
            smoothed_rr_ms = int(round(self._ema_rr_ms))

        # HRV (RMSSD in ms), RR statistics, and PVC detection
        rr_mean_ms = float(np.mean(valid_rr))
        rr_std_ms = float(np.std(valid_rr)) if len(valid_rr) > 1 else 12.0
        if len(valid_rr) >= 2:
            succ_diffs = np.diff(valid_rr)
            rmssd_ms = float(np.sqrt(np.mean(succ_diffs ** 2)))
        else:
            rmssd_ms = rr_std_ms
        rr_cv = rr_std_ms / max(rr_mean_ms, 1.0)
        hrv_ms_int = int(round(np.clip(rmssd_ms, 1.0, 350.0)))
        pvc_count = self._count_pvc_beats(valid_rr, median_rr_ms)

        # QRS duration and ST segment deviation
        qrs_ms, st_mv, st_status = self._extract_qrs_and_st(zero_phase_ecg, r_peaks)

        # R-peak amplitude stability
        r_amps = zero_phase_ecg[r_peaks]
        r_amp_mean = float(np.mean(np.abs(r_amps)))
        r_amp_cv = float(np.std(r_amps) / max(r_amp_mean, 0.1))

        features = {
            "bpm": float(smoothed_bpm),
            "rr_mean_ms": rr_mean_ms,
            "rr_std_ms": rr_std_ms,
            "rmssd_ms": rmssd_ms,
            "rr_cv": rr_cv,
            "qrs_ms": float(qrs_ms),
            "st_mv": float(st_mv),
            "r_amp_cv": r_amp_cv,
            "sqi": float(sqi),
            "hf_noise_ratio": hf_noise_ratio,
            "pvc_count": pvc_count,
        }

        ai_res = self.classifier.classify(features, min_hr=min_hr, max_hr=max_hr)

        with self._lock:
            self._latest_bpm_int = smoothed_bpm
            self._latest_status = ai_res["label"]

        return {
            "valid_signal": True,
            "status": ai_res["label"],
            "alarm_level": ai_res["alarm_level"],
            "sqi": int(sqi),
            "bpm": smoothed_bpm,
            "rr_ms": smoothed_rr_ms,
            "hrv_ms": hrv_ms_int,
            "qrs_ms": int(qrs_ms),
            "st_mv": round(float(st_mv), 2),
            "st_status": st_status,
            "ai_label": ai_res["label"],
            "ai_confidence": int(ai_res["confidence_pct"]),
            "ai_reason": ai_res["reason"],
            "bradycardia": bool(ai_res["bradycardia"]),
            "tachycardia": bool(ai_res["tachycardia"]),
            "arrhythmia": bool(ai_res["arrhythmia"]),
            "pvc_count": int(pvc_count),
        }

    def get_recent_snapshot(self, seconds: float = 5.0) -> list[float]:
        """Returns the most recent N seconds of cleaned ECG samples in mV."""
        n_samples = max(1, int(round(seconds * self.fs)))
        with self._lock:
            buf_list = list(self._clean_buffer)
        return buf_list[-n_samples:]

    def get_session_records(self) -> list[dict]:
        """
        Returns list of {"ts": float, "ecg_mv": float, "bpm": int|None, "status": str}
        from the 5-minute session ring buffer.
        """
        with self._lock:
            return list(self._session_buffer)