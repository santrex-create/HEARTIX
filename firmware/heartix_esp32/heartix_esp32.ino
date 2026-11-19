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
 *  - Zero-copy lock-free double buffering (54-byte packed binary frames, 10 Hz)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>

// ============================================================================
// USER CONFIGURATION — UPDATE THESE 3 SECTIONS BEFORE FLASHING
// ============================================================================

// 1. 2.4 GHz Wi-Fi Credentials (ESP32 does not support 5 GHz Wi-Fi)
#define WIFI_SSID_1      "YOUR_PRIMARY_WIFI_SSID"
#define WIFI_PASS_1      "YOUR_PRIMARY_WIFI_PASSWORD"

#define WIFI_SSID_2      "YOUR_MOBILE_HOTSPOT_SSID"
#define WIFI_PASS_2      "YOUR_MOBILE_HOTSPOT_PASSWORD"

// 2. Render Cloud Hostname (DO NOT include "https://" or trailing "/")
#define RENDER_HOST      "heartix-monitor.onrender.com"

// 3. Device Authentication Token (MUST match HEARTIX_DEVICE_TOKEN on Render)
#define DEVICE_TOKEN     "replace-with-your-secret-heartix-token"

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

struct __attribute__((packed)) EcgBinaryPacket {
    uint16_t seq;                  // Bytes 0-1: incrementing sequence counter (0..65535)
    uint8_t  flags;                // Byte 2: bit 0 = leads_off (1 if LO+ or LO- HIGH)
    uint8_t  count;                // Byte 3: always 25
    uint16_t samples[BATCH_SIZE];  // Bytes 4-53: calibrated ADC readings in mV (0..3300)
};

static_assert(sizeof(EcgBinaryPacket) == 54, "Packet size must be 54 bytes");

// ============================================================================
// DOUBLE-BUFFER & SINGLE-QUEUE IPC STATE (NO MUTEXES REQUIRED)
// ============================================================================
static EcgBinaryPacket txBuffers[2];
static QueueHandle_t   readyBufferQueue = nullptr;

// Shared state flags between Core 0 and Core 1 (atomic single-byte reads/writes)
static volatile bool wsConnected = false;

// ============================================================================
// CORE 1 TASK: DETERMINISTIC 250 HZ ECG SAMPLING
// ============================================================================
void samplingTask(void* pvParameters) {
    (void)pvParameters;

    // Configure ADC1 for 0 - 3300 mV calibrated millivolt output
    analogReadResolution(12);
    analogSetPinAttenuation(ECG_PIN, ADC_11db);

    uint8_t  activeBufIdx = 0;
    uint8_t  sampleIdx    = 0;
    uint16_t packetSeq    = 0;
    bool     batchLeadsOff = false;

    TickType_t lastWakeTime = xTaskGetTickCount();

    for (;;) {
        // 1. Read raw calibrated millivolts (NO moving average / EMA filtering)
        uint16_t mv = static_cast<uint16_t>(analogReadMilliVolts(ECG_PIN));

        // 2. Check hardware leads-off comparator pins (HIGH = electrode detached)
        if (digitalRead(LO_PLUS_PIN) == HIGH || digitalRead(LO_MINUS_PIN) == HIGH) {
            batchLeadsOff = true;
        }

        // 3. Store into active double-buffer slot
        txBuffers[activeBufIdx].samples[sampleIdx] = mv;
        sampleIdx++;

        // 4. Once 25 samples (100 ms) are collected, seal packet and hand off to Core 0
        if (sampleIdx >= BATCH_SIZE) {
            txBuffers[activeBufIdx].seq   = packetSeq++;
            txBuffers[activeBufIdx].flags = batchLeadsOff ? 0x01 : 0x00;
            txBuffers[activeBufIdx].count = BATCH_SIZE;

            uint8_t completedIdx = activeBufIdx;

            // Swap to the alternate buffer immediately for the next 4 ms tick
            activeBufIdx ^= 1;
            sampleIdx     = 0;
            batchLeadsOff = false;

            // Non-blocking queue send: if Core 0 is stalled on Wi-Fi reconnect,
            // drop oldest/skip without ever delaying Core 1's 250 Hz clock.
            xQueueSend(readyBufferQueue, &completedIdx, 0);
        }

        // 5. Sleep until the exact next 4 ms boundary
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
                Serial.println("[WS] Disconnected from Render backend. Reconnecting...");
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

        case WStype_TEXT:
        case WStype_BIN:
        case WStype_PING:
        case WStype_PONG:
        default:
            break;
    }
}

