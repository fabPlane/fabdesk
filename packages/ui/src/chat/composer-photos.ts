/** Image files a user dropped or pasted into the composer. */
export function imageFilesFromList(files: FileList | File[] | null | undefined): File[] {
  if (!files) return [];
  return [...files].filter(
    (file) =>
      file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name),
  );
}

export function isSketchPath(path: string): boolean {
  return path.replace(/\\/g, "/").includes("sketches/");
}
