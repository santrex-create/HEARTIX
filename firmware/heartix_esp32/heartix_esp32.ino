/*
 * ============================================================================
 * HEARTIX — REAL-TIME BIOMEDICAL ECG TELEMETRY FIRMWARE (ESP32 + AD8232)
 * ============================================================================
 *
 * ****************************************************************************
 * *                     CRITICAL ELECTRICAL SAFETY WARNING                   *
 * ****************************************************************************
 * * NEVER connect the ESP32 to a mains-powered USB wall charger, desktop PC, *
 * * or plugged-in laptop while AD8232 electrodes are attached to a human     *
 * * body! Mains leakage currents can cause fatal ventricular fibrillation.   *
 * *                                                                          *
 * * ALWAYS power the ESP32 exclusively from an isolated USB power bank or    *
 * * LiPo battery during human ECG acquisition, and use an unplugged laptop   *
 * * running on battery if viewing the Serial Monitor.                        *
 * ****************************************************************************
 *
 * Architecture:
 *  - Core 1 (Priority 3): Deterministic 250 Hz ADC1 sampling via vTaskDelayUntil
 *  - Core 0 (Priority 2): WiFiMulti + WSS (TLS) streaming via links2004/WebSockets
 *  - Lock-free double buffering + 20-second SRAM offline ring buffer (200 pkts)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#endif

// ============================================================================
// FALLBACK CONFIGURATION (USED ONLY IF secrets.h IS NOT CREATED)
// ============================================================================
#ifndef WIFI_SSID_1
  #define WIFI_SSID_1    "YOUR_PRIMARY_WIFI_SSID"
#endif
#ifndef WIFI_PASS_1
  #define WIFI_PASS_1    "YOUR_PRIMARY_WIFI_PASSWORD"
#endif
#ifndef WIFI_SSID_2
  #define WIFI_SSID_2    "YOUR_MOBILE_HOTSPOT_SSID"
#endif
#ifndef WIFI_PASS_2
  #define WIFI_PASS_2    "YOUR_MOBILE_HOTSPOT_PASSWORD"
#endif
#ifndef RENDER_HOST
  #define RENDER_HOST    "heartix.onrender.com"
#endif
#ifndef DEVICE_TOKEN
  #define DEVICE_TOKEN   "replace-with-your-secret-heartix-token"
#endif

// ============================================================================
// HARDWARE PIN DEFINITIONS (STRICTLY ADC1 TO AVOID WI-FI DRIVER CONFLICTS)
// ============================================================================
constexpr uint8_t ECG_PIN        = 34; // ADC1_CH6 (Input-only, clean analog path)
constexpr uint8_t LO_PLUS_PIN    = 32; // AD8232 LO+ Leads-Off Digital Output
constexpr uint8_t LO_MINUS_PIN   = 33; // AD8232 LO- Leads-Off Digital Output
constexpr uint8_t STATUS_LED_PIN = 2;  // Onboard ESP32 Blue LED

// ============================================================================
// LOCKED BINARY PROTOCOL CONTRACT (54 BYTES LITTLE-ENDIAN, MATCHING main.py)
// ============================================================================
constexpr uint16_t SAMPLE_RATE_HZ     = 250;
constexpr TickType_t SAMPLE_PERIOD_MS = 4;   // 1000 ms / 250 Hz = 4 ms exact
constexpr uint8_t  BATCH_SIZE         = 25;  // 25 samples * 4 ms = 100 ms (10 pkt/s)
constexpr uint16_t OFFLINE_RING_CAP   = 200; // 200 pkts = 20 seconds of SRAM backup

struct __attribute__((packed)) EcgBinaryPacket {
    uint16_t seq;                  // Bytes 0-1: incrementing sequence counter (0..65535)
    uint8_t  flags;                // Byte 2: bit 0 = leads_off (1 if LO+ or LO- HIGH)
    uint8_t  count;                // Byte 3: always 25
    uint16_t samples[BATCH_SIZE];  // Bytes 4-53: calibrated ADC readings in mV (0..3300)
};

static_assert(sizeof(EcgBinaryPacket) == 54, "Packet size must be 54 bytes");

// ============================================================================
// DOUBLE-BUFFER, QUEUE & OFFLINE SRAM RING BUFFER STATE
// ============================================================================
static EcgBinaryPacket txBuffers[2];
static EcgBinaryPacket offlineRing[OFFLINE_RING_CAP];
static uint16_t        ringHead  = 0;
static uint16_t        ringTail  = 0;
static uint16_t        ringCount = 0;

static QueueHandle_t   readyBufferQueue = nullptr;
static volatile bool   wsConnected      = false;
static volatile uint32_t lastEdgeBeatMs = 0;

void ringPush(const EcgBinaryPacket& pkt) {
    offlineRing[ringHead] = pkt;
    ringHead = (ringHead + 1) % OFFLINE_RING_CAP;
    if (ringCount < OFFLINE_RING_CAP) {
        ringCount++;
    } else {
        // Overwrite oldest packet when 20-second buffer is full
        ringTail = (ringTail + 1) % OFFLINE_RING_CAP;
    }
}

bool ringPop(EcgBinaryPacket& outPkt) {
    if (ringCount == 0) return false;
    outPkt = offlineRing[ringTail];
    ringTail = (ringTail + 1) % OFFLINE_RING_CAP;
    ringCount--;
    return true;
}

// ============================================================================
// CORE 1 TASK: DETERMINISTIC 250 HZ ECG SAMPLING + EDGE R-PEAK PULSE
// ============================================================================
void samplingTask(void* pvParameters) {
    (void)pvParameters;

    analogReadResolution(12);
    analogSetPinAttenuation(ECG_PIN, ADC_11db);

    uint8_t  activeBufIdx  = 0;
    uint8_t  sampleIdx     = 0;
    uint16_t packetSeq     = 0;
    bool     batchLeadsOff = false;

    // Lightweight edge R-peak envelope for onboard LED heartbeat pulse
    float    baselineMv    = 1650.0f;
    float    peakEnvMv     = 250.0f;
    uint32_t lastPeakTick  = 0;

    TickType_t lastWakeTime = xTaskGetTickCount();

    for (;;) {
        uint16_t mv = static_cast<uint16_t>(analogReadMilliVolts(ECG_PIN));
        bool leadsDetached = (digitalRead(LO_PLUS_PIN) == HIGH || digitalRead(LO_MINUS_PIN) == HIGH);

        if (leadsDetached) {
            batchLeadsOff = true;
        } else {
            // Track slow baseline and R-wave deflection for local LED heartbeat pulse
            baselineMv = 0.985f * baselineMv + 0.015f * static_cast<float>(mv);
            float diffMv = static_cast<float>(mv) - baselineMv;
            peakEnvMv = max(140.0f, 0.995f * peakEnvMv);
            if (diffMv > peakEnvMv) {
                peakEnvMv = 0.75f * peakEnvMv + 0.25f * diffMv;
            }
            uint32_t nowMs = millis();
            if (diffMv > (0.60f * peakEnvMv) && (nowMs - lastPeakTick) > 260) {
                lastPeakTick = nowMs;
                lastEdgeBeatMs = nowMs;
            }
        }

        txBuffers[activeBufIdx].samples[sampleIdx] = mv;
        sampleIdx++;

        if (sampleIdx >= BATCH_SIZE) {
            txBuffers[activeBufIdx].seq   = packetSeq++;
            txBuffers[activeBufIdx].flags = batchLeadsOff ? 0x01 : 0x00;
            txBuffers[activeBufIdx].count = BATCH_SIZE;

            uint8_t completedIdx = activeBufIdx;
            activeBufIdx ^= 1;
            sampleIdx     = 0;
            batchLeadsOff = false;

            xQueueSend(readyBufferQueue, &completedIdx, 0);
        }

        vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(SAMPLE_PERIOD_MS));
    }
}

// ============================================================================
// CORE 0 WEBSOCKET CLIENT & EVENT HANDLER
// ============================================================================
static WiFiMulti        wifiMulti;
static WebSocketsClient webSocket;

void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    (void)length;
    switch (type) {
        case WStype_DISCONNECTED:
            if (wsConnected) {
                Serial.println("[WS] Disconnected from Render backend. Buffering to SRAM...");
            }
            wsConnected = false;
            break;

        case WStype_CONNECTED:
            wsConnected = true;
            Serial.printf("[WS] Connected to wss://%s%s\n", RENDER_HOST, (char*)payload);
            break;

        case WStype_ERROR:
            wsConnected = false;
            Serial.println("[WS] TLS/WebSocket error encountered.");
            break;

        default:
            break;
    }
}

// ============================================================================
// STATUS LED CONTROLLER (NON-BLOCKING)
//  - Slow blink (500 ms) : Connecting to Wi-Fi
//  - Fast blink (125 ms) : Wi-Fi OK, connecting to Render WSS
//  - Solid ON + R-pulse  : Live streaming ECG packets (brief 35 ms dip per beat)
// ============================================================================
void updateStatusLed(bool wifiReady, bool serverReady) {
    static uint32_t lastToggleMs = 0;
    static bool     ledState     = false;

    uint32_t now = millis();

    if (wifiReady && serverReady) {
        bool beatDip = (now - lastEdgeBeatMs) < 35;
        bool desired = !beatDip;
        if (ledState != desired) {
            ledState = desired;
            digitalWrite(STATUS_LED_PIN, ledState ? HIGH : LOW);
        }
        return;
    }

    uint32_t intervalMs = wifiReady ? 125 : 500;
    if (now - lastToggleMs >= intervalMs) {
        lastToggleMs = now;
        ledState     = !ledState;
        digitalWrite(STATUS_LED_PIN, ledState ? HIGH : LOW);
    }
}

// ============================================================================
// CORE 0 TASK: WI-FI, TLS WEBSOCKET & PACKET TRANSMISSION
// ============================================================================
void networkTask(void* pvParameters) {
    (void)pvParameters;

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);

    wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);
    if (strlen(WIFI_SSID_2) > 0 &&
        strcmp(WIFI_SSID_2, "YOUR_MOBILE_HOTSPOT_SSID") != 0 &&
        strcmp(WIFI_SSID_2, "YOUR_BACKUP_HOTSPOT_SSID") != 0) {
        wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);
    }

    Serial.println("[WIFI] Connecting to 2.4 GHz access point...");
    while (wifiMulti.run() != WL_CONNECTED) {
        updateStatusLed(false, false);
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    Serial.printf("[WIFI] Connected! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());

    String wsPath = "/ws/esp32?token=";
    wsPath += DEVICE_TOKEN;

    webSocket.beginSSL(RENDER_HOST, 443, wsPath.c_str());
    webSocket.onEvent(onWebSocketEvent);
    webSocket.setReconnectInterval(3000);
    webSocket.enableHeartbeat(15000, 3000, 2);

    uint32_t packetsSentWindow = 0;
    uint32_t packetsBufWindow  = 0;
    uint32_t lastDiagPrintMs   = millis();
    bool     wasWifiConnected  = true;

    for (;;) {
        bool wifiOk = (wifiMulti.run() == WL_CONNECTED);

        if (wifiOk && !wasWifiConnected) {
            Serial.printf("[WIFI] Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
        } else if (!wifiOk && wasWifiConnected) {
            Serial.println("[WIFI] Connection lost. Buffering ECG in SRAM...");
            wsConnected = false;
        }
        wasWifiConnected = wifiOk;

        if (wifiOk) {
            webSocket.loop();
        }

        // Collect new packet from Core 1 into offline SRAM ring buffer
        uint8_t readyIdx = 0;
        if (xQueueReceive(readyBufferQueue, &readyIdx, pdMS_TO_TICKS(10)) == pdTRUE) {
            ringPush(txBuffers[readyIdx]);
            if (!(wifiOk && wsConnected)) {
                packetsBufWindow++;
            }
        }

        // Drain up to 4 buffered packets per iteration when WSS is live
        if (wifiOk && wsConnected && ringCount > 0) {
            uint8_t sentThisTick = 0;
            EcgBinaryPacket pktToSend;
            while (ringCount > 0 && sentThisTick < 4) {
                pktToSend = offlineRing[ringTail];
                bool ok = webSocket.sendBIN(
                    reinterpret_cast<uint8_t*>(&pktToSend),
                    sizeof(EcgBinaryPacket)
                );
                if (ok) {
                    ringPop(pktToSend);
                    packetsSentWindow++;
                    sentThisTick++;
                } else {
                    break;
                }
            }
        }

        updateStatusLed(wifiOk, wsConnected);

        uint32_t now = millis();
        if (now - lastDiagPrintMs >= 5000) {
            float pktRate = packetsSentWindow / 5.0f;
            Serial.printf(
                "[TELEMETRY] WiFi=%s | WS=%s | Rate=%.1f pkt/s | Sent=%lu | Buffered=%lu (Queue=%u) | Heap=%lu B\n",
                wifiOk ? "OK" : "DOWN",
                wsConnected ? "LIVE" : "WAIT",
                pktRate,
                static_cast<unsigned long>(packetsSentWindow),
                static_cast<unsigned long>(packetsBufWindow),
                static_cast<unsigned int>(ringCount),
                static_cast<unsigned long>(ESP.getFreeHeap())
            );
            packetsSentWindow = 0;
            packetsBufWindow  = 0;
            lastDiagPrintMs   = now;
        }
    }
}

// ============================================================================
// ARDUINO SETUP & LOOP
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(200);

    Serial.println("\n====================================================");
    Serial.println("  HEARTIX BIOMEDICAL TELEMETRY NODE (ESP32-WROOM)   ");
    Serial.println("  Protocol: 54B Packed Binary @ 250 Hz (10 pkt/s)   ");
    Serial.println("====================================================");

    pinMode(LO_PLUS_PIN, INPUT);
    pinMode(LO_MINUS_PIN, INPUT);
    pinMode(STATUS_LED_PIN, OUTPUT);
    digitalWrite(STATUS_LED_PIN, LOW);

    memset(txBuffers, 0, sizeof(txBuffers));

    readyBufferQueue = xQueueCreate(2, sizeof(uint8_t));
    if (readyBufferQueue == nullptr) {
        Serial.println("[FATAL] Failed to create FreeRTOS queue. Halting.");
        while (true) {
            delay(1000);
        }
    }

    xTaskCreatePinnedToCore(
        samplingTask,
        "EcgSamplingTask",
        4096,
        nullptr,
        3,
        nullptr,
        1
    );

    xTaskCreatePinnedToCore(
        networkTask,
        "EcgNetworkTask",
        12288, // 12 KB stack for mbedTLS / WSS handshake stability
        nullptr,
        2,
        nullptr,
        0
    );
}

void loop() {
    vTaskDelete(nullptr);
}