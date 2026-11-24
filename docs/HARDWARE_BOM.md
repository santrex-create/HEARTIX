# HEARTIX Hardware Bill of Materials (BOM)

| Component | Specification | Qty | Purpose |
| :--- | :--- | :---: | :--- |
| **ESP32 Dev Module** | ESP32-WROOM-32 (30/38-pin, CP2102 or CH340 USB-UART) | 1 | Dual-core 240 MHz FreeRTOS acquisition & TLS WSS streaming |
| **AD8232 ECG Sensor** | Single-Lead Heart Rate Monitor Front-End (3.3 V logic) | 1 | Instrumentation amp, RLD, analog bandpass, LO+/LO- comparators |
| **3-Lead ECG Cable** | 3.5 mm stereo jack to 3 snap leads (RA, LA, RL) | 1 | Connects surface electrodes to AD8232 sensor jack |
| **Ag/AgCl Gel Electrodes** | Disposable pre-gelled conductive ECG pads | 1 pack | Low-impedance skin-electrode biopotential coupling |
| **Isolated USB Power Bank** | Standard 5 V portable Li-ion power bank (unplugged from wall) | 1 | Galvanic safety isolation during human ECG recording |
| **Jumper Wires** | Female-to-Female DuPont wires (10–20 cm) | 5 | Connects 3V3, GND, GPIO 34, GPIO 32, and GPIO 33 |