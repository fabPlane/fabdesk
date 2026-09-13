import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { isProductionFabplaneOrigin } from "@fabdesk/auth-client/browser";
import { Badge, Button, Card, Input } from "@/components/ui";
import { fabplaneApiOrigin } from "@/lib/api-origin";
import { haptic } from "@/state/haptics";
import { useAccount } from "@/state/account";
import { useTheme } from "@/theme";

function cloudHint(cloud: ReturnType<typeof useAccount.getState>["cloud"]): string | null {
  switch (cloud) {
    case "on":
      return "Appearance, haptics and keep-awake sync to this account.";
    case "local":
      return "Signed in. Cloud settings are not on this server yet, so they stay on this phone.";
    case "syncing":
      return "Syncing settings…";
    case "error":
      return "Could not reach cloud settings. Local preferences are unchanged.";
    default:
      return null;
  }
}

export function AccountCard() {
  const t = useTheme();
  const { snapshot, cloud, busy, login, loginWithPassword, logout } = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const production = isProductionFabplaneOrigin(fabplaneApiOrigin());
  const showPassword = __DEV__ && !production;
  const pending = snapshot.status === "pending" ? snapshot.pending : undefined;
  const signedIn = snapshot.status === "signed_in";
  const name =
    snapshot.principal?.displayName ?? snapshot.principal?.handle ?? snapshot.principal?.subject;

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>Account</Text>
        <Badge
          label={signedIn ? "signed in" : snapshot.status === "pending" ? "waiting" : "signed out"}
          tone={signedIn ? "success" : snapshot.status === "error" ? "danger" : "default"}
        />
      </View>
      {signedIn ? (
        <>
          <Text style={{ color: t.fg, fontSize: 14 }}>
            {name}
            {snapshot.principal?.email ? (
              <Text style={{ color: t.muted }}>{`  ${snapshot.principal.email}`}</Text>
            ) : null}
          </Text>
          {cloudHint(cloud) ? (
            <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
              {cloudHint(cloud)}
            </Text>
          ) : null}
          <Button
            title="Sign out"
            onPress={() => {
              haptic("selection");
              void logout();
            }}
            disabled={busy}
            style={{ marginTop: 10 }}
          />
        </>
      ) : pending ? (
        <>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>
            Approve this code in the browser at {pending.verificationUri}
          </Text>
          <Text
            selectable
            accessibilityLabel={`Sign-in code ${pending.userCode}`}
            style={{
              color: t.fg,
              fontSize: 28,
              fontWeight: "700",
              letterSpacing: 4,
              textAlign: "center",
              marginVertical: 10,
            }}
          >
            {pending.userCode}
          </Text>
          <Button
            title="Open browser"
            variant="primary"
            onPress={() => void Linking.openURL(pending.verificationUriComplete)}
          />
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
            Waiting for approval… expires {new Date(pending.expiresAt).toLocaleTimeString()}
          </Text>
        </>
      ) : (
        <>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginBottom: 10 }}>
            Sign in so appearance and preferences sync to the cloud. Later, this is how the app
            will reach your computers through our backend.
          </Text>
          <Button
            title={busy ? "Starting sign-in…" : "Sign in"}
            variant="primary"
            onPress={() => {
              haptic("selection");
              void login();
            }}
            disabled={busy}
          />
          {showPassword ? (
            <View style={{ marginTop: 12, gap: 8 }}>
              <Text style={{ color: t.muted, fontSize: 11, lineHeight: 16 }}>
                Staging/local only. Shared demo/maya accounts are not available in production.
              </Text>
              <Input
                accessibilityLabel="Email or handle"
                autoComplete="username"
                inputMode="email"
                placeholder="email or handle"
                value={email}
                onChangeText={setEmail}
                editable={!busy}
              />
              <Input
                accessibilityLabel="Password"
                autoComplete="password"
                secureTextEntry
                placeholder="password"
                value={password}
                onChangeText={setPassword}
                editable={!busy}
              />
              <Button
                title={busy ? "Signing in…" : "Sign in with password"}
                onPress={() => {
                  haptic("selection");
                  void loginWithPassword({ email: email.trim(), password });
                }}
                disabled={busy || !email.trim() || !password}
              />
            </View>
          ) : null}
        </>
      )}
      {snapshot.error ? (
        <Text style={{ color: t.danger, fontSize: 12, marginTop: 8 }}>{snapshot.error}</Text>
      ) : null}
    </Card>
  );
}
