/**
 * The JS face of `modules/fabdesk-key-commands`. Optional on purpose: in Expo Go, or in a dev
 * client built before the module existed, it is `null` and hardware shortcuts are simply inert.
 */
import { requireOptionalNativeModule } from "expo";

export interface KeyCommandsModule {
  /** Replace the set of combos to listen for; ids are canonical `lib/key-combo` strings. */
  setCommands(ids: string[]): void;
  addListener(event: "onKeyCommand", listener: (event: { id: string }) => void): { remove(): void };
}

export const KeyCommands = requireOptionalNativeModule<KeyCommandsModule>("FabdeskKeyCommands");
