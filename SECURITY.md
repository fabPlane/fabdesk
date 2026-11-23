# Security policy

Report suspected vulnerabilities privately to **hello@fabplane.com** (subject: Security report). Include
steps to reproduce, affected version/commit, expected impact and a minimal example
with synthetic data. Do not include live credentials or private customer designs.
If that address cannot be reached, use GitHub private vulnerability reporting when
it is enabled; do not put exploit details or credentials in a public issue.

Maintainers triage reports and coordinate a fix and disclosure. There is no
promised response deadline or bug-bounty payment. Use the latest maintained
release; older snapshots may not receive independent security backports.

Source checks and dependency audits supplement review. They do not establish
that generated hardware is safe or ready to manufacture. Saved DRC/ERC results
must remain tied to their source revision and stated coverage.

Never commit production tokens, signing keys, session stores or source maps.
Demo credentials are development fixtures and must not authenticate production.
Firebase mobile client configuration identifies an app/project; permissions must
be enforced by service rules, key restrictions and application authentication.
