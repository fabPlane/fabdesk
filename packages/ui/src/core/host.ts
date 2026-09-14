/** The browser/Electron host adapter. Platform-free pieces live in `@fabdesk/client-core`. */
import type { HostAdapter } from "@fabdesk/client-core";

export const browserHost: HostAdapter = {
  platform: "web",
  openExternal: (url) => {
    window.open(url, "_blank", "noopener");
  },
  pickFile: async () => [],
  localAuthAllowed: async () => false,
};
