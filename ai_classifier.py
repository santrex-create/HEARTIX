from __future__ import annotations

import os
from typing import Any

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier


class HybridAIClassifier:
    """Lightweight Random Forest + Clinical Rules ECG Rhythm & ST Classifier."""

    CLASS_LABELS: dict[int, str] = {
        0: "NORMAL SINUS RHYTHM",
        1: "SINUS TACHYCARDIA",
        2: "SINUS BRADYCARDIA",
        3: "ARRHYTHMIA / IRREGULAR RHYTHM",
        4: "ST SEGMENT ELEVATION RISK",
    }

    FEATURE_ORDER: tuple[str, ...] = (
        "bpm",
        "rr_mean_ms",
        "rr_std_ms",
        "rmssd_ms",
        "rr_cv",
        "qrs_ms",
        "st_mv",
        "r_amp_cv",
    )

    def __init__(self, model_path: str | None = None) -> None:
        self.model: RandomForestClassifier = RandomForestClassifier(
            n_estimators=40,
            max_depth=8,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=1,
        )
        self.is_external_model: bool = False
        self._train_synthetic_mitbih_baseline()
        if model_path and os.path.isfile(model_path):
            self.load_external_model(model_path)

    def _train_synthetic_mitbih_baseline(self) -> None:
        """
        Generates a deterministic, physiologically grounded synthetic dataset
        modeled on MIT-BIH arrhythmia feature distributions across 5 classes
        and fits a compact RandomForestClassifier in <150 ms.
        """
        rng = np.random.default_rng(42)
        n_per_class = 160
        X_blocks: list[np.ndarray] = []
        y_blocks: list[np.ndarray] = []

        # Class 0: NORMAL SINUS RHYTHM (60-100 BPM, low RR CV, normal ST)
        bpm_0 = rng.uniform(61.0, 99.0, n_per_class)
        rr_mean_0 = 60000.0 / bpm_0
        rr_cv_0 = rng.uniform(0.015, 0.085, n_per_class)
        rr_std_0 = rr_mean_0 * rr_cv_0
        rmssd_0 = rr_std_0 * rng.uniform(0.85, 1.25, n_per_class)
        qrs_0 = rng.normal(88.0, 8.0, n_per_class).clip(68.0, 112.0)
        st_0 = rng.normal(0.01, 0.04, n_per_class).clip(-0.11, 0.11)
        ramp_0 = rng.uniform(0.02, 0.10, n_per_class)
        X_blocks.append(
            np.column_stack([bpm_0, rr_mean_0, rr_std_0, rmssd_0, rr_cv_0, qrs_0, st_0, ramp_0])
        )
        y_blocks.append(np.zeros(n_per_class, dtype=int))

        # Class 1: SINUS TACHYCARDIA (102-175 BPM, regular RR, normal ST)
        bpm_1 = rng.uniform(102.0, 175.0, n_per_class)
        rr_mean_1 = 60000.0 / bpm_1
        rr_cv_1 = rng.uniform(0.012, 0.080, n_per_class)
        rr_std_1 = rr_mean_1 * rr_cv_1
        rmssd_1 = rr_std_1 * rng.uniform(0.80, 1.15, n_per_class)
        qrs_1 = rng.normal(84.0, 7.5, n_per_class).clip(64.0, 108.0)
        st_1 = rng.normal(-0.01, 0.045, n_per_class).clip(-0.12, 0.12)
        ramp_1 = rng.uniform(0.02, 0.11, n_per_class)
        X_blocks.append(
            np.column_stack([bpm_1, rr_mean_1, rr_std_1, rmssd_1, rr_cv_1, qrs_1, st_1, ramp_1])
        )
        y_blocks.append(np.full(n_per_class, 1, dtype=int))

        # Class 2: SINUS BRADYCARDIA (34-58 BPM, regular RR, normal ST)
        bpm_2 = rng.uniform(34.0, 58.5, n_per_class)
        rr_mean_2 = 60000.0 / bpm_2
        rr_cv_2 = rng.uniform(0.018, 0.095, n_per_class)
        rr_std_2 = rr_mean_2 * rr_cv_2
        rmssd_2 = rr_std_2 * rng.uniform(0.90, 1.30, n_per_class)
        qrs_2 = rng.normal(92.0, 8.5, n_per_class).clip(70.0, 116.0)
        st_2 = rng.normal(0.00, 0.04, n_per_class).clip(-0.11, 0.11)
        ramp_2 = rng.uniform(0.02, 0.10, n_per_class)
        X_blocks.append(
            np.column_stack([bpm_2, rr_mean_2, rr_std_2, rmssd_2, rr_cv_2, qrs_2, st_2, ramp_2])
        )
        y_blocks.append(np.full(n_per_class, 2, dtype=int))

        # Class 3: ARRHYTHMIA / IRREGULAR RHYTHM (high RR variability / ectopic timing)
        bpm_3 = rng.uniform(48.0, 145.0, n_per_class)
        rr_mean_3 = 60000.0 / bpm_3
        rr_cv_3 = rng.uniform(0.165, 0.42, n_per_class)
        rr_std_3 = rr_mean_3 * rr_cv_3
        rmssd_3 = rr_std_3 * rng.uniform(1.05, 1.65, n_per_class)
        qrs_3 = rng.normal(104.0, 16.0, n_per_class).clip(74.0, 155.0)
        st_3 = rng.normal(0.00, 0.06, n_per_class).clip(-0.13, 0.13)
        ramp_3 = rng.uniform(0.08, 0.28, n_per_class)
        X_blocks.append(
            np.column_stack([bpm_3, rr_mean_3, rr_std_3, rmssd_3, rr_cv_3, qrs_3, st_3, ramp_3])
        )
        y_blocks.append(np.full(n_per_class, 3, dtype=int))

        # Class 4: ST SEGMENT ELEVATION RISK (significant ST deviation >= 0.15 mV or <= -0.15 mV)
        bpm_4 = rng.uniform(58.0, 118.0, n_per_class)
        rr_mean_4 = 60000.0 / bpm_4
        rr_cv_4 = rng.uniform(0.02, 0.11, n_per_class)
        rr_std_4 = rr_mean_4 * rr_cv_4
        rmssd_4 = rr_std_4 * rng.uniform(0.85, 1.25, n_per_class)
        qrs_4 = rng.normal(94.0, 10.0, n_per_class).clip(72.0, 128.0)
        st_signs = rng.choice([-1.0, 1.0, 1.0, 1.0], size=n_per_class)
        st_4 = st_signs * rng.uniform(0.16, 0.45, n_per_class)
        ramp_4 = rng.uniform(0.03, 0.14, n_per_class)
        X_blocks.append(
            np.column_stack([bpm_4, rr_mean_4, rr_std_4, rmssd_4, rr_cv_4, qrs_4, st_4, ramp_4])
        )
        y_blocks.append(np.full(n_per_class, 4, dtype=int))

        X = np.vstack(X_blocks)
        y = np.concatenate(y_blocks)
        self.model.fit(X, y)

    def load_external_model(self, path: str) -> None:
        """Loads a pre-trained joblib model artifact without changing caller contracts."""
        loaded: Any = joblib.load(path)
        if isinstance(loaded, dict) and "model" in loaded:
            self.model = loaded["model"]
        else:
            self.model = loaded
        self.is_external_model = True

    def classify(self, features: dict, min_hr: int = 60, max_hr: int = 100) -> dict:
        """
        Combines RandomForest probability inference with deterministic clinical guardrails.
        """
        bpm = float(features.get("bpm", 75.0))
        rr_mean_ms = float(features.get("rr_mean_ms", 60000.0 / max(bpm, 25.0)))
        rr_std_ms = float(features.get("rr_std_ms", 25.0))
        rmssd_ms = float(features.get("rmssd_ms", 28.0))
        rr_cv = float(features.get("rr_cv", rr_std_ms / max(rr_mean_ms, 1.0)))
        qrs_ms = float(features.get("qrs_ms", 88.0))
        st_mv = float(features.get("st_mv", 0.0))
        r_amp_cv = float(features.get("r_amp_cv", 0.04))

        vec = np.array(
            [[bpm, rr_mean_ms, rr_std_ms, rmssd_ms, rr_cv, qrs_ms, st_mv, r_amp_cv]],
            dtype=np.float64,
        )

        probs = self.model.predict_proba(vec)[0]
        pred_idx = int(np.argmax(probs))
        ml_label = self.CLASS_LABELS.get(pred_idx, "NORMAL SINUS RHYTHM")
        ml_conf = float(probs[pred_idx]) * 100.0

        # Clinical condition flags
        is_brady = bpm < float(min_hr)
        is_tachy = bpm > float(max_hr)
        is_extreme_brady = bpm < 45.0
        is_extreme_tachy = bpm > 130.0
        is_arrhythmia = (rr_cv >= 0.16) or (rmssd_ms >= 135.0 and rr_cv >= 0.13)
        is_st_risk = abs(st_mv) >= 0.15

        # Hybrid arbitration: synchronize ML probabilities with hard clinical boundaries
        reasons: list[str] = []
        chosen_label = ml_label
        chosen_conf = ml_conf

        if is_arrhythmia:
            chosen_label = "ARRHYTHMIA / IRREGULAR RHYTHM"
            rule_boost = min(99.0, 78.0 + (rr_cv - 0.16) * 110.0)
            chosen_conf = max( float(probs[3]) * 100.0, rule_boost )
            reasons.append(
                f"Irregular R-R cadence detected (RR CV {rr_cv * 100:.1f}%, RMSSD {rmssd_ms:.0f} ms)"
            )
            if is_st_risk:
                reasons.append(f"concurrent ST deviation ({st_mv:+.2f} mV)")
        elif is_st_risk:
            chosen_label = "ST SEGMENT ELEVATION RISK"
            rule_boost = min(98.0, 80.0 + (abs(st_mv) - 0.15) * 90.0)
            chosen_conf = max(float(probs[4]) * 100.0, rule_boost)
            direction = "elevation" if st_mv > 0 else "depression"
            reasons.append(
                f"ST segment {direction} of {st_mv:+.2f} mV exceeds +/-0.15 mV screening threshold"
            )
            if is_tachy:
                reasons.append(f"HR elevated at {bpm:.0f} BPM")
            elif is_brady:
                reasons.append(f"HR low at {bpm:.0f} BPM")
        elif is_tachy:
            chosen_label = "SINUS TACHYCARDIA"
            margin = (bpm - float(max_hr)) / max(float(max_hr), 1.0)
            rule_boost = min(98.0, 82.0 + margin * 60.0)
            chosen_conf = max(float(probs[1]) * 100.0, rule_boost)
            if is_extreme_tachy:
                reasons.append(
                    f"Critical tachycardia ({bpm:.0f} BPM > 130 BPM high-alarm threshold)"
                )
            else:
                reasons.append(
                    f"Heart rate {bpm:.0f} BPM exceeds upper limit ({max_hr} BPM) with regular rhythm"
                )
        elif is_brady:
            chosen_label = "SINUS BRADYCARDIA"
            margin = (float(min_hr) - bpm) / max(float(min_hr), 1.0)
            rule_boost = min(98.0, 82.0 + margin * 65.0)
            chosen_conf = max(float(probs[2]) * 100.0, rule_boost)
            if is_extreme_brady:
                reasons.append(
                    f"Critical bradycardia ({bpm:.0f} BPM < 45 BPM high-alarm threshold)"
                )
            else:
                reasons.append(
                    f"Heart rate {bpm:.0f} BPM below lower limit ({min_hr} BPM) with regular rhythm"
                )
        else:
            chosen_label = "NORMAL SINUS RHYTHM"
            chosen_conf = max(float(probs[0]) * 100.0, 86.0)
            reasons.append(
                f"Regular sinus cadence ({bpm:.0f} BPM, RR CV {rr_cv * 100:.1f}%, ST {st_mv:+.2f} mV)"
            )

        # Alarm priority determination
        if is_arrhythmia or is_extreme_brady or is_extreme_tachy:
            alarm_level = "high"
        elif is_brady or is_tachy or is_st_risk:
            alarm_level = "medium"
        else:
            alarm_level = "none"

        confidence_pct = int(np.clip(round(chosen_conf), 50, 99))

        return {
            "label": chosen_label,
            "confidence_pct": confidence_pct,
            "alarm_level": alarm_level,
            "reason": "; ".join(reasons) + ".",
            "bradycardia": bool(is_brady),
            "tachycardia": bool(is_tachy),
            "arrhythmia": bool(is_arrhythmia),
        }