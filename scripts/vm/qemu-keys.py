#!/usr/bin/env python3
"""Type text into a QEMU guest through the HMP monitor socket (sendkey), then optionally screendump.
Usage: qemu-keys.py <monitor.sock> "<text with \\n for Enter>" [screendump.png] [delay-seconds]"""
import socket, sys, time
sock, text = sys.argv[1], sys.argv[2].encode().decode("unicode_escape")
shot = sys.argv[3] if len(sys.argv) > 3 else None
delay = float(sys.argv[4]) if len(sys.argv) > 4 else 3
SPECIAL = {" ": "spc", "\n": "ret", "\\": "backslash", ":": "shift-semicolon", ";": "semicolon", "-": "minus", ".": "dot",
           "/": "slash", "_": "shift-minus", "=": "equal", "*": "shift-8", "\t": "tab", "\x1b": "esc", '"': "shift-apostrophe", "'": "apostrophe", ",": "comma"}
s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sock); time.sleep(0.3); s.recv(65536)
def cmd(c):
    s.sendall((c + "\n").encode()); time.sleep(0.12)
    try: s.recv(65536)
    except Exception: pass
for ch in text:
    if ch in SPECIAL: k = SPECIAL[ch]
    elif ch.isalpha(): k = ("shift-" if ch.isupper() else "") + ch.lower()
    else: k = ch
    cmd(f"sendkey {k}")
if shot:
    time.sleep(delay); cmd(f"screendump {shot} -f png"); time.sleep(2)
print("done")
