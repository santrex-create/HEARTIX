from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ai_classifier import HybridAIClassifier
from ecg_processor import ECGProcessor
from ecg_simulator import ECGSimulator


def _feed_seconds(proc: ECGProcessor, sim: ECGSimulator, mode: str, seconds: float = 4.0) -> dict:
    batches = int((seconds * 250) // 25)
    for _ in range(batches):
        raw_mv, leads_off = sim.generate_batch(mode, 25)
        proc.ingest_batch(raw_mv, leads_off=leads_off)
    return proc.analyze_window()


def test_normal_sinus_bpm_and_metrics():
    sim = ECGSimulator(fs=250)
    proc = ECGProcessor(fs=250)
    res = _feed_seconds(proc, sim, "normal", seconds=5.0)

    assert res["valid_signal"] is True
    assert res["bpm"] is not None and 68 <= res["bpm"] <= 82
    assert res["rr_ms"] is not None and 730 <= res["rr_ms"] <= 890
    assert res["qrs_ms"] is not None and 64 <= res["qrs_ms"] <= 130
    assert res["ai_label"] == "NORMAL SINUS RHYTHM"


def test_parameters_remain_visible_below_60_sqi():
    sim = ECGSimulator(fs=250)
    proc = ECGProcessor(fs=250)
    res = _feed_seconds(proc, sim, "low_contact", seconds=5.0)

    assert res["valid_signal"] is True
    assert res["sqi"] < 70
    assert res["bpm"] is not None
    assert res["rr_ms"] is not None
    assert res["hrv_ms"] is not None
    assert res["qrs_ms"] is not None
    assert res["st_mv"] is not None


def test_leads_off_disables_metrics_safely():
    sim = ECGSimulator(fs=250)
    proc = ECGProcessor(fs=250)
    res = _feed_seconds(proc, sim, "leads_off", seconds=3.0)

    assert res["valid_signal"] is False
    assert res["bpm"] is None
    assert res["alarm_level"] == "technical"
    assert res["ai_label"] == "LEADS OFF"


def test_ai_classifier_rhythm_categories():
    clf = HybridAIClassifier()

    tachy = clf.classify({"bpm": 135.0, "rr_cv": 0.04, "rmssd_ms": 18.0, "st_mv": 0.0})
    assert tachy["tachycardia"] is True
    assert tachy["label"] == "SINUS TACHYCARDIA"

    brady = clf.classify({"bpm": 44.0, "rr_cv": 0.05, "rmssd_ms": 30.0, "st_mv": 0.0})
    assert brady["bradycardia"] is True
    assert brady["label"] == "SINUS BRADYCARDIA"

    arr = clf.classify({"bpm": 88.0, "rr_cv": 0.28, "rmssd_ms": 180.0, "st_mv": 0.0})
    assert arr["arrhythmia"] is True
    assert arr["label"] == "ARRHYTHMIA / IRREGULAR RHYTHM"