/** Build-workflow only. Same temporary-keychain import + Apple secrets as the existing desktop release. */
const { signAsync } = require("@electron/osx-sign");
const { notarize } = require("@electron/notarize");
const {
  createKeychain,
  findIdentity,
  removeKeychain,
} = require("app-builder-lib/out/codeSign/macCodeSign");
const { TmpDir } = require("temp-file");
const path = require("node:path");
(async () => {
  const tmpDir = new TmpDir();
  let keychain;
  try {
    keychain = await createKeychain({
      tmpDir,
      cscLink: process.env.CSC_LINK,
      cscKeyPassword: process.env.CSC_KEY_PASSWORD,
      currentDir: process.cwd(),
    });
    const identity = await findIdentity("Developer ID Application", null, keychain.keychainFile);
    if (!identity) throw new Error("Existing release Developer ID identity is unavailable");
    await signAsync({
      app: path.resolve(process.argv[2]),
      platform: "darwin",
      identity: identity.hash,
      keychain: keychain.keychainFile,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: path.resolve("apps/desktop/build/entitlements.mac.plist"),
      }),
    });
    await notarize({
      appPath: path.resolve(process.argv[2]),
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  } finally {
    if (keychain) await removeKeychain(keychain.keychainFile);
    await tmpDir.cleanup();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
