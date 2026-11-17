"""KRT v0.23.8 width CLI oracle, optionally using actual source (stdlib only).

Set FABDESK_KRT_DIR to a KRT checkout. Extract declarations without importing the
router's native dependencies. Otherwise use the faithful declarations/customizer
below and its captured long-option inventory, including abbreviation collisions.
"""
import argparse
import ast
import contextlib
import fnmatch
import io
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace

parser = argparse.ArgumentParser()
source = Path(os.environ.get('FABDESK_KRT_DIR', '')) / 'src/plugins/py_router'
selected = {'--track-width', '--power-nets', '--power-nets-widths', '--layers',
            '--verbose', 'input_file', 'output_file', 'net_patterns'}
if (source / 'route.py').is_file():
    tree = ast.parse((source / 'route.py').read_text())
    flags = []
    for n in ast.walk(tree):
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == 'add_argument' and n.args
                and isinstance(n.args[0], ast.Constant)):
            continue
        flags.extend(a.value for a in n.args if isinstance(a, ast.Constant)
                     and isinstance(a.value, str) and a.value.startswith('-'))
        if n.args[0].value in selected:
            eval(compile(ast.Expression(n), 'actual_krt_parser', 'eval'),
                 dict(parser=parser, defaults=SimpleNamespace(TRACK_WIDTH=.2)))
    sys.path.insert(0, str(source))
    from cli_nets import pin_dash_digit_values
    pin_dash_digit_values(parser)
    oracle = 'actual KRT'
else:
    parser.add_argument('input_file')
    parser.add_argument('output_file', nargs='?')
    parser.add_argument('net_patterns', nargs='*')
    parser.add_argument('--track-width', type=float, default=None)
    parser.add_argument('--power-nets', nargs='*', default=[])
    parser.add_argument('--power-nets-widths', nargs='*', type=float, default=[])
    parser.add_argument('--layers', '-l', nargs='+', default=None)
    parser.add_argument('--verbose', '-v', action='store_true')
    # cli_nets.pin_dash_digit_values deliberately overrides Python's matcher.
    parser._negative_number_matcher = re.compile(r'^-\d')
    flags = json.loads(Path(__file__).with_name('krt-option-names.json').read_text())
    oracle = 'faithful fixture'
for flag in flags:
    if flag not in parser._option_string_actions:
        parser.add_argument(flag, action='store_true')


def parse(argv, nets):
    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
        try:
            args = parser.parse_args(['input.kicad_pcb', 'output.kicad_pcb', *argv])
            if args.power_nets and args.power_nets_widths and len(args.power_nets) != len(args.power_nets_widths):
                parser.error('power net arrays must have equal lengths')
        except SystemExit:
            return None
    pairs = zip(args.power_nets, args.power_nets_widths)
    overrides = list(pairs) if args.power_nets and args.power_nets_widths else []
    return dict(parsed=vars(args), widths=[
        next((w for p, w in overrides if fnmatch.fnmatchcase(net, p)), args.track_width)
        for net in nets])

request = json.load(sys.stdin)
if isinstance(request, list):
    result = parse(request, ['OUT', 'UNRELATED'])
    if result is None:
        sys.exit(2)
    print(json.dumps(result['widths']))
else:
    print(json.dumps(dict(oracle=oracle, rows=[parse(argv, request['nets']) for argv in request['cases']])))
