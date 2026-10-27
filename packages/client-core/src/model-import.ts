import { ImportedMechanicalModel, type MechanicalModelFormat, type MechanicalModelUnits } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";

export function mechanicalModelFormat(name: string): MechanicalModelFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension && ["stl", "glb", "obj", "step", "stp"].includes(extension) ? extension as MechanicalModelFormat : null;
}

/** One import destination per dialog. Retrying metadata never duplicates or converts original bytes. */
export function createModelImportSession({ projectId, client }: { projectId: string; client: Pick<CoreClient, "writeFile"> }) {
  const id = crypto.randomUUID();
  let saved: { file: Blob; model: ImportedMechanicalModel } | null = null;
  let pendingFile: Blob | null = null;
  let originalWritten = false;
  let inFlight: Promise<ImportedMechanicalModel> | null = null;
  return {
    save(file: Blob, name: string, units: MechanicalModelUnits): Promise<ImportedMechanicalModel> {
      if (saved && saved.file !== file) return Promise.reject(new Error("Start a new import to choose another file."));
      if (inFlight && pendingFile !== file) return Promise.reject(new Error("An import is already in progress for another file."));
      if (inFlight) return inFlight;
      pendingFile = file;
      inFlight = (async () => {
        if (!saved) {
          const format = mechanicalModelFormat(name);
          if (!format) throw new Error("Choose an STL, GLB, OBJ or STEP model.");
          if (file.size < 1 || file.size > 80 * 1024 * 1024) throw new Error("Choose a model between 1 byte and 80 MB.");
          if ((format === "glb" && units !== "m") || ((format === "step" || format === "stp") && units !== "file") || ((format === "stl" || format === "obj") && units === "file")) throw new Error("Confirm the model’s units before importing.");
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
          const safeName = name.replace(/[^a-zA-Z0-9_. -]/g, "_").replace(/^\.+/, "").slice(0, 180);
          const filename = safeName.toLowerCase().endsWith(`.${format}`) ? safeName : `model.${format}`;
          const model = ImportedMechanicalModel.parse({ contract: "fabplane.imported-mechanical-model.v1", id, originalName: name, path: `mechanical/imports/${id}/${filename}`, format, units, sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""), bytes: file.size, importedAt: new Date().toISOString(), placement: "unplaced" });
          saved = { file, model };
        }
        saved.model = ImportedMechanicalModel.parse({ ...saved.model, units });
        const { model } = saved;
        if (!originalWritten) { await client.writeFile(projectId, model.path, file); originalWritten = true; }
        await client.writeFile(projectId, `mechanical/imports/${id}/model.json`, JSON.stringify(model, null, 2) + "\n");
        return model;
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
