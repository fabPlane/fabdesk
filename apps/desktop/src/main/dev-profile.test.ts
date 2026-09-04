import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_DEV_CORE_PORT,
  DEV_APP_USER_MODEL_ID,
  DEV_CORE_HOME_DIR,
  DEV_DESKTOP_NAME,
  DEV_LINUX_WM_CLASS,
  DEV_PRODUCT_NAME,
  PROD_APP_USER_MODEL_ID,
  PROD_CORE_HOME_DIR,
  PROD_PRODUCT_NAME,
  applyDesktopIdentity,
  desktopIdentity,
  parseDevProfileFlag,
  platformAppDataDir,
  resolveCoreHome,
  resolveDevCorePort,
  resolveUserDataPath,
  spawnCorePort,
  useDevProfile,
  type IdentityApp,
} from "./dev-profile";

function fakeApp(appData = "/home/me/.config"): IdentityApp & {
  calls: {
    setName?: string;
    userData?: string;
    aumid?: string;
    desktopName?: string;
    switches: Array<[string, string | undefined]>;
  };
} {
  const calls: {
    setName?: string;
    userData?: string;
    aumid?: string;
    desktopName?: string;
    switches: Array<[string, string | undefined]>;
  } = { switches: [] };
  const paths = { appData, userData: join(appData, "Fabdesk") };
  return {
    calls,
    setName(name) {
      calls.setName = name;
    },
    getPath(name) {
      return paths[name];
    },
    setPath(name, path) {
      if (name === "userData") {
        calls.userData = path;
        paths.userData = path;
      }
    },
    setAppUserModelId(id) {
      calls.aumid = id;
    },
    setDesktopName(name) {
      calls.desktopName = name;
    },
    commandLine: {
      appendSwitch(key, value) {
        calls.switches.push([key, value]);
      },
    },
  };
}

describe("useDevProfile", () => {
  test("unpackaged is the default dev copy; packaged is production", () => {
    expect(useDevProfile({ packaged: false, env: {} })).toBe(true);
    expect(useDevProfile({ packaged: true, env: {} })).toBe(false);
  });

  test("FABDESK_DEV_PROFILE overrides packaged and unpackaged", () => {
    expect(useDevProfile({ packaged: true, env: { FABDESK_DEV_PROFILE: "1" } })).toBe(true);
    expect(useDevProfile({ packaged: true, env: { FABDESK_DEV_PROFILE: "true" } })).toBe(true);
    expect(useDevProfile({ packaged: false, env: { FABDESK_DEV_PROFILE: "0" } })).toBe(false);
    expect(useDevProfile({ packaged: false, env: { FABDESK_DEV_PROFILE: "false" } })).toBe(false);
  });

  test("unknown flag values fall back to packaged", () => {
    expect(parseDevProfileFlag(undefined)).toBeUndefined();
    expect(parseDevProfileFlag("")).toBeUndefined();
    expect(parseDevProfileFlag("yes")).toBeUndefined();
    expect(useDevProfile({ packaged: true, env: { FABDESK_DEV_PROFILE: "yes" } })).toBe(false);
  });
});

describe("desktopIdentity", () => {
  test("dev and prod names, AUMIDs and core homes differ", () => {
    const dev = desktopIdentity(true);
    const prod = desktopIdentity(false);
    expect(dev.productName).toBe(DEV_PRODUCT_NAME);
    expect(prod.productName).toBe(PROD_PRODUCT_NAME);
    expect(dev.appUserModelId).toBe(DEV_APP_USER_MODEL_ID);
    expect(prod.appUserModelId).toBe(PROD_APP_USER_MODEL_ID);
    expect(dev.appUserModelId).not.toBe(prod.appUserModelId);
    expect(dev.coreHomeDirName).toBe(DEV_CORE_HOME_DIR);
    expect(prod.coreHomeDirName).toBe(PROD_CORE_HOME_DIR);
    expect(dev.desktopName).toBe(DEV_DESKTOP_NAME);
    expect(dev.linuxWmClass).toBe(DEV_LINUX_WM_CLASS);
    expect(dev.defaultCorePort).toBe(DEFAULT_DEV_CORE_PORT);
  });
});

