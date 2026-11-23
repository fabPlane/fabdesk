import { z } from "zod/v4";
import { AssemblyRelativePath } from "./assembly";
/** Transport scope for an existing native design, not a repository manifest or a board copy. */
export const NativeSourceContext = z
  .object({
    projectId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    sourcePath: AssemblyRelativePath.refine((path) => /\.kicad_(pcb|sch|pro)$/i.test(path)),
  })
  .strict();
export type NativeSourceContext = z.infer<typeof NativeSourceContext>;
export const NATIVE_SOURCE_HEADER = "x-fabdesk-native-source";
