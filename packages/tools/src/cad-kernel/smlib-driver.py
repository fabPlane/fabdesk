"""Experimental SMLib driver (NVIDIA USD BRep via smlibpy).

Reads one JSON object from stdin:
  {"op":"health"}
  {"op":"build","name":"Lid","export":"/abs/part.step","features":[...],"placement":{...}}
  {"op":"combine","export":"/abs/assembly.step","parts":[{"id":"a","step":"...","xMm":0,"yMm":0,"zMm":0}]}

Writes one JSON object to stdout. Feature failures set ok=false and featureKind.
"""

from __future__ import annotations

import json
import sys
import traceback


def _health() -> dict:
    try:
        import smlibpy

        return {
            "ok": True,
            "available": True,
            "version": getattr(smlibpy, "__version__", "unknown"),
            "detail": f"smlibpy {getattr(smlibpy, '__version__', '?')} (NVIDIA SMLib / USD BRep)",
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "available": False, "detail": f"smlibpy not importable: {e}"}


def _apply(features: list, name: str):
    from smlibpy import Box, Cylinder, Sphere

    part = None
    for feat in features:
        kind = feat["kind"]
        try:
            if kind == "box":
                part = Box(feat["lengthMm"], feat["widthMm"], feat["heightMm"])
            elif kind == "cylinder":
                part = Cylinder(feat["radiusMm"], feat["heightMm"])
            elif kind == "sphere":
                part = Sphere(feat["radiusMm"])
            elif part is None:
                raise ValueError(f"first feature must be a solid, got {kind}")
            elif kind == "fillet":
                opts = {}
                if feat.get("continuity"):
                    opts["continuity"] = feat["continuity"]
                part = part.fillet(part.edges(), feat["radiusMm"], **opts)
            elif kind == "chamfer":
                part = part.chamfer(part.edges(), feat["distanceMm"])
            elif kind == "cut_cylinder":
                tool = Cylinder(feat["radiusMm"], feat["heightMm"]).translate(
                    feat.get("xMm", 0), feat.get("yMm", 0), feat.get("zMm", 0)
                )
                part = part.cut(tool)
            else:
                raise ValueError(f"unsupported feature {kind}")
        except Exception as e:  # noqa: BLE001
            raise FeatureFail(kind, str(e)) from e
    if part is None:
        raise ValueError("no features")
    if hasattr(part, "named"):
        part = part.named(name)
    else:
        part.name = name
    return part


class FeatureFail(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def _build(req: dict) -> dict:
    # Placement is applied once at assembly combine time, not per-part build.
    part = _apply(req["features"], req.get("name") or req.get("id") or "part")
    dest = req["export"]
    part.export(dest)
    info = {
        "ok": True,
        "kernel": "smlib",
        "step": dest,
        "volumeMm3": float(part.volume),
        "faces": int(len(list(part.faces()))),
    }
    return info


def _combine(req: dict) -> dict:
    from smlibpy import import_step

    parts = req["parts"]
    if not parts:
        raise ValueError("no parts to combine")
    bodies = []
    for p in parts:
        body = import_step(p["step"])
        body = body.translate(p.get("xMm", 0), p.get("yMm", 0), p.get("zMm", 0))
        if hasattr(body, "named"):
            body = body.named(p["id"])
        bodies.append(body)
    assembly = bodies[0]
    for extra in bodies[1:]:
        assembly = assembly.fuse(extra)
    dest = req["export"]
    assembly.export(dest)
    return {
        "ok": True,
        "step": dest,
        "volumeMm3": float(assembly.volume),
        "faces": int(len(list(assembly.faces()))),
    }


def main() -> int:
    req = json.load(sys.stdin)
    op = req.get("op")
    try:
        if op == "health":
            json.dump(_health(), sys.stdout)
        elif op == "build":
            json.dump(_build(req), sys.stdout)
        elif op == "combine":
            json.dump(_combine(req), sys.stdout)
        else:
            json.dump({"ok": False, "error": f"unknown op {op}"}, sys.stdout)
            return 1
        return 0
    except FeatureFail as e:
        json.dump({"ok": False, "error": str(e), "featureKind": e.kind}, sys.stdout)
        return 2
    except Exception as e:  # noqa: BLE001
        json.dump(
            {"ok": False, "error": str(e), "trace": traceback.format_exc(limit=4)},
            sys.stdout,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
