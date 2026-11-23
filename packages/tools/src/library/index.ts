export { extractPdfPageText, pdfPageCount } from "./pdf-text";
export {
  LIBRARY_MANIFEST,
  addLibraryFile,
  findLibraryEntry,
  listLibrary,
  loadLibraryFile,
  newLibraryId,
  patchLibraryEntry,
  removeLibraryEntry,
  saveLibraryFile,
  type LibraryListedEntry,
  type LibraryRoot,
} from "./store";
export { citeLibrary, libraryQueryTokens, searchLibrary } from "./search";
export { sharedLibraryItems } from "./share";
export type { ProjectHandle } from "../registry";
export { ToolError } from "../registry";
