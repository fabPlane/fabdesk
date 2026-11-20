import { useLivePreview,type PreviewScope } from "./live-previews";
export { readBoardLayers,runPreviewTool } from "./live-previews";

/** Visible views and project warm-up subscribe to the same cached native jobs. */
export function useAutomaticBoardViews(options: PreviewScope & { sourceStamp: string; mode: "pcb" | "3d" | "layers" }) {
  const pcb = useLivePreview("pcb", { ...options, foreground: options.mode === "pcb" });
  const model = useLivePreview("model", { ...options, foreground: options.mode !== "layers" });
  const layers = useLivePreview("layers", { ...options, foreground: options.mode === "layers" });
  const prefix = !options.directory || options.directory === "." ? "" : `${options.directory}/`;
  return {
    pcb: { ...pcb, data: pcb.data?.svg },
    model: { ...model, data: model.data?.model },
    layers: { ...layers, data: layers.data?.layers },
    source: { error: pcb.error, isError: pcb.isError, isFetching: pcb.updating, refetch: pcb.retry },
    path: prefix + "renders/board.glb",
  };
}
