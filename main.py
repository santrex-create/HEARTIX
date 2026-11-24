from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import struct
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ai_classifier import HybridAIClassifier
from ecg_processor import ECGProcessor
from ecg_simulator import ECGSimulator

os.makedirs("static", exist_ok=True)


def _get_admin_pin() -> str:
    return os.getenv("HEARTIX_ADMIN_PIN", "").strip()


def _verify_admin_pin(provided_pin: str | None) -> bool:
    expected = _get_admin_pin()
    if not expected:
        return True
    return (provided_pin or "").strip() == expected


class PatientModel(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    age: int = Field(..., ge=0, le=130)
    gender: str = Field(..., min_length=1, max_length=32)
    patient_id: str = Field(..., min_length=1, max_length=64)
    bed: str = Field(default="", max_length=32)
    min_hr: int = Field(default=60, ge=30, le=110)
    max_hr: int = Field(default=100, ge=50, le=220)
    notes: str = Field(default="", max_length=500)


class HeartixHub:
    """
    Central Real-Time Telemetry Hub managing:
    - Single active ESP32 hardware stream (with automatic reconnect takeover & priority)
    - Operator and read-only Observer browser WebSocket viewers
    - Dual-path ECGProcessor & 250 Hz ECGSimulator state
    - Sequence gap tracking, packet-loss telemetry, and 25-event clinical abnormality memory
    """

    def __init__(self) -> None:
        self.classifier = HybridAIClassifier()
        self.processor = ECGProcessor(fs=250, classifier=self.classifier)
        self.simulator = ECGSimulator(fs=250)

        self.esp32_ws: WebSocket | None = None
        self.esp32_connected: bool = False
        self.last_esp32_packet_ts: float = 0.0
        self.disconnected_mid_session: bool = False

        # Simulator defaults to None (OFF) on server boot
        self.sim_mode: str | None = None

        self.web_clients: set[WebSocket] = set()
        self.observer_clients: set[WebSocket] = set()

        # Rolling sequence & packet telemetry over a 10-second window
        self.last_seq: int | None = None
        self._packet_window: deque[tuple[float, int, int, int]] = deque(maxlen=250)
        self.packet_loss_pct: float = 0.0
        self.effective_hz: float = 0.0
        self.latest_sqi: int | None = None
        self.latest_metrics_payload: dict[str, Any] | None = None

        # Clinical abnormality events (capped at 25 in-memory records)
        self.events: deque[dict[str, Any]] = deque(maxlen=25)
        self.last_event_ts_by_label: dict[str, float] = {}

        # Active patient metadata
        self.patient: dict[str, Any] = {
            "name": "",
            "age": None,
            "gender": "",
            "patient_id": "",
            "bed": "",
            "min_hr": 60,
            "max_hr": 100,
            "notes": "",
        }

    def reset_telemetry(self) -> None:
        """Clears sequence counters and rolling packet-loss / sample-rate statistics."""
        self.last_seq = None
        self._packet_window.clear()
        self.packet_loss_pct = 0.0
        self.effective_hz = 0.0
        self.latest_sqi = None
        self.latest_metrics_payload = None

    def record_esp32_packet(self, seq: int | None, sample_count: int) -> None:
        """
        Tracks uint16 sequence wraparound (0-65535), computes rolling packet_loss_pct
        and effective_hz (smoothed against cold-start bursts), and resets causal DSP
        filters if a packet gap > 3 occurs.
        """
        now = time.monotonic()
        lost = 0

        if seq is not None:
            seq_u16 = int(seq) & 0xFFFF
            if self.last_seq is not None:
                delta = (seq_u16 - self.last_seq) & 0xFFFF
                if delta in (0, 1):
                    lost = 0
                elif 1 < delta <= 1000:
                    lost = delta - 1
                    if lost > 3:
                        self.processor.reset_filters()
                else:
                    lost = 0
                    self.processor.reset_filters()
            self.last_seq = seq_u16

        self._packet_window.append((now, 1, lost, sample_count))

        cutoff = now - 10.0
        while self._packet_window and self._packet_window[0][0] < cutoff:
            self._packet_window.popleft()

        total_recv = sum(item[1] for item in self._packet_window)
        total_lost = sum(item[2] for item in self._packet_window)
        total_expected = total_recv + total_lost

        if total_expected > 0:
            self.packet_loss_pct = round((total_lost / float(total_expected)) * 100.0, 2)
        else:
            self.packet_loss_pct = 0.0

        if len(self._packet_window) >= 2:
            elapsed = now - self._packet_window[0][0]
            if elapsed >= 0.25:
                samples_after_first = sum(item[3] for item in list(self._packet_window)[1:])
                raw_hz = samples_after_first / elapsed
                self.effective_hz = round(min(255.0, max(0.0, raw_hz)), 1)
            else:
                self.effective_hz = 250.0
        elif len(self._packet_window) == 1:
            self.effective_hz = 250.0
        else:
            self.effective_hz = 0.0

    def build_state_payload(self, is_observer: bool = False) -> dict[str, Any]:
        """Constructs the canonical state synchronization message for web clients."""
        return {
            "type": "state",
            "esp32_connected": self.esp32_connected,
            "sim_mode": self.sim_mode,
            "packet_loss_pct": self.packet_loss_pct,
            "effective_hz": self.effective_hz,
            "disconnected_mid_session": self.disconnected_mid_session,
            "pin_required": bool(_get_admin_pin()),
            "observer_mode": is_observer,
            "patient": self.patient,
        }

    def build_disconnect_metrics_payload(self) -> dict[str, Any]:
        """Constructs offline telemetry metrics with a low-priority technical disconnect alarm."""
        return {
            "type": "metrics",
            "valid_signal": False,
            "status": "ESP32 DISCONNECTED — CHECK DEVICE",
            "alarm_level": "low",
            "sqi": 0,
            "bpm": None,
            "rr_ms": None,
            "hrv_ms": None,
            "qrs_ms": None,
            "st_mv": None,
            "st_status": None,
            "ai_label": "ESP32 DISCONNECTED",
            "ai_confidence": None,
            "ai_reason": "ESP32 hardware telemetry stream interrupted or timed out.",
            "bradycardia": False,
            "tachycardia": False,
            "arrhythmia": False,
            "pvc_count": 0,
            "event_count": len(self.events),
            "packet_loss_pct": self.packet_loss_pct,
            "effective_hz": self.effective_hz,
        }

    async def broadcast_json(self, payload: dict[str, Any]) -> None:
        """Broadcasts a JSON dictionary to all connected browser clients and prunes dead sockets."""
        if not self.web_clients:
            return
        dead_clients: list[WebSocket] = []
        message_text = json.dumps(payload)
        for ws in list(self.web_clients):
            try:
                await ws.send_text(message_text)
            except Exception:
                dead_clients.append(ws)
        for ws in dead_clients:
            self.web_clients.discard(ws)
            self.observer_clients.discard(ws)

    async def broadcast_state(self) -> None:
        """Broadcasts the current system state to operator and observer browser clients."""
        if not self.web_clients:
            return
        dead_clients: list[WebSocket] = []
        op_msg = json.dumps(self.build_state_payload(is_observer=False))
        obs_msg = json.dumps(self.build_state_payload(is_observer=True))
        for ws in list(self.web_clients):
            try:
                await ws.send_text(obs_msg if ws in self.observer_clients else op_msg)
            except Exception:
                dead_clients.append(ws)
        for ws in dead_clients:
            self.web_clients.discard(ws)
            self.observer_clients.discard(ws)


hub = HeartixHub()


async def esp32_watchdog_loop() -> None:
    """
    Runs every 0.5s. If esp32_connected is True and no packet has arrived for 2.5 seconds,
    forcefully closes the dead ESP32 socket, resets processor/telemetry, and broadcasts
    updated state + offline metrics.
    """
    while True:
        await asyncio.sleep(0.5)
        if hub.esp32_connected:
            elapsed = time.monotonic() - hub.last_esp32_packet_ts
            if elapsed > 2.5:
                dead_ws = hub.esp32_ws
                hub.esp32_ws = None
                hub.esp32_connected = False
                hub.disconnected_mid_session = True
                hub.processor.reset()
                hub.reset_telemetry()

                if dead_ws is not None:
                    try:
                        await dead_ws.close(code=1001, reason="Watchdog timeout (>2.5s silence)")
                    except Exception:
                        pass

                await hub.broadcast_state()
                disconnect_payload = hub.build_disconnect_metrics_payload()
                hub.latest_metrics_payload = disconnect_payload
                await hub.broadcast_json(disconnect_payload)


async def analysis_loop() -> None:
    """
    Runs every 1.0s. When esp32_connected OR sim_mode is active, executes
    processor.analyze_window() in a worker thread, logs medium/high alarm events
    with a 10-second per-label cooldown (capped at 25 events), and broadcasts metrics.
    """
    while True:
        await asyncio.sleep(1.0)
        if not (hub.esp32_connected or hub.sim_mode is not None):
            continue

        result = await asyncio.to_thread(hub.processor.analyze_window)
        if result.get("sqi") is not None:
            hub.latest_sqi = int(result["sqi"])

        if result.get("valid_signal") is True and result.get("alarm_level") in ("medium", "high"):
            ai_label = str(result.get("ai_label") or "ABNORMALITY")
            now_mono = time.monotonic()
            last_logged = hub.last_event_ts_by_label.get(ai_label, -999.0)
            if (now_mono - last_logged) >= 10.0:
                hub.last_event_ts_by_label[ai_label] = now_mono
                waveform_5s = await asyncio.to_thread(hub.processor.get_recent_snapshot, 5.0)
                now_iso = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
                reason_txt = str(result.get("ai_reason") or "Physiological threshold breach")
                alarm_lvl = str(result.get("alarm_level") or "medium")

                event_record = {
                    "id": uuid.uuid4().hex[:10],
                    "timestamp": now_iso,
                    "type": ai_label,
                    "description": reason_txt,
                    "reason": reason_txt,
                    "severity": alarm_lvl,
                    "alarm_level": alarm_lvl,
                    "source": "esp32" if hub.esp32_connected else f"simulator:{hub.sim_mode}",
                    "ai_label": ai_label,
                    "ai_confidence": result.get("ai_confidence"),
                    "ai_reason": reason_txt,
                    "bpm": result.get("bpm"),
                    "rr_ms": result.get("rr_ms"),
                    "hrv_ms": result.get("hrv_ms"),
                    "qrs_ms": result.get("qrs_ms"),
                    "st_mv": result.get("st_mv"),
                    "st_status": result.get("st_status"),
                    "sqi": result.get("sqi"),
                    "bradycardia": result.get("bradycardia"),
                    "tachycardia": result.get("tachycardia"),
                    "arrhythmia": result.get("arrhythmia"),
                    "patient_id": hub.patient.get("patient_id", ""),
                    "patient_name": hub.patient.get("name", ""),
                    "waveform_strip": waveform_5s,
                    "waveform_5s": waveform_5s,
                }
                hub.events.appendleft(event_record)

        metrics_payload = {
            "type": "metrics",
            **result,
            "event_count": len(hub.events),
            "packet_loss_pct": hub.packet_loss_pct,
            "effective_hz": hub.effective_hz,
        }
        hub.latest_metrics_payload = metrics_payload
        await hub.broadcast_json(metrics_payload)


async def simulator_loop() -> None:
    """
    Runs every 0.1s (10 Hz). Active ONLY when not esp32_connected, sim_mode is set,
    and at least 1 web client is connected. Generates 25 samples at 250 Hz, feeds
    them through processor.ingest_batch(), and broadcasts ecg_batch.
    """
    next_tick = time.monotonic()
    while True:
        next_tick += 0.1
        sleep_dur = max(0.005, next_tick - time.monotonic())
        await asyncio.sleep(sleep_dur)

        if time.monotonic() - next_tick > 0.5:
            next_tick = time.monotonic()

        if hub.esp32_connected or hub.sim_mode is None or len(hub.web_clients) == 0:
            continue

        raw_mv, leads_off = hub.simulator.generate_batch(hub.sim_mode, 25)
        fast_out = hub.processor.ingest_batch(raw_mv, leads_off=leads_off)
        hub.packet_loss_pct = 0.0
        hub.effective_hz = 250.0

        await hub.broadcast_json(
            {
                "type": "ecg_batch",
                "source": "simulator",
                "mode": hub.sim_mode,
                "samples": fast_out["samples"],
                "r_peak_offsets": fast_out["r_peak_offsets"],
                "leads_off": fast_out["leads_off"],
                "calibrating": fast_out["calibrating"],
            }
        )


async def web_keepalive_loop() -> None:
    """
    Runs every 20s. Sends {"type": "ping"} to all connected /ws/web clients
    and prunes unresponsive connections.
    """
    while True:
        await asyncio.sleep(20.0)
        await hub.broadcast_json({"type": "ping"})


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [
        asyncio.create_task(esp32_watchdog_loop(), name="esp32_watchdog"),
        asyncio.create_task(analysis_loop(), name="analysis_loop"),
        asyncio.create_task(simulator_loop(), name="simulator_loop"),
        asyncio.create_task(web_keepalive_loop(), name="web_keepalive"),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(
    title="Heartix Smart ECG Monitoring System",
    version="1.1.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def serve_index():
    index_path = os.path.join("static", "index.html")
    if os.path.isfile(index_path):
        return FileResponse(index_path)
    return HTMLResponse(
        content="<!DOCTYPE html><html><head><title>Heartix</title></head>"
        "<body><h1>Heartix Backend Active</h1><p>Awaiting static/index.html</p></body></html>",
        status_code=200,
    )


@app.get("/health")
async def health_check() -> dict[str, Any]:
    return {
        "status": "ok",
        "esp32_connected": hub.esp32_connected,
        "sim_mode": hub.sim_mode,
        "packet_loss_pct": hub.packet_loss_pct,
        "effective_hz": hub.effective_hz,
        "active_viewers": len(hub.web_clients),
        "observer_viewers": len(hub.observer_clients),
        "pin_required": bool(_get_admin_pin()),
    }


@app.get("/api/events")
async def get_events() -> dict[str, Any]:
    return {"events": list(hub.events)}


@app.post("/api/session/reset")
async def reset_session(
    x_admin_pin: str | None = Header(default=None),
) -> dict[str, str]:
    if not _verify_admin_pin(x_admin_pin):
        raise HTTPException(status_code=403, detail="Invalid or missing admin PIN")

    hub.processor.reset()
    hub.simulator.reset()
    hub.reset_telemetry()
    hub.events.clear()
    hub.last_event_ts_by_label.clear()
    hub.disconnected_mid_session = False

    if hub.sim_mode is not None and not hub.esp32_connected:
        hub.effective_hz = 250.0

    await hub.broadcast_json({"type": "reset"})
    await hub.broadcast_state()
    return {"status": "reset"}


@app.post("/api/patient")
async def update_patient(
    patient: PatientModel,
    x_admin_pin: str | None = Header(default=None),
) -> dict[str, Any]:
    if not _verify_admin_pin(x_admin_pin):
        raise HTTPException(status_code=403, detail="Invalid or missing admin PIN")

    min_hr = min(patient.min_hr, patient.max_hr - 10)
    max_hr = max(patient.max_hr, min_hr + 10)

    hub.patient = {
        "name": patient.name.strip(),
        "age": patient.age,
        "gender": patient.gender.strip(),
        "patient_id": patient.patient_id.strip(),
        "bed": patient.bed.strip(),
        "min_hr": min_hr,
        "max_hr": max_hr,
        "notes": patient.notes.strip(),
    }
    hub.processor.set_hr_limits(min_hr, max_hr)
    await hub.broadcast_state()
    return {"status": "ok", "patient": hub.patient}


@app.get("/api/export/csv")
async def export_csv() -> StreamingResponse:
    records = await asyncio.to_thread(hub.processor.get_session_records)
    patient = hub.patient
    now_utc = datetime.now(timezone.utc)
    ts_str = now_utc.strftime("%Y%m%d_%H%M%S")
    latest_sqi = hub.latest_sqi

    raw_pid = str(patient.get("patient_id") or "anonymous").strip()
    safe_pid = re.sub(r"[^A-Za-z0-9_-]+", "_", raw_pid).strip("_") or "anonymous"
    filename = f"heartix_{safe_pid}_{ts_str}.csv"

    def csv_generator():
        buf = io.StringIO()
        buf.write("# HEARTIX SMART ECG TELEMETRY EXPORT\n")
        buf.write(f"# Patient Name: {patient.get('name') or 'N/A'}\n")
        buf.write(f"# Age: {patient.get('age') if patient.get('age') is not None else 'N/A'}\n")
        buf.write(f"# Gender: {patient.get('gender') or 'N/A'}\n")
        buf.write(f"# Patient ID: {patient.get('patient_id') or 'N/A'}\n")
        buf.write(f"# Bed: {patient.get('bed') or 'N/A'}\n")
        buf.write(f"# HR Limits: {patient.get('min_hr', 60)} - {patient.get('max_hr', 100)} BPM\n")
        buf.write(f"# Notes: {patient.get('notes') or 'None'}\n")
        buf.write(f"# Export Time (UTC): {now_utc.isoformat()}\n")

        writer = csv.writer(buf)
        writer.writerow(["timestamp_iso", "ecg_mv", "bpm", "sqi_pct", "status"])
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        chunk_count = 0
        for rec in records:
            ts_val = float(rec.get("ts", 0.0))
            iso_ts = datetime.fromtimestamp(ts_val, tz=timezone.utc).isoformat()
            ecg_mv = rec.get("ecg_mv", 0.0)
            bpm_val = "" if rec.get("bpm") is None else rec.get("bpm")
            sqi_val = "" if latest_sqi is None else latest_sqi
            status_val = rec.get("status", "")
            writer.writerow([iso_ts, ecg_mv, bpm_val, sqi_val, status_val])
            chunk_count += 1
            if chunk_count >= 1000:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)
                chunk_count = 0

        if chunk_count > 0:
            yield buf.getvalue()

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
    }
    return StreamingResponse(csv_generator(), media_type="text/csv", headers=headers)


@app.websocket("/ws/esp32")
async def ws_esp32_endpoint(
    websocket: WebSocket,
    token: str = Query(default=""),
) -> None:
    expected_token = os.getenv("HEARTIX_DEVICE_TOKEN", "heartix-dev-token")
    await websocket.accept()

    if not token or token != expected_token:
        await websocket.close(code=1008, reason="Invalid HEARTIX_DEVICE_TOKEN")
        return

    # Graceful Reconnect Takeover: close any stale ESP32 connection before taking over
    if hub.esp32_ws is not None and hub.esp32_ws is not websocket:
        old_ws = hub.esp32_ws
        hub.esp32_ws = None
        try:
            await old_ws.close(code=1012, reason="Superseded by new ESP32 connection")
        except Exception:
            pass

    # Hardware Priority: immediately disable simulator, reset DSP & telemetry, and notify clients
    hub.esp32_ws = websocket
    hub.esp32_connected = True
    hub.sim_mode = None
    hub.disconnected_mid_session = False
    hub.last_esp32_packet_ts = time.monotonic()
    hub.processor.reset()
    hub.reset_telemetry()
    await hub.broadcast_state()

    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")
            if msg_type == "websocket.disconnect":
                break

            raw_mv: list[float] = []
            leads_off: bool = False

            if message.get("bytes") is not None:
                data: bytes = message["bytes"]
                if len(data) < 4:
                    continue
                seq, flags, count = struct.unpack("<HBB", data[:4])
                leads_off = bool(flags & 0x01)
                expected_bytes = 4 + 2 * count
                if count == 0 or len(data) < expected_bytes:
                    continue
                samples_u16 = struct.unpack(f"<{count}H", data[4:expected_bytes])
                raw_mv = [float(val) for val in samples_u16]
                hub.record_esp32_packet(seq, count)

            elif message.get("text") is not None:
                try:
                    payload = json.loads(message["text"])
                except Exception:
                    continue
                if not isinstance(payload, dict):
                    continue
                leads_off = bool(payload.get("leads_off", False))
                raw_samples = payload.get("samples", [])
                if not isinstance(raw_samples, list) or len(raw_samples) == 0:
                    continue
                raw_mv = [float(val) for val in raw_samples]
                seq_val = payload.get("seq")
                hub.record_esp32_packet(
                    int(seq_val) if isinstance(seq_val, int) else None,
                    len(raw_mv),
                )
            else:
                continue

            hub.last_esp32_packet_ts = time.monotonic()
            fast_out = hub.processor.ingest_batch(raw_mv, leads_off=leads_off)

            await hub.broadcast_json(
                {
                    "type": "ecg_batch",
                    "source": "esp32",
                    "samples": fast_out["samples"],
                    "r_peak_offsets": fast_out["r_peak_offsets"],
                    "leads_off": fast_out["leads_off"],
                    "calibrating": fast_out["calibrating"],
                }
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if hub.esp32_ws is websocket:
            hub.esp32_ws = None
            hub.esp32_connected = False
            hub.disconnected_mid_session = True
            hub.processor.reset()
            hub.reset_telemetry()
            await hub.broadcast_state()
            disconnect_payload = hub.build_disconnect_metrics_payload()
            hub.latest_metrics_payload = disconnect_payload
            await hub.broadcast_json(disconnect_payload)


@app.websocket("/ws/web")
async def ws_web_endpoint(
    websocket: WebSocket,
    mode: str = Query(default="operator"),
    pin: str = Query(default=""),
) -> None:
    await websocket.accept()
    is_observer = str(mode).strip().lower() == "observer"
    hub.web_clients.add(websocket)
    if is_observer:
        hub.observer_clients.add(websocket)

    try:
        await websocket.send_text(json.dumps(hub.build_state_payload(is_observer=is_observer)))
        if hub.latest_metrics_payload is not None:
            await websocket.send_text(json.dumps(hub.latest_metrics_payload))

        while True:
            raw_text = await websocket.receive_text()
            try:
                cmd = json.loads(raw_text)
            except Exception:
                continue
            if not isinstance(cmd, dict):
                continue

            action = cmd.get("action")

            if action == "simulate":
                if is_observer or hub.esp32_connected:
                    continue
                if not _verify_admin_pin(str(cmd.get("pin", pin))):
                    continue
                requested_mode = str(cmd.get("mode", "normal")).strip().lower()
                if requested_mode not in ECGSimulator.SUPPORTED_MODES:
                    continue
                if hub.sim_mode is None:
                    hub.processor.reset()
                    hub.simulator.reset()
                hub.sim_mode = requested_mode
                hub.disconnected_mid_session = False
                hub.packet_loss_pct = 0.0
                hub.effective_hz = 250.0
                await hub.broadcast_state()

            elif action == "stop_sim":
                if is_observer:
                    continue
                if not _verify_admin_pin(str(cmd.get("pin", pin))):
                    continue
                if hub.sim_mode is not None:
                    hub.sim_mode = None
                    hub.processor.reset()
                    hub.simulator.reset()
                    hub.reset_telemetry()
                    await hub.broadcast_state()

            elif action == "pong":
                continue

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.web_clients.discard(websocket)
        hub.observer_clients.discard(websocket)