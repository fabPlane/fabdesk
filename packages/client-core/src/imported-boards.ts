export type ImportedBoardSort = "version" | "path";
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const isBackupBoard = (path: string) => path.split("/").some(segment => /^(?:backups?|archives?)(?:[-_.]|$)|[-_.](?:backups?|archives?)$/i.test(segment));
const version = (path: string) => path.split("/").flatMap(segment => {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-_]|$)/i.exec(segment);
  return match ? [match[1]!.split(".").map(Number)] : [];
})[0];
/** Root sources first; never infer validity from version numbers or backup folder names. */
export function sortImportedBoards(paths: readonly string[], sort: ImportedBoardSort = "version"): string[] {
  return [...paths].sort((a, b) => {
    if (sort === "version") {
      const root = Number(a.includes("/")) - Number(b.includes("/"));
      if (root) return root;
      const av = version(a), bv = version(b);
      if (av && bv) {
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
          const delta = (bv[i] ?? 0) - (av[i] ?? 0);
          if (delta) return delta;
        }
      } else if (av || bv) return av ? -1 : 1;
    }
    return collator.compare(a, b) || a.localeCompare(b);
  });
}
export function importedBoardLabel(path: string): string {
  const pieces = path.split("/");
  return pieces.length > 1 ? pieces[pieces.length - 2]!.replace(/[-_]/g, " ") : pieces[0]!.replace(/\.kicad_pcb$/i, "");
}
