/**
 * @fabdesk/client-core and @fabdesk/protocol are not installed here — they ship raw TypeScript that
 * Metro compiles with the rest of the app, so they are aliased to their source instead. That keeps
 * the Expo dependency tree out of the root lockfile (and out of every CI job and release runner),
 * while still hot-reloading on an edit in packages/.
 *
 * The peer dependencies those two need (react, zustand, zod, @tanstack/react-query) are direct
 * dependencies of this app, so they resolve from this app's node_modules.
 */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const clientCore = path.resolve(projectRoot, "../../packages/client-core");
const protocol = path.resolve(projectRoot, "../../packages/protocol");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [clientCore, protocol];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@fabdesk/client-core": clientCore,
  "@fabdesk/protocol": protocol,
};
// Resolution stays inside this app: the root install has no React Native in it.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
