"""Authenticate the Debian package-manager acceptance test on a fresh, disposable GitHub VM."""
import getpass
import os
import secrets
import subprocess
import sys

import pexpect

if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("GITHUB_ACTIONS") != "true":
    sys.exit("The CI authentication helper requires a fresh GitHub-hosted runner")

user = getpass.getuser()
if user != "runner":
    sys.exit("Refusing to modify a non-runner account")
pid = int(sys.argv[1])
# Exercise ordinary Polkit authentication. Do not install a permissive policy, mock
# apt, or change the desktop binary. Only the disposable runner gets this password.
password = secrets.token_urlsafe(40)
subprocess.run(["sudo", "-n", "chpasswd"], input=f"{user}:{password}\n", text=True, check=True)
agent = pexpect.spawn("/usr/bin/pkttyagent", ["--process", str(pid)], encoding="utf-8", timeout=1000)
try:
    choice = agent.expect([r"(?i)password:", r"Choose identity to authenticate as"])
    if choice == 1:
        import re
        entries = re.findall(r"(?m)^\s*(\d+)\.\s+[^\n]*\b" + re.escape(user) + r"\b", agent.before)
        if len(entries) != 1:
            raise RuntimeError("Polkit did not offer the runner's identity")
        agent.sendline(entries[0])
        agent.expect(r"(?i)password:")
    agent.sendline(password)
    agent.expect("AUTHENTICATION COMPLETE")
finally:
    agent.close(force=True)
    subprocess.run(["sudo", "-n", "passwd", "-l", user], stdout=subprocess.DEVNULL, check=True)
