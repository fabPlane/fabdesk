"""Regenerate independent stencil test references using native KiCad Gerbers.

Optional developer dependencies: Python, gerbonara and shapely; kicad-cli.
Run from any directory: python scripts/stencil-native-reference.py --kicad-cli PATH
Review resulting geometry changes before accepting a new snapshot. The runtime
exporter and the normal Bun test suite do not require these dependencies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from gerbonara import GerberFile
from gerbonara.graphic_primitives import ArcPoly, Circle, Line, Rectangle
from shapely.affinity import rotate, scale, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union


def paste_polygon(obj):
    shapes = []
    for primitive in obj.to_primitives():
        if not primitive.polarity_dark:
            raise ValueError("Reference fixture unexpectedly contains clear polarity")
        if isinstance(primitive, Circle):
            shape = Point(primitive.x, primitive.y).buffer(primitive.r, quad_segs=96)
        elif isinstance(primitive, Rectangle):
            shape = translate(rotate(box(-primitive.w / 2, -primitive.h / 2,
                                         primitive.w / 2, primitive.h / 2),
                                     primitive.rotation, origin=(0, 0), use_radians=True),
                              primitive.x, primitive.y)
        elif isinstance(primitive, ArcPoly):
            if any(primitive.arc_centers):
                raise ValueError("Reference fixture unexpectedly contains a curved region")
            shape = Polygon(primitive.outline)
        elif isinstance(primitive, Line):
            shape = LineString([(primitive.x1, primitive.y1),
                                (primitive.x2, primitive.y2)]).buffer(primitive.width / 2, quad_segs=96)
        else:
            raise ValueError(f"Unhandled Gerber primitive: {type(primitive)}")
        shapes.append(shape)
    return scale(unary_union(shapes), xfact=1, yfact=-1, origin=(0, 0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kicad-cli", default="kicad-cli")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    fixtures = root / "packages/kicad/test/fixtures"
    version = subprocess.check_output([args.kicad_cli, "version"], text=True).strip()
    cases = []
    # Copy inputs into a dedicated temporary directory so native KiCad cannot
    # leave .kicad_prl/session files in the repository or modify source fixtures.
    with tempfile.TemporaryDirectory(prefix="stencil-native-reference-") as tmp:
        for name, side in [("stencil-geometry-regressions", "F"),
                           ("stencil-geometry-regressions", "B"),
                           ("stencil-nightly-metadata", "F")]:
            source = fixtures / f"{name}.kicad_pcb"
            copied = Path(tmp) / source.name
            shutil.copyfile(source, copied)
            output = Path(tmp) / f"{name}-{side}"
            output.mkdir()
            subprocess.run([args.kicad_cli, "pcb", "export", "gerbers", "--layers",
                            f"{side}.Paste", "--output", str(output), str(copied)], check=True)
            gerber = next(output.glob("*.gtp" if side == "F" else "*.gbp"))
            polygons = [paste_polygon(obj) for obj in GerberFile.open(gerber).objects]
            cases.append({"fixture": name, "side": side,
                          "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                          "polygons": [[[round(x, 7), round(y, 7)] for x, y in p.exterior.coords]
                                       for p in polygons]})
    target = fixtures / "stencil-native-reference.json"
    target.write_text(json.dumps({"generator": f"KiCad {version}; native pcb export gerbers; "
                                 "Gerbonara to polygons; Y flipped into board coordinates",
                                 "cases": cases}, separators=(",", ":")) + "\n")
    print(target)


if __name__ == "__main__":
    main()
