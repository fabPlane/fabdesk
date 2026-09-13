/**
 * Pull-to-refresh state for a react-query result.
 *
 * `refreshing` must track the user's pull, not the query's `isRefetching`: every background
 * invalidation (a reconnect, an event) flips that true and back without a gesture, and on iOS a
 * RefreshControl shown that way stays stranded on screen.
 */
import { useCallback, useState } from "react";
import { RefreshControl } from "react-native";
import { useTheme } from "@/theme";

export function usePullRefresh(refetch: () => Promise<unknown>) {
  const t = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />;
}