describe("paths", () => {
  test("userData and core home are distinct for each profile on every platform", () => {
    const linux = { HOME: "/home/me" };
    expect(resolveUserDataPath({ productName: PROD_PRODUCT_NAME, env: linux, platform: "linux" })).toBe(
      "/home/me/.config/Fabdesk",
    );
    expect(resolveUserDataPath({ productName: DEV_PRODUCT_NAME, env: linux, platform: "linux" })).toBe(
      "/home/me/.config/Fabdesk Dev",
    );
    expect(resolveCoreHome({ env: linux, platform: "linux", dirName: PROD_CORE_HOME_DIR })).toBe(
      "/home/me/.config/fabdesk",
    );
    expect(resolveCoreHome({ env: linux, platform: "linux", dirName: DEV_CORE_HOME_DIR })).toBe(
      "/home/me/.config/fabdesk-dev",
    );

    const mac = { HOME: "/Users/me" };
    expect(resolveUserDataPath({ productName: DEV_PRODUCT_NAME, env: mac, platform: "darwin" })).toBe(
      "/Users/me/Library/Application Support/Fabdesk Dev",
    );
    expect(resolveCoreHome({ env: mac, platform: "darwin", dirName: DEV_CORE_HOME_DIR })).toBe(
      "/Users/me/Library/Application Support/fabdesk-dev",
    );

    const win = { HOME: "C:/Users/me", APPDATA: "C:/Users/me/AppData/Roaming" };
    expect(resolveUserDataPath({ productName: DEV_PRODUCT_NAME, env: win, platform: "win32" })).toBe(
      join("C:/Users/me/AppData/Roaming", "Fabdesk Dev"),
    );
    expect(resolveCoreHome({ env: win, platform: "win32", dirName: DEV_CORE_HOME_DIR })).toBe(
      join("C:/Users/me/AppData/Roaming", "fabdesk-dev"),
    );
  });

  test("honors XDG_CONFIG_HOME, APPDATA and FABDESK_HOME", () => {
    expect(platformAppDataDir({ HOME: "/home/me", XDG_CONFIG_HOME: "/home/me/.cfg" }, "linux")).toBe("/home/me/.cfg");
    expect(resolveUserDataPath({ productName: DEV_PRODUCT_NAME, env: { HOME: "/home/me", XDG_CONFIG_HOME: "/x" }, platform: "linux" })).toBe(
      "/x/Fabdesk Dev",
    );
    expect(resolveCoreHome({ env: { FABDESK_HOME: "/tmp/custom", HOME: "/home/me" }, platform: "linux", dirName: DEV_CORE_HOME_DIR })).toBe(
      "/tmp/custom",
    );
    expect(resolveCoreHome({ env: { FABDESK_HOME: "  ", HOME: "/home/me" }, platform: "linux", dirName: DEV_CORE_HOME_DIR })).toBe(
      "/home/me/.config/fabdesk-dev",
    );
  });
});

describe("ports", () => {
  test("dev-profile uses the fixed port; packaged production and binary overrides use random", () => {
    expect(resolveDevCorePort({})).toBe(DEFAULT_DEV_CORE_PORT);
    expect(resolveDevCorePort({ FABDESK_DEV_PORT: "47999" })).toBe("47999");
    expect(spawnCorePort({ packaged: false, devProfile: true })).toBe(DEFAULT_DEV_CORE_PORT);
    expect(spawnCorePort({ packaged: true, devProfile: true, env: { FABDESK_DEV_PORT: "47832" } })).toBe("47832");
    expect(spawnCorePort({ packaged: true, devProfile: false })).toBe("0");
    expect(spawnCorePort({ packaged: false, devProfile: false })).toBe("0");
    expect(spawnCorePort({ packaged: false, devProfile: true, binaryOverride: true })).toBe("0");
  });
});

describe("applyDesktopIdentity", () => {
  test("unpackaged sets name, userData, AUMID, Linux class and FABDESK_HOME", () => {
    const { calls, ...app } = fakeApp();
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    const identity = applyDesktopIdentity(app, { packaged: false, env, platform: "linux" });
    expect(identity.devProfile).toBe(true);
    expect(calls.setName).toBe(DEV_PRODUCT_NAME);
    expect(calls.userData).toBe("/home/me/.config/Fabdesk Dev");
    expect(calls.aumid).toBe(DEV_APP_USER_MODEL_ID);
    expect(calls.desktopName).toBe(DEV_DESKTOP_NAME);
    expect(calls.switches).toEqual([["class", DEV_LINUX_WM_CLASS]]);
    expect(env["FABDESK_HOME"]).toBe("/home/me/.config/fabdesk-dev");
  });

  test("packaged production is a no-op so existing ~/.config/Fabdesk keeps working", () => {
    const { calls, ...app } = fakeApp();
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    const identity = applyDesktopIdentity(app, { packaged: true, env, platform: "linux" });
    expect(identity).toEqual(desktopIdentity(false));
    expect(calls.setName).toBeUndefined();
    expect(calls.userData).toBeUndefined();
    expect(calls.aumid).toBeUndefined();
    expect(calls.desktopName).toBeUndefined();
    expect(calls.switches).toEqual([]);
    expect(env["FABDESK_HOME"]).toBeUndefined();
  });

  test("FABDESK_DEV_PROFILE=1 applies the isolated identity to a packaged build", () => {
    const { calls, ...app } = fakeApp("/Users/me/Library/Application Support");
    const env: NodeJS.ProcessEnv = { HOME: "/Users/me", FABDESK_DEV_PROFILE: "1" };
    applyDesktopIdentity(app, { packaged: true, env, platform: "darwin" });
    expect(calls.setName).toBe(DEV_PRODUCT_NAME);
    expect(calls.userData).toBe("/Users/me/Library/Application Support/Fabdesk Dev");
    expect(env["FABDESK_HOME"]).toBe("/Users/me/Library/Application Support/fabdesk-dev");
    expect(calls.desktopName).toBeUndefined();
    expect(calls.switches).toEqual([]);
  });

  test("leaves an explicit FABDESK_HOME alone", () => {
    const { ...app } = fakeApp();
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", FABDESK_HOME: "/tmp/mine" };
    applyDesktopIdentity(app, { packaged: false, env, platform: "linux" });
    expect(env["FABDESK_HOME"]).toBe("/tmp/mine");
  });
});
