// fabPlane laser cell: foot-switch relay for the ComMarker Omni X.
//
// Board: any Arduino (Uno, Nano, Leonardo) or ESP32 (GPIO 26) with a 1-channel relay module or a PC817 optocoupler.
// Wiring, relay module:
//   VCC -> 5V (VIN on an ESP32 dev board), GND -> GND, IN -> RELAY_PIN
//   relay COM + NO -> the two wires of the Omni X foot-switch cable (in parallel with the pedal).
// Wiring, PC817 optocoupler (set RELAY_ACTIVE_LOW = false):
//   RELAY_PIN -> 330 ohm -> pin 1 (anode), pin 2 (cathode) -> GND
//   pin 4 (collector) -> the foot-switch wire that measures positive, pin 3 (emitter) -> the other wire.
// Use the dry contact only. Never connect the board's 5 V / 3.3 V or GND to the laser.
// ESP32: Arduino IDE -> Boards Manager -> "esp32 by Espressif", pick your board, upload.
// Protocol (USB serial, 9600 baud), as used by fabPlane (relay type "Arduino / ESP32"):
//   '1' = pedal down (relay closed)   '0' = pedal up   '?' = ping, answers 'K'
// Safety: the relay always starts open, and a press longer than MAX_HOLD_MS is released by itself.

#if defined(ESP32)
const int RELAY_PIN = 26;
#else
const int RELAY_PIN = 7;
#endif
// Most cheap relay modules switch on when IN is LOW. Set to false if yours clicks on HIGH.
const bool RELAY_ACTIVE_LOW = true;
const unsigned long MAX_HOLD_MS = 10000;

bool pressed = false;
unsigned long pressedAt = 0;

void setRelay(bool on) {
  if (RELAY_ACTIVE_LOW) {
    // Active-low modules: pull IN low for "on"; for "off" let the pin float so the module's own
    // pull-up switches it fully off. Driving 3.3 V (ESP32) into a 5 V module can leave it half on.
    if (on) {
      digitalWrite(RELAY_PIN, LOW);
      pinMode(RELAY_PIN, OUTPUT);
    } else {
      pinMode(RELAY_PIN, INPUT);
    }
  } else {
    // Active-high modules and a PC817 optocoupler (GPIO -> 330 ohm -> pin 1, pin 2 -> GND).
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  }
  pressed = on;
  pressedAt = millis();
}

void setup() {
  setRelay(false);
  Serial.begin(9600);
}

void loop() {
  while (Serial.available() > 0) {
    int c = Serial.read();
    if (c == '1') setRelay(true);
    else if (c == '0') setRelay(false);
    else if (c == '?') Serial.write('K');
  }
  if (pressed && millis() - pressedAt > MAX_HOLD_MS) setRelay(false);
}
