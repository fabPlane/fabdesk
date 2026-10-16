#!/bin/bash
set -euo pipefail
exec /usr/bin/python3 "$HOME/runner-hooks/job-hook.py" completed
