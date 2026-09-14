/**
 * Plain-JSON persistence for the small preference stores (list sort, appearance, …). Nothing here
 * is secret; SecureStore stays for the device tokens in `transport/connections.ts`.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJSONStorage } from "zustand/middleware";

export const jsonStorage = <T>() => createJSONStorage<T>(() => AsyncStorage);
