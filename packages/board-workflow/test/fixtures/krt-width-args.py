"""KRT route.py width arguments and net_queries.py first-match semantics (stdlib only)."""
import argparse
import fnmatch
import json
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--track-width', type=float, default=None)
parser.add_argument('--power-nets', nargs='*', default=[])
parser.add_argument('--power-nets-widths', nargs='*', type=float, default=[])
# Other options sharing prefixes or delimiting a list in the regression cases.
parser.add_argument('--track-proximity-distance', type=float)
parser.add_argument('--track-proximity-cost', type=float)
parser.add_argument('--verbose', '-v', action='store_true')
args = parser.parse_args(json.load(sys.stdin))
print(json.dumps([
    next((width for pattern, width in zip(args.power_nets, args.power_nets_widths)
          if fnmatch.fnmatchcase(net, pattern)), args.track_width)
    for net in ['OUT', 'UNRELATED']
]))
