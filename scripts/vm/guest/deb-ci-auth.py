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
if pwd.getpwuid(os.getuid()).pw_name != "runner":
    sys.exit("The app must run as the unprivileged runner")
admin = "fabdesk-test-admin"
pid = int(sys.argv[1])
ready_path = Path(sys.argv[2])
# Register for the same process that invokes pkexec; a recycled PID must not match.
start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
password = secrets.token_urlsafe(40)
subprocess.run(["sudo", "-n", "useradd", "--no-create-home", "--groups", "sudo", "--shell", "/bin/bash", admin], check=True)
agent = None
signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
try:
    subprocess.run(["sudo", "-n", "chpasswd"], input=f"{admin}:{password}\n", text=True, check=True)
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
        choice = terminal.expect([r"Authenticating as: ([^\r\n]+)", r"Choose identity to authenticate as",
                                  r"AUTHENTICATION (?:FAILED|CANCELED)"])
        if choice == 2:
            sys.exit("Polkit rejected the request before asking for an identity")
        if choice == 0:
            identity = terminal.match.group(1)
            print(f"Polkit requested authentication as {identity}", flush=True)
            if not re.search(r"\b" + re.escape(admin) + r"\b", identity):
                sys.exit("Polkit selected a different account than the test administrator")
        else:
            entries = re.findall(r"(?m)^\s*(\d+)\.\s+[^\n]*\b" + re.escape(admin) + r"\b", terminal.before)
            if len(entries) != 1:
                offered = re.findall(r"(?m)^\s*\d+\.\s+([^\r\n]+)", terminal.before)
                sys.exit(f"Polkit did not offer the test administrator; offered {offered}")
            terminal.sendline(entries[0])
            print(f"Selected the {admin} identity from the Polkit prompt", flush=True)
        if terminal.expect([r"(?i)password:", r"AUTHENTICATION (?:FAILED|CANCELED)"]) != 0:
            sys.exit("Polkit rejected the administrator before its password prompt")
        terminal.sendline(password)
        if terminal.expect(["AUTHENTICATION COMPLETE", r"AUTHENTICATION (?:FAILED|CANCELED)"]) != 0:
            sys.exit("Polkit rejected the disposable administrator's PAM authentication")
        print("Polkit accepted the disposable administrator through PAM", flush=True)
    except (pexpect.EOF, pexpect.TIMEOUT):
        sys.exit("The real Polkit agent did not complete authentication for the desktop")
    finally:
        os.close(reader)
        terminal.close()
finally:
    if agent is not None and agent.poll() is None:
        agent.terminate()
        agent.wait(timeout=5)
    subprocess.run(["sudo", "-n", "userdel", admin], check=True)
