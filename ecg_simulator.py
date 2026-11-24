from __future__ import annotations

import math
import numpy as np


class ECGSimulator:
    """
    250 Hz Phase-Continuous Synthetic AD8232 ECG Waveform Generator.
    Synthesizes realistic P-QRS-T morphology centered at 1650.0 mV (AD8232 gain ~1100)
    with injected 50 Hz AC mains hum, 0.25 Hz respiratory baseline wander, and Gaussian noise.
    Includes PVC ectopic beats and low-contact (<60% SQI) test presets.
    """

    AD8232_MID_MV: float = 1650.0
    AD8232_GAIN_SCALE: float = 1100.0

    SUPPORTED_MODES: tuple[str, ...] = (
        "normal",
        "tachycardia",
        "bradycardia",
        "arrhythmia",
        "pvc",
        "st_elevation",
        "low_contact",
        "motion_artifact",
        "leads_off",
    )

    def __init__(self, fs: int = 250) -> None:
        self.fs: int = int(fs)
        self._rng = np.random.default_rng(2026)
        self._t_sec: float = 0.0
        self._beat_elapsed_sec: float = 0.0
        self._current_rr_sec: float = 60.0 / 74.0
        self._beat_count: int = 0
        self._is_pvc_beat: bool = False
        self._pvc_compensatory_next: bool = False
        self._arrhythmia_pattern_idx: int = 0
        self._arrhythmia_rr_factors: tuple[float, ...] = (
            1.00,
            0.62,
            1.36,
            0.94,
            0.58,
            1.42,
            0.78,
            1.28,
        )

    def reset(self) -> None:
        """Resets simulator phase, clocks, and deterministic random stream."""
        self._rng = np.random.default_rng(2026)
        self._t_sec = 0.0
        self._beat_elapsed_sec = 0.0
        self._current_rr_sec = 60.0 / 74.0
        self._beat_count = 0
        self._is_pvc_beat = False
        self._pvc_compensatory_next = False
        self._arrhythmia_pattern_idx = 0

    def _next_rr_interval_sec(self, mode: str) -> float:
        """Selects the next beat-to-beat RR interval in seconds for the active mode."""
        self._beat_count += 1
        self._is_pvc_beat = False

        if mode == "tachycardia":
            base_bpm = 126.0 + float(self._rng.normal(0.0, 1.2))
            return 60.0 / np.clip(base_bpm, 120.0, 132.0)
        if mode == "bradycardia":
            base_bpm = 48.0 + float(self._rng.normal(0.0, 0.8))
            return 60.0 / np.clip(base_bpm, 45.5, 51.0)
        if mode == "arrhythmia":
            base_rr = 60.0 / 78.0
            factor = self._arrhythmia_rr_factors[
                self._arrhythmia_pattern_idx % len(self._arrhythmia_rr_factors)
            ]
            self._arrhythmia_pattern_idx += 1
            jitter = float(self._rng.normal(0.0, 0.025))
            return float(np.clip(base_rr * factor + jitter, 0.38, 1.35))
        if mode == "pvc":
            base_rr = 60.0 / 74.0
            if self._pvc_compensatory_next:
                self._pvc_compensatory_next = False
                return float(base_rr * 1.34 + self._rng.normal(0.0, 0.015))
            if self._beat_count % 5 == 0:
                self._is_pvc_beat = True
                self._pvc_compensatory_next = True
                return float(base_rr * 0.66 + self._rng.normal(0.0, 0.012))
            return float(base_rr + self._rng.normal(0.0, 0.012))
        if mode == "st_elevation":
            base_bpm = 78.0 + float(self._rng.normal(0.0, 1.0))
            return 60.0 / np.clip(base_bpm, 74.0, 82.0)

        # Default ("normal", "low_contact", or "motion_artifact")
        base_bpm = 74.0 + float(self._rng.normal(0.0, 1.1))
        return 60.0 / np.clip(base_bpm, 70.0, 78.0)

    @staticmethod
    def _gaussian_wave(dt: float, center: float, width: float, amp: float) -> float:
        z = (dt - center) / width
        if abs(z) > 6.0:
            return 0.0
        return amp * math.exp(-0.5 * z * z)

    def _evaluate_pqrst_mv(self, dt_from_r: float, mode: str) -> float:
        """
        Evaluates clean physiological ECG voltage (in mV) at time offset `dt_from_r` (seconds)
        relative to the current beat's R-peak center.
        """
        if self._is_pvc_beat:
            # Premature Ventricular Contraction: absent P wave, widened tall R + deep discordant S/T
            r_wide = self._gaussian_wave(dt_from_r, 0.000, 0.022, 1.48)
            s_deep = self._gaussian_wave(dt_from_r, 0.048, 0.024, -0.68)
            t_inv = self._gaussian_wave(dt_from_r, 0.210, 0.045, -0.34)
            return r_wide + s_deep + t_inv

        # P wave (-155 ms before R)
        p_wave = self._gaussian_wave(dt_from_r, -0.155, 0.022, 0.16)
        # Q wave (-21 ms before R)
        q_wave = self._gaussian_wave(dt_from_r, -0.021, 0.0075, -0.15)
        # R peak (0 ms) -> +1.28 mV peak
        r_wave = self._gaussian_wave(dt_from_r, 0.000, 0.0095, 1.28)
        # S wave (+22 ms after R)
        s_wave = self._gaussian_wave(dt_from_r, 0.022, 0.0085, -0.26)
        # T wave (+195 ms after R)
        t_wave = self._gaussian_wave(dt_from_r, 0.195, 0.036, 0.28)

        val = p_wave + q_wave + r_wave + s_wave + t_wave

        # Elevated ST plateau in "st_elevation" mode
        if mode == "st_elevation":
            st_plateau = 0.34 / (
                (1.0 + math.exp(-(dt_from_r - 0.034) / 0.006))
                * (1.0 + math.exp((dt_from_r - 0.175) / 0.014))
            )
            val += st_plateau

        return val

    def generate_batch(self, mode: str, n: int = 25) -> tuple[list[float], bool]:
        """
        Generates `n` raw AD8232 millivolt samples (0 - 3300 mV, centered at 1650.0 mV)
        and the `leads_off` boolean flag.
        """
        normalized_mode = (mode or "normal").strip().lower()
        if normalized_mode not in self.SUPPORTED_MODES:
            normalized_mode = "normal"

        n_samples = max(1, int(n))
        dt_step = 1.0 / float(self.fs)

        if normalized_mode == "leads_off":
            samples: list[float] = []
            for _ in range(n_samples):
                self._t_sec += dt_step
                drift = 45.0 * math.sin(2.0 * math.pi * 1.5 * self._t_sec)
                noise = float(self._rng.normal(0.0, 18.0))
                samples.append(
                    round(float(np.clip(self.AD8232_MID_MV + drift + noise, 0.0, 3300.0)), 2)
                )
            return samples, True

        batch: list[float] = []
        for _ in range(n_samples):
            self._t_sec += dt_step
            self._beat_elapsed_sec += dt_step

            if self._beat_elapsed_sec >= self._current_rr_sec:
                self._beat_elapsed_sec -= self._current_rr_sec
                self._current_rr_sec = self._next_rr_interval_sec(normalized_mode)

            r_center_sec = max(0.20, min(0.32, 0.38 * self._current_rr_sec))
            dt_from_r = self._beat_elapsed_sec - r_center_sec

            clean_phys_mv = self._evaluate_pqrst_mv(dt_from_r, normalized_mode)

            # Inject 0.25 Hz respiratory baseline wander + 50 Hz AC mains hum + Gaussian noise
            wander_mv = 0.08 * math.sin(2.0 * math.pi * 0.25 * self._t_sec)
            ac_hum_mv = 0.06 * math.sin(2.0 * math.pi * 50.0 * self._t_sec)
            gaussian_noise_mv = float(self._rng.normal(0.0, 0.016))

            total_phys_mv = clean_phys_mv + wander_mv + ac_hum_mv + gaussian_noise_mv

            if normalized_mode == "low_contact":
                # Moderate dry-skin noise (~45-55% SQI) while preserving readable QRS complexes
                dry_emg_mv = (
                    0.24 * math.sin(2.0 * math.pi * 58.0 * self._t_sec)
                    + float(self._rng.normal(0.0, 0.22))
                )
                baseline_sway_mv = 0.28 * math.sin(2.0 * math.pi * 0.85 * self._t_sec)
                total_phys_mv = 0.72 * clean_phys_mv + dry_emg_mv + baseline_sway_mv + ac_hum_mv

            elif normalized_mode == "motion_artifact":
                # Heavy broadband high-frequency EMG (45-110 Hz) + large movement swings
                emg_hf_mv = (
                    0.75 * math.sin(2.0 * math.pi * 63.0 * self._t_sec)
                    + 0.65 * math.cos(2.0 * math.pi * 87.0 * self._t_sec)
                    + float(self._rng.normal(0.0, 0.85))
                )
                motion_swing_mv = 0.95 * math.sin(2.0 * math.pi * 3.2 * self._t_sec)
                total_phys_mv += emg_hf_mv + motion_swing_mv

            raw_adc_mv = self.AD8232_MID_MV + total_phys_mv * self.AD8232_GAIN_SCALE

            if normalized_mode == "motion_artifact":
                spike_roll = float(self._rng.random())
                if spike_roll < 0.14:
                    raw_adc_mv = 15.0
                elif spike_roll < 0.28:
                    raw_adc_mv = 3285.0

            raw_adc_mv = float(np.clip(raw_adc_mv, 0.0, 3300.0))
            batch.append(round(raw_adc_mv, 2))

        return batch, False