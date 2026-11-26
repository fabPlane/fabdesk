"""Provide real interactive Polkit authentication inside a disposable CI login session."""
import fcntl
import os
import pty
import pwd
import re
import secrets
import select
import signal
import subprocess
import sys
import termios
from pathlib import Path

import pexpect
from pexpect.fdpexpect import fdspawn

if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("GITHUB_ACTIONS") != "true":
    sys.exit("The CI authentication helper requires a fresh GitHub-hosted runner")
user = pwd.getpwuid(os.getuid()).pw_name
if user != "runner":
    sys.exit("Refusing to modify a non-runner account")
pid = int(sys.argv[1])
ready_path = Path(sys.argv[2])
# Register for the same process that invokes pkexec; a recycled PID must not match.
start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
password = secrets.token_urlsafe(40)
subprocess.run(["sudo", "-n", "chpasswd"], input=f"{user}:{password}\n", text=True, check=True)
agent = None
signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
try:
    master, slave = pty.openpty()
    reader, writer = os.pipe()
    try:
        agent = subprocess.Popen(["/usr/bin/pkttyagent", "--process", f"{pid},{start}", "--notify-fd", str(writer)],
                                 stdin=slave, stdout=slave, stderr=slave, pass_fds=(writer,), start_new_session=True,
                                 preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
    finally:
        os.close(slave)
        os.close(writer)
    terminal = fdspawn(master, encoding="utf-8", timeout=120)
    try:
        readable, _, _ = select.select([reader], [], [], 20)
        if not readable or os.read(reader, 1) or agent.poll() is not None:
            sys.exit("Polkit failed to register the test authentication agent for the desktop")
        ready_path.touch()
        choice = terminal.expect([r"(?i)password:", r"Choose identity to authenticate as"])
        if choice == 1:
            entries = re.findall(r"(?m)^\s*(\d+)\.\s+[^\n]*\b" + re.escape(user) + r"\b", terminal.before)
            if len(entries) != 1:
                sys.exit("Polkit did not offer the runner's identity")
            terminal.sendline(entries[0])
            terminal.expect(r"(?i)password:")
        terminal.sendline(password)
        terminal.expect("AUTHENTICATION COMPLETE")
    except (pexpect.EOF, pexpect.TIMEOUT):
        sys.exit("The real Polkit agent did not complete authentication for the desktop")
    finally:
        os.close(reader)
        terminal.close()
finally:
    if agent is not None and agent.poll() is None:
        agent.terminate()
        agent.wait(timeout=5)
    subprocess.run(["sudo", "-n", "passwd", "-l", user], stdout=subprocess.DEVNULL, check=True)
