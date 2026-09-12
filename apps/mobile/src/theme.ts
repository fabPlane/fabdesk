/**
 * Colours mirroring the desktop's `--fd-*` tokens (packages/ui/src/styles.css), flattened into a
 * plain object because React Native has no CSS custom properties.
 */
import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  bg: string;
  panel: string;
  panel2: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  accentFg: string;
  danger: string;
  success: string;
  warning: string;
}

const light: Theme = {
  dark: false,
  bg: "#fbfaf8",
  panel: "#ffffff",
  panel2: "#f2f0ec",
  fg: "#1b1a17",
  muted: "#77736c",
  border: "#e3dfd8",
  accent: "#c2410c",
  accentFg: "#ffffff",
  danger: "#b91c1c",
  success: "#15803d",
  warning: "#a16207",
};

const dark: Theme = {
  dark: true,
  bg: "#16150f",
  panel: "#1e1c16",
  panel2: "#272419",
  fg: "#f1ede3",
  muted: "#9a9285",
  border: "#332f25",
  accent: "#f97316",
  accentFg: "#1b1a17",
  danger: "#f87171",
  success: "#4ade80",
  warning: "#fbbf24",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const themes = { light, dark };