// ============================================================================
// STATUS LED CONTROLLER (NON-BLOCKING)
//  - Slow blink (500 ms) : Connecting to Wi-Fi
//  - Fast blink (125 ms) : Wi-Fi OK, connecting to Render WSS
//  - Solid ON            : Live streaming ECG packets
// ============================================================================
void updateStatusLed(bool wifiReady, bool serverReady) {
    static uint32_t lastToggleMs = 0;
    static bool     ledState     = false;

    if (wifiReady && serverReady) {
        if (!ledState) {
            ledState = true;
            digitalWrite(STATUS_LED_PIN, HIGH);
        }
        return;
    }

    uint32_t intervalMs = wifiReady ? 125 : 500;
    uint32_t now        = millis();

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
    WiFi.setSleep(false); // Disable modem sleep for low-latency 100 ms packet cadence

    wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);
    if (strlen(WIFI_SSID_2) > 0 && strcmp(WIFI_SSID_2, "YOUR_MOBILE_HOTSPOT_SSID") != 0) {
        wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);
    }

    Serial.println("[WIFI] Connecting to 2.4 GHz access point...");
    while (wifiMulti.run() != WL_CONNECTED) {
        updateStatusLed(false, false);
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    Serial.printf("[WIFI] Connected! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());

    // Build authenticated WebSocket path: /ws/esp32?token=<HEARTIX_DEVICE_TOKEN>
    String wsPath = "/ws/esp32?token=";
    wsPath += DEVICE_TOKEN;

    // Configure WSS (TLS on port 443)
    // Note: beginSSL without root CA fingerprint enables standard TLS encryption
    // compatible with Render's auto-renewing Let's Encrypt certificates.
    webSocket.beginSSL(RENDER_HOST, 443, wsPath.c_str());
    webSocket.onEvent(onWebSocketEvent);
    webSocket.setReconnectInterval(3000);
    webSocket.enableHeartbeat(15000, 3000, 2);

    uint32_t packetsSentWindow  = 0;
    uint32_t packetsDropWindow  = 0;
    uint32_t lastDiagPrintMs    = millis();
    bool     wasWifiConnected   = true;

    for (;;) {
        bool wifiOk = (wifiMulti.run() == WL_CONNECTED);

        if (wifiOk && !wasWifiConnected) {
            Serial.printf("[WIFI] Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
        } else if (!wifiOk && wasWifiConnected) {
            Serial.println("[WIFI] Connection lost. Searching for AP...");
            wsConnected = false;
        }
        wasWifiConnected = wifiOk;

        if (wifiOk) {
            webSocket.loop();
        }

        // Wait up to 10 ms for a completed 25-sample buffer from Core 1
        uint8_t readyIdx = 0;
        if (xQueueReceive(readyBufferQueue, &readyIdx, pdMS_TO_TICKS(10)) == pdTRUE) {
            if (wifiOk && wsConnected) {
                bool ok = webSocket.sendBIN(
                    reinterpret_cast<uint8_t*>(&txBuffers[readyIdx]),
                    sizeof(EcgBinaryPacket)
                );
                if (ok) {
                    packetsSentWindow++;
                } else {
                    packetsDropWindow++;
                }
            } else {
                packetsDropWindow++;
            }
        }

        updateStatusLed(wifiOk, wsConnected);

        // Clean 5-second diagnostic telemetry summary (never spams Serial at 250 Hz)
        uint32_t now = millis();
        if (now - lastDiagPrintMs >= 5000) {
            float pktRate = packetsSentWindow / 5.0f;
            Serial.printf(
                "[TELEMETRY] WiFi=%s | WS=%s | Rate=%.1f pkt/s (target 10.0) | Sent=%lu | Dropped=%lu | Heap=%lu B\n",
                wifiOk ? "OK" : "DOWN",
                wsConnected ? "LIVE" : "WAIT",
                pktRate,
                static_cast<unsigned long>(packetsSentWindow),
                static_cast<unsigned long>(packetsDropWindow),
                static_cast<unsigned long>(ESP.getFreeHeap())
            );
            packetsSentWindow = 0;
            packetsDropWindow = 0;
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

    // Single 2-slot queue passing buffer index (0 or 1) from Core 1 -> Core 0
    readyBufferQueue = xQueueCreate(2, sizeof(uint8_t));
    if (readyBufferQueue == nullptr) {
        Serial.println("[FATAL] Failed to create FreeRTOS queue. Halting.");
        while (true) {
            delay(1000);
        }
    }

    // Pin deterministic 250 Hz ADC sampling to Core 1 (Application Core)
    xTaskCreatePinnedToCore(
        samplingTask,
        "EcgSamplingTask",
        4096,
        nullptr,
        3,    // High priority for strict 4 ms timing
        nullptr,
        1     // Core 1
    );

    // Pin Wi-Fi + TLS WebSocket stack to Core 0 (Protocol Core)
    xTaskCreatePinnedToCore(
        networkTask,
        "EcgNetworkTask",
        8192, // Generous stack for mbedTLS / WSS handshake
        nullptr,
        2,    // Priority 2
        nullptr,
        0     // Core 0
    );
}

void loop() {
    // All work runs inside pinned FreeRTOS tasks; delete default loopTask to free RAM
    vTaskDelete(nullptr);
}