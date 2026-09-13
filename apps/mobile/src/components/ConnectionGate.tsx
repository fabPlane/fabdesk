/**
 * Every tab needs a live connection; this puts the reason it is missing on screen instead of an
 * empty list, and gives the one action that fixes it.
 */
import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useConnection } from "@/transport/CoreConnection";
import { useTheme } from "@/theme";
import { Button, Empty, Loading, Screen } from "./ui";

export function ConnectionGate({ children }: { children: ReactNode }) {
  const { phase, connection, error, retry } = useConnection();

  if (!connection) {
    return (
      <Screen>
        <Empty
          title="No computer connected"
          hint="Pair with a machine running fabPlane to see its projects and chats."
          action={
            <Button
              title="Pair a computer"
              variant="primary"
              onPress={() => router.push("/connect")}
            />
          }
        />
      </Screen>
    );
  }

  // A saved connection is "idle" for the render between hydration and the effect that starts
  // locating it; the provider underneath only exists from "connecting" on, so gate on that.
  if (phase === "idle" || phase === "locating") {
    return (
      <Screen>
        <Loading label={`Looking for ${connection.name}…`} />
      </Screen>
    );
  }

  if (phase === "unreachable" || phase === "core-offline" || phase === "unauthorized") {
    return (
      <Screen>
        <Unreachable
          title={
            phase === "unauthorized"
              ? "Not paired any more"
              : phase === "core-offline"
                ? "Your computer is offline"
                : "Can't reach that computer"
          }
          hint={error ?? undefined}
          canRetry={phase !== "unauthorized"}
          retry={retry}
        />
      </Screen>
    );
  }

  return <>{children}</>;
}

/**
 * The disconnected state is where a pull-to-refresh is most expected — the laptop woke up, the
 * phone is back on the tailnet — so the whole screen is a scroll view that retries on pull.
 */
function Unreachable({
  title,
  hint,
  canRetry,
  retry,
}: {
  title: string;
  hint: string | undefined;
  canRetry: boolean;
  retry: () => void;
}) {
  const t = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    retry();
    // `retry` only bumps an attempt counter; the locating phase takes over the screen within a
    // render, so the spinner just needs to outlive this frame.
    setTimeout(() => setRefreshing(false), 800);
  };
  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />
      }
    >
      <Empty
        title={title}
        hint={hint ? `${hint}\n\nPull down to try again.` : "Pull down to try again."}
        action={
          <View style={{ flexDirection: "row", gap: 8 }}>
            {canRetry ? <Button title="Try again" variant="primary" onPress={retry} /> : null}
            <Button title="Connections" onPress={() => router.push("/connect")} />
          </View>
        }
      />
    </ScrollView>
  );
}
