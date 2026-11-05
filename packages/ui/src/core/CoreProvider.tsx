import { useUiStore } from "../stores/ui";
/**
 * The desktop's `CoreProvider`: the shared provider from `@fabdesk/client-core` with Route Cinema
 * wired in. Cinema needs a canvas, so its store stays in this package and the reducer receives it
 * as a sink rather than importing it.
 */
import { CoreProvider as BaseCoreProvider, type CoreProviderProps, type RouteSink } from "@fabdesk/client-core";
import { useCallback, useMemo } from "react";
import { useCinemaStore } from "../stores/cinema";
import { browserHost } from "./host";

export type { CoreProviderProps };

export function CoreProvider({ host = browserHost, ...rest }: CoreProviderProps) {
  const route = useMemo<RouteSink>(
    () => ({
      ingest: (line) => useCinemaStore.getState().ingest(line),
      setDone: (result) => useCinemaStore.getState().setDone(result),
    }),
    [],
  );
  const onSchematicFocus = useCallback<NonNullable<CoreProviderProps["onSchematicFocus"]>>(focus => {
    void rest.client.inspectBoardSources(focus.projectId).then(sources => useUiStore.getState().requestSchematicFocus(focus, rest.client.baseUrl, sources)).catch(() => {});
  }, [rest.client]);
  return <BaseCoreProvider host={host} route={route} onSchematicFocus={onSchematicFocus} {...rest} />;
}
