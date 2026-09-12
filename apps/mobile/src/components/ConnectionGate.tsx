/**
 * Every tab needs a live connection; this puts the reason it is missing on screen instead of an
 * empty list, and gives the one action that fixes it.
 */
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useConnection } from "@/transport/CoreConnection";
import { Button, Empty, Loading, Screen } from "./ui";

export function ConnectionGate({ children }: { children: ReactNode }) {
  const { phase, connection, error } = useConnection();

  if (phase === "idle" && !connection) {
    return (
      <Screen>
        <Empty
          title="No computer connected"
          hint="Pair with a machine running fabPlane to see its projects and chats."
          action={<Button title="Pair a computer" variant="primary" onPress={() => router.push("/connect")} />}
        />
      </Screen>
    );
  }

  if (phase === "locating") {
    return (
      <Screen>
        <Loading label={`Looking for ${connection?.name ?? "your computer"}…`} />
      </Screen>
    );
  }

  if (phase === "unreachable" || phase === "unauthorized") {
    return (
      <Screen>
        <Empty
          title={phase === "unauthorized" ? "Not paired any more" : "Can't reach that computer"}
          hint={error ?? undefined}
          action={<Button title="Connections" onPress={() => router.push("/connect")} />}
        />
      </Screen>
    );
  }

  return <>{children}</>;
}
