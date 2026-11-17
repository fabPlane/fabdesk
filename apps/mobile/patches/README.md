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
