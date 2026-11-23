# Mobile dependency interoperability

`query-string@7.1.3.patch` normalizes the CommonJS/ESM default export of
`decode-uri-component`. The mobile toolchain still consumes query-string 7,
while the security-patched decoder 0.5.1 is ESM. Its decoding implementation is
unchanged; the patch only lets the existing consumer call its default export.

Bun applies this patch from `patchedDependencies` during frozen installation.
The query-string regression in `src/lib/dependency-security.test.ts` covers
ordinary links, Unicode and malformed encoding. Remove the patch when upstream
consumers can use a compatible query-string release without this adapter.

`metro@0.83.3.patch` passes image bytes to `image-size@2.1.0` when Metro collects
asset dimensions. The patched image-size release no longer accepts file paths.
Both Metro's executable source and Flow counterpart use the existing filesystem
reader, including for zip-backed assets. Non-image assets are not read for
dimensions. The real-file asset regression covers this export path; an Android
Expo/Hermes export also exercises the complete asset pipeline. Remove this patch
when the Expo-compatible Metro release supports image-size 2 directly.

## picomatch 2.3.2 and 4.0.7 — GHSA-fc5q-39xc-vjpf

Both exact versions have a local `lib/parse.js` patch. A repeated `+(...)` or
`*(...)` extglob containing an unbounded, unescaped wildcard is handled by the
parser's existing risky-pattern fallback, including single-branch bodies such
as `+(*a)`. These patterns match their literal spelling rather than compiling
nested unbounded regex quantifiers. Escaped stars, bracket literals, ordinary
file globs and bounded alternatives retain their behavior. The existing
`maxExtglobRecursion: false` opt-out is unchanged; never use it with untrusted
patterns.

Run `bun run audit` from this app for the verified mobile audit. A raw `bun audit`
still reports the original registry versions: the registry cannot identify a
Bun patch. The verified audit scans all installed picomatch copies, checks each
parser against an exact SHA-256, and executes adversarial and compatibility
regressions under Node/V8 before recognizing only this exact advisory as locally
mitigated. All other advisories, changed advisory metadata, missing patches,
unknown versions, malformed audit output and audit command failures still fail.
The tests also remove the guard from both versions and require the adversarial
child process to fail or time out; CI itself cannot hang on a vulnerable regex.

Remove these patches, parser hashes and the narrow advisory treatment when
upstream publishes a fixed release, then regenerate the standalone mobile
lockfile and rerun the audit and Metro Android export.

Source: https://github.com/advisories/GHSA-fc5q-39xc-vjpf
