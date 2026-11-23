import { useMemo, useRef, useState } from "react";
import {
  useDeleteLibraryEntry,
  usePatchLibraryEntry,
  useProjectLibrary,
  useProjectLibrarySearch,
  useUploadLibraryFile,
} from "@fabdesk/client-core";
import type { LibraryKind } from "@fabdesk/protocol";
import { Button, EmptyState, IconButton, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { FileGlyph } from "./FileGlyph";
import { fileAppearance, formatFileSize } from "./file-explorer";
import { cn } from "../util";

const KINDS: Array<{ id: LibraryKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "datasheet", label: "Datasheets" },
  { id: "app_note", label: "App notes" },
  { id: "research", label: "Research" },
  { id: "image", label: "Images" },
  { id: "source", label: "Source" },
  { id: "reference_design", label: "Reference" },
];

export function LibraryPanel({
  projectId,
  selectedPath,
  onSelect,
}: {
  projectId: string;
  selectedPath: string | null;
  onSelect: (path: string, page?: number) => void;
}) {
  const library = useProjectLibrary(projectId);
  const upload = useUploadLibraryFile();
  const patch = usePatchLibraryEntry();
  const remove = useDeleteLibraryEntry();
  const picker = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LibraryKind | "all">("all");
  const [dropOver, setDropOver] = useState(false);
  const [linkRef, setLinkRef] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const search = useProjectLibrarySearch(projectId, query);
  const entries = useMemo(() => {
    const all = library.data?.entries ?? [];
    return kind === "all" ? all : all.filter((entry) => entry.kind === kind);
  }, [library.data?.entries, kind]);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof entries>();
    for (const entry of entries) {
      const list = map.get(entry.folder) ?? [];
      list.push(entry);
      map.set(entry.folder, list);
    }
    return [...map.entries()];
  }, [entries]);
  const selected = entries.find((entry) => entry.path === selectedPath) ?? library.data?.entries.find((entry) => entry.path === selectedPath);
  const hits = query.trim() ? (search.data?.hits ?? []) : [];

  async function addFiles(files: FileList | File[]) {
    setError(null);
    for (const file of [...files]) {
      try {
        await upload.mutateAsync({ projectId, file, filename: file.name });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not add that file.");
      }
    }
  }

  return (
    <div className="fd-library-panel">
      <div
        className={cn("fd-library-drop", dropOver && "is-over")}
        onDragEnter={(event) => {
          event.preventDefault();
          setDropOver(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDropOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropOver(false);
          if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
        }}
      >
        <p>Drop datasheets, app notes, images or source files here.</p>
        <Button size="sm" onClick={() => picker.current?.click()} disabled={upload.isPending}>
          <Icon name="paperclip" width={14} height={14} />
          Add files
        </Button>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.svg,.md,.txt,.csv,.json,.zip,.step,.stp,.c,.h,.cpp,.ts,.py"
          onChange={(event) => {
            if (event.target.files?.length) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <div className="relative">
        <Icon name="search" width={14} height={14} className="pointer-events-none absolute left-2 top-2 text-muted" />
        <Input
          aria-label="Search library files and PDF text"
          placeholder="Search names and contents…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 pl-7 pr-7 text-xs"
        />
      </div>
      <div className="fd-library-kinds" role="tablist" aria-label="Library kinds">
        {KINDS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={kind === item.id}
            className={cn(kind === item.id && "is-active")}
            onClick={() => setKind(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="px-3 text-xs text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        {library.isLoading && <div className="p-4"><Spinner /></div>}
        {query.trim() ? (
          search.isFetching && !hits.length ? (
            <Spinner />
          ) : hits.length ? (
            <ul className="m-0 list-none p-0">
              {hits.map((hit) => (
                <li key={`${hit.id}:${hit.page ?? "file"}`}>
                  <button
                    type="button"
                    className={cn("fd-file-row", selectedPath === hit.path && "is-selected")}
                    onClick={() => onSelect(hit.path, hit.page ?? undefined)}
                  >
                    <FileGlyph kind={fileAppearance(hit.path).kind} />
                    <span className="min-w-0 flex-1 truncate">
                      {hit.title}
                      {hit.page ? ` · p.${hit.page}` : ""}
                    </span>
                  </button>
                  <p className="fd-library-snippet">{hit.snippet}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-6 text-xs text-muted">No matching library files.</p>
          )
        ) : entries.length ? (
          <ul className="m-0 list-none p-0">
            {grouped.map(([folder, folderEntries]) => (
              <li key={folder}>
                <p className="fd-library-folder">{folder}</p>
                <ul className="m-0 list-none p-0">
                  {folderEntries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={cn("fd-file-row", selectedPath === entry.path && "is-selected")}
                        onClick={() => onSelect(entry.path)}
                      >
                        <FileGlyph kind={fileAppearance(entry.path).kind} />
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        <span className="fd-file-kind">{formatFileSize(entry.bytes)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No supporting documents yet">
            Add PDFs, images and notes so they stay with this board in git, export and sharing.
          </EmptyState>
        )}
      </div>
      {selected && (
        <div className="fd-library-link">
          <label>
            Link to component
            <Input
              aria-label="Component reference to link"
              placeholder="U1"
              value={linkRef}
              onChange={(event) => setLinkRef(event.target.value)}
              className="h-7 text-xs"
            />
          </label>
          <Button
            size="sm"
            disabled={!linkRef.trim() || patch.isPending}
            onClick={() => {
              const refs = [...new Set([...selected.linkedRefs, linkRef.trim()])];
              void patch.mutateAsync({ projectId, entryId: selected.id, patch: { linkedRefs: refs } });
              setLinkRef("");
            }}
          >
            Link
          </Button>
          <label>
            Tag
            <Input
              aria-label="Tag to add"
              placeholder="power"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              className="h-7 text-xs"
            />
          </label>
          <Button
            size="sm"
            disabled={!tag.trim() || patch.isPending}
            onClick={() => {
              const tags = [...new Set([...selected.tags, tag.trim()])];
              void patch.mutateAsync({ projectId, entryId: selected.id, patch: { tags } });
              setTag("");
            }}
          >
            Tag
          </Button>
          <IconButton
            title="Remove from library"
            size="sm"
            disabled={remove.isPending}
            onClick={() => void remove.mutateAsync({ projectId, entryId: selected.id })}
          >
            <Icon name="trash" width={14} height={14} />
          </IconButton>
          {selected.linkedRefs.length > 0 && (
            <p className="fd-library-refs">Linked: {selected.linkedRefs.join(", ")}</p>
          )}
          {selected.tags.length > 0 && <p className="fd-library-refs">Tags: {selected.tags.join(", ")}</p>}
        </div>
      )}
    </div>
  );
}
