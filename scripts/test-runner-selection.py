"""Exercise the workflow's actual shell with controlled clock and runner signals."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/select-linux-runner.yml"
NOW = 1790909000
NAS = ["self-hosted", "Linux", "X64", "tf-nas-ephemeral", "fabdesk"]
FALLBACK = "blacksmith-4vcpu-ubuntu-2404"


def main():
    workflow = WORKFLOW.read_text()
    shell = "\n".join(
        line[10:] for line in workflow.split("        run: |\n", 1)[1].splitlines()
    ) + "\n"
    cases = [
        # name, heartbeat, lease, fork, force, linux_runner, expected
        ("idle", str(NOW - 10), "", False, "", "", NAS),
        ("busy or stale", str(NOW - 120), "", False, "", "", NAS),
        ("absent heartbeat", "", "", False, "", "", NAS),
        ("malformed heartbeat", "invalid", "", False, "", "", NAS),
        ("future heartbeat", str(NOW + 100), "", False, "", "", NAS),
        ("confirmed outage", str(NOW - 120), str(NOW + 300), False, "", "", FALLBACK),
        ("fresh idle overrides outage", str(NOW - 10), str(NOW + 300), False, "", "", NAS),
        ("expired outage", "", str(NOW - 1), False, "", "", NAS),
        ("overlong outage lease", "", str(NOW + 901), False, "", "", NAS),
        ("invalid outage lease", "", "08", False, "", "", NAS),
        ("fork stays isolated during outage", "", str(NOW + 300), True, "", "", "ubuntu-latest"),
        ("durable force true", str(NOW - 10), "", False, "true", "", FALLBACK),
        ("durable force TRUE", str(NOW - 10), "", False, "TRUE", "", FALLBACK),
        ("durable force 1", "", "", False, "1", "", FALLBACK),
        ("durable force yes", "", "", False, "yes", "", FALLBACK),
        ("durable force on", "", "", False, " on ", "", FALLBACK),
        ("durable force false keeps NAS", str(NOW - 10), "", False, "false", "", NAS),
        ("durable force empty keeps NAS", "", "", False, "", "", NAS),
        ("durable force wins over idle", str(NOW - 10), str(NOW + 300), False, "true", "", FALLBACK),
        ("LINUX_RUNNER blacksmith", str(NOW - 10), "", False, "", "blacksmith", FALLBACK),
        ("LINUX_RUNNER BLACKSMITH", str(NOW - 10), "", False, "", "BLACKSMITH", FALLBACK),
        ("LINUX_RUNNER other keeps NAS", str(NOW - 10), "", False, "", "nas", NAS),
        ("github-hosted value keeps NAS", "", "", False, "", "github-hosted", NAS),
        ("github-hosted value normalized keeps NAS", "", "", False, "", " GITHUB-HOSTED ", NAS),
        ("github-hosted value keeps idle NAS", str(NOW - 10), "", False, "", "github-hosted", NAS),
        ("durable Blacksmith override beats github-hosted value", "", "", False, "true", "github-hosted", FALLBACK),
        ("fork stays isolated under github-hosted value", "", "", True, "", "github-hosted", "ubuntu-latest"),
        ("fork stays isolated under force", "", str(NOW + 300), True, "true", "blacksmith", "ubuntu-latest"),
    ]
    for name, heartbeat, lease, fork, force, linux_runner, expected in cases:
        with tempfile.NamedTemporaryFile() as output:
            env = dict(
                os.environ,
                FORK_PR=str(fork).lower(),
                BLACKSMITH_RUNNER=FALLBACK,
                FORCE_BLACKSMITH_LINUX=force,
                LINUX_RUNNER=linux_runner,
                NAS_RUNNER_HEARTBEAT=heartbeat,
                NAS_RUNNER_OUTAGE_UNTIL=lease,
                GITHUB_OUTPUT=output.name,
            )
            subprocess.run(
                ["bash", "-c", f"date() {{ echo {NOW}; }}\n" + shell],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            lines = Path(output.name).read_text().splitlines()
            assert len(lines) == 1, (name, lines)
            key, value = lines[0].split("=", 1)
            assert key == "runner", (name, key)
            assert json.loads(value) == expected, (name, value, expected)
        print(f"PASS: {name}")


if __name__ == "__main__":
    main()
