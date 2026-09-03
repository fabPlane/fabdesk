#!/usr/bin/env bash
# Interactive ssh with password auth and no sshpass: _ssh.sh <user> <host> <password> [port]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
a="$(_askpass "$3")"; trap 'rm -f "$a"' EXIT
SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh "${SSH_OPTS[@]}" -p "${4:-22}" "$1@$2"
