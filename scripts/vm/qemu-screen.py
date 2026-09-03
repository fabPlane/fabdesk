#!/usr/bin/env python3
"""Classify the QEMU guest display via an HMP screendump (PPM): prints "shell" (EDK2 UEFI shell:
yellow prompt text on black), "black" (nothing painted yet / firmware) or "other" (an OS is drawing).
Usage: qemu-screen.py <monitor.sock> <scratch.ppm>"""
import socket, sys, time
sock, ppm = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX); s.settimeout(5)
try:
    s.connect(sock); time.sleep(0.2); s.recv(65536)
    s.sendall(f"screendump {ppm}\n".encode()); time.sleep(1.5)
    try: s.recv(65536)
    except Exception: pass
except Exception as e:
    print("black"); sys.exit(0)
try:
    data = open(ppm, "rb").read()
except FileNotFoundError:
    print("black"); sys.exit(0)
# P6 header: magic, width height, maxval, then binary RGB
parts = data.split(b"\n", 3)
if parts[0] != b"P6" or len(parts) < 4: print("black"); sys.exit(0)
w, h = map(int, parts[1].split()); px = parts[3]
yellow = black = total = 0
step = 4  # sample every 4th pixel
for i in range(0, min(len(px), w * h * 3) - 2, 3 * step):
    r, g, b = px[i], px[i + 1], px[i + 2]; total += 1
    if r > 180 and g > 180 and b < 120: yellow += 1
    elif r < 20 and g < 20 and b < 20: black += 1
if yellow > 80 and black > total * 0.8: print("shell")
elif black > total * 0.99: print("black")
else: print("other")
