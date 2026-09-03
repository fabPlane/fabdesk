#!/usr/bin/env bash
# Install (or update) the fresh-VM installer tests on a job host and declare the daily OpenClaw
# automation there. Copies scripts/vm to <host>:/home/openclaw/fabdesk-vm (no repo checkout or
# GitHub login needed on the host: --latest pulls from fabplane.com), then registers the job through
# the OpenClaw CLI with an idempotent declaration key. Re-run after changing the scripts.
#
#   scripts/vm/install-agent.sh agent1 [--cron "0 5 * * *"] [--tz Asia/Bangkok] [--no-job]
#
# Base images (Linux cloud image, Windows unattended install) are prepared on the host separately:
#   ssh agent1 'sudo -u openclaw /home/openclaw/fabdesk-vm/linux.sh prepare'
#   ssh agent1 'sudo -u openclaw nohup /home/openclaw/fabdesk-vm/windows.sh prepare --guest x86_64 &'
set -euo pipefail
HOST="${1:?host}"; shift
CRON="0 5 * * *"; TZ_="Asia/Bangkok"; JOB=1
while [ $# -gt 0 ]; do case "$1" in --cron) CRON="$2"; shift 2 ;; --tz) TZ_="$2"; shift 2 ;; --no-job) JOB=0; shift ;; *) echo "unknown: $1" >&2; exit 1 ;; esac; done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/home/openclaw/fabdesk-vm
echo "[install] syncing scripts/vm -> $HOST:$DEST"
tar -C "$HERE" -czf - --exclude='*.pyc' . | ssh "$HOST" "sudo -n mkdir -p $DEST && sudo -n tar -C $DEST -xzf - && sudo -n chown -R openclaw:openclaw $DEST && sudo -n chmod +x $DEST/*.sh $DEST/*.py $DEST/guest/*.sh"
echo "[install] host prerequisites"
ssh "$HOST" 'for t in qemu-system-x86_64 qemu-img genisoimage python3 curl; do command -v $t >/dev/null || missing="$missing $t"; done; if [ -n "${missing:-}" ]; then echo "  installing:$missing"; sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -q qemu-system-x86 qemu-utils genisoimage python3 curl >/dev/null; fi; echo "  mem: $(awk "/MemTotal/ {printf \"%d MiB\", \$2/1024}" /proc/meminfo), cpus: $(nproc), kvm: $([ -e /dev/kvm ] && echo yes || echo no-emulated)'
[ "$JOB" = 1 ] || exit 0
echo "[install] declaring OpenClaw automation (cron '$CRON' $TZ_)"
ssh "$HOST" "sudo -n -u openclaw bash -c 'cd ~ && ~/.npm-global/bin/openclaw cron add \
  --declaration-key fabdesk-installer-vm-daily-v1 \
  --name \"Fabdesk installer VM test\" \
  --description \"Fresh-VM install + launch test of the Fabdesk build fabplane.com serves (Linux AppImage/deb, Windows NSIS). Silent when all pass.\" \
  --cron \"$CRON\" --tz \"$TZ_\" --exact --session isolated \
  --command-argv \"[\\\"$DEST/daily.sh\\\"]\" --command-cwd /home/openclaw \
  --command-env FABDESK_VM_DIR=/home/openclaw/.fabdesk-vm \
  --timeout-seconds 7200 --no-output-timeout-seconds 3600 --output-max-bytes 65536 \
  --announce --channel telegram --to -1003983771570 --best-effort-deliver' 2>&1 | grep -v linuxbrew"
