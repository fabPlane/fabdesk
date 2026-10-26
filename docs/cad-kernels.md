# Kernel-agnostic CAD

Flux's "Kernel-agnostic CAD" (https://www.flux.ai/p/teams, added 2026-10-14) lets the AI pick
OpenCascade, SMLib, or (on request) Parasolid per part, switch when a feature cannot be built, and
assemble every part in one model.

fabPlane's first version does the same with **OpenCascade** (the existing FreeCAD path) and
**SMLib** (NVIDIA's open-sourced NURBS kernel, experimental). Parasolid is out of scope.

## Kernels

| id            | default | what                                                                                          |
| ------------- | ------- | --------------------------------------------------------------------------------------------- |
| `opencascade` | yes     | FreeCAD / OCCT via `CadService`. Exact STEP for machined parts and CAM. G1 fillets only.      |
| `smlib`       | no      | NVIDIA USD BRep through `smlibpy` or `@classcad/smlibwasm`. G2/G3 blends, exact NURBS STEP.   |
| Parasolid     | —       | Not implemented. Commercial license; same stance as Flux's "on request".                      |

Enable SMLib:

```sh
export FABDESK_EXPERIMENTAL_CAD_KERNELS=1
pip install smlibpy          # preferred (Python 3.10–3.14 wheels, kernel compiled in)
# or: bun add @classcad/smlibwasm
```

`FABDESK_SMLIB_PYTHON` overrides the `python3` used to run
`packages/tools/src/cad-kernel/smlib-driver.py`.

## What is persisted

`cad/kernels.json` — each part's id, chosen kernel, the reason, any fallbacks, and the STEP path.
`cad/parts/<id>.step` — the part as exact B-rep when the kernel can export STEP.
`cad/assembly.step` — every part in one model (SMLib `fuse` when available, otherwise remapped
ISO-10303-21).

The CAD tab shows a kernel tree next to the FreeCAD viewer.

## Agent tools

`load_toolset {"toolset":"cad"}` then:

- `cad_kernels` — list + capabilities + availability + per-part records
- `cad_build_part` — `{ id, features, kernel?, hints? }` (`kernel` is `auto` / `opencascade` / `smlib`)
- `cad_combine_parts` — write `cad/assembly.step`

`auto` sends G2 fillets and `hints.consumerSurface` to SMLib when that kernel is up, and prismatic
/`hints.machined` parts to OpenCascade. A feature error (for example FreeCAD refusing a G2 fillet)
retries the other kernel and records the switch.

## What SMLib integration still needs for shipping

NVIDIA released SMLib as [USD BRep](https://github.com/NVIDIA-Omniverse/usd-brep) (Apache 2.0,
2026-10-08). AWV's [smlibpy](https://github.com/awv-informatik/smlibpy) / `@classcad/smlibwasm`
wraps it (MIT + Apache 2.0). To ship it in the desktop:

- decide whether to bundle the ~8 MB wasm/wheel per platform or download-on-consent like FreeCAD
- add notices for NVIDIA USD BRep and smlibpy (NOTICE / LICENSE.usd-brep)
- sign and attest the runtime the same way as the native CAD pack
- keep the experimental flag until that packaging exists

Building USD BRep from source needs Packman, OpenUSD, Python 3.12 and premake; the wheels avoid
that. Do not vendor `NVIDIA-Omniverse/usd-brep` into fabdesk.

## Local test

```sh
bun test packages/tools/test/cad-kernel.test.ts packages/tools/test/cad.test.ts
bun test packages/ui/src/board/CadTab.test.ts
# live SMLib (this environment has smlibpy):
FABDESK_EXPERIMENTAL_CAD_KERNELS=1 bun test packages/tools/test/cad-kernel.test.ts
```

No staging API is required. FreeCAD is optional: the OpenCascade adapter is tested against a fake
`CadService`; the CAD tab still needs the bridge for the live viewer (`bun run dev:cad`).
