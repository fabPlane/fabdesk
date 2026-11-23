import { stat } from "node:fs/promises";
export const pathExists = (p: string) => stat(p).then(() => true, () => false);
