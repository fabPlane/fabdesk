# Shared macOS CI

The Mac Mini is one shared company build pool. All three existing repository
listeners stay connected in one VM; the host no longer takes turns between
repositories. The VM has six virtual CPUs and 10 GiB RAM, leaving capacity for
the 16 GiB host. It is shared between jobs, with separate runner workspaces.
The job-completed hook removes the completed checkout.

## Which jobs use macOS

- **fabdesk:** Apple Silicon desktop packaging, TraceMaker/Metal builds, and
  opt-in iOS simulator tests prefer the shared Mac. Busy or unavailable
  capacity falls back to `blacksmith-6vcpu-macos-15`.
- **fab_pcb:** only native macOS backend release jobs need macOS. Apple Silicon
  packaging prefers the shared Mac; Intel runtime checks use Blacksmith with
  Rosetta. Ordinary CI remains on Linux.
- **js_autorouter:** the audited default branch has no macOS Actions workflow.
  Its listener stays available, but no Linux/TypeScript task is moved to the Mac.
- Fresh-machine installer checks remain on fresh Blacksmith VMs. The optional
  large CAD runtime build keeps its dedicated hosted configuration.

## Capacity and concurrency

A monitor using its existing GitHub authentication checks all three runner
registrations every ten seconds. It publishes `MAC_RUNNER_HEARTBEAT` to all
three repositories only when every listener is online and idle. Missing,
zero, stale, invalid, or future heartbeat values select Blacksmith. Published
memory and iOS capability values also gate jobs with explicit requirements.
A monitor failure makes the heartbeat stale and therefore fails over safely.

`select-macos-runner.yml` runs on Blacksmith Linux without checking out project
code. It also makes an atomic per-repository reservation using a
fast-forward-only control ref, `ci-macos-lease`. Only one concurrent reservation
can advance that ref. An always-run cleanup workflow releases the reservation;
a later selection can reclaim a completed or cancelled workflow's reservation.
These control commits do not modify the application branch or trigger builds.
Fork PRs always use hosted runners and never reserve private Mac capacity.

The VM's shared job-start hook uses an OS file lock and a live worker PID to
serialize builds across all repository listeners. This handles simultaneous
selections across repositories and stale heartbeat races without running
multiple memory-heavy builds together. A crashed worker's ownership is
reclaimed. Selection happens once per job; a job already assigned during a
race is serialized by this hook rather than moved mid-execution.

## Service operations

The existing login LaunchAgent now runs `scripts/ci/macos/controller.py` through
its host wrapper. Its private `shared-config.json` supplies repository runner
folder keys, VM name, base image, CPU count, and RAM. The supervisor provisions
one shared VM, starts every listener, restarts an exited listener, and only
rebuilds the VM if it becomes unavailable. Its logs contain service status,
not runner credentials. The previous rotating controller is backed up on the
host. The existing caffeinate service remains enabled.

`publish-capacity.py` and `mac-runner-capacity.{service,timer}` run on the
independent monitoring machine using authentication already present there.
No GitHub or signing credential was transferred to another machine. Capability
variables are initialized by the operator after checking the shared image.

Run `node scripts/ci/macos/tests/selection.test.cjs` for selector, contention,
stale reservation, fork, capability, and ownership checks. The shared-runner
smoke workflow compiles and executes native C with the selected Xcode image;
it does not publish a release.

The capacity timer sets `AccuracySec=1s`; systemd's default one-minute timer
coalescing is longer than the heartbeat lease and must not be used here.
