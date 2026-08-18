import { effect, Injectable, signal } from "@angular/core";
import {
  applyTailngTheme,
  atlasDarkThemePreset,
  atlasThemePreset,
  createTheme,
  defaultDarkThemePreset,
  defaultThemePreset,
  minimalDarkThemePreset,
  minimalThemePreset,
  nexusDarkThemePreset,
  nexusThemePreset,
  prismDarkThemePreset,
  prismThemePreset,
  slateDarkThemePreset,
  slateThemePreset,
  sterlingDarkThemePreset,
  sterlingThemePreset,
} from "@tailng-ui/theme";

export type AppThemeName =
  | "default"
  | "minimal"
  | "slate"
  | "nexus"
  | "prism"
  | "atlas"
  | "sterling";

export interface ThemeOption {
  value: AppThemeName;
  label: string;
  description: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Balanced spacing and expressive accents for general product interfaces.",
  },
  {
    value: "minimal",
    label: "Minimal",
    description: "Compact and low-contrast when content density matters more than decoration.",
  },
  {
    value: "slate",
    label: "Slate",
    description: "Quiet neutrals for polished dashboards and dense application shells.",
  },
  {
    value: "nexus",
    label: "Nexus",
    description: "Modern accent balance suited to product surfaces with a little more energy.",
  },
  {
    value: "prism",
    label: "Prism",
    description: "Sharper contrast and brighter accents for expressive product moments.",
  },
  {
    value: "atlas",
    label: "Atlas",
    description: "Confident teal-led tones that feel grounded across operational tools.",
  },
  {
    value: "sterling",
    label: "Sterling",
    description: "Premium contrast and refined accents for more editorial or branded experiences.",
  },
];

const VALID_THEME_NAMES = new Set<AppThemeName>([
  "default",
  "minimal",
  "slate",
  "nexus",
  "prism",
  "atlas",
  "sterling",
]);

/** idnest brand accent applied on top of every preset */
const IDNEST_ACCENT_OVERRIDE = {
  tokens: {
    semantic: {
      accent: {
        brand: "#367588",
        brandHover: "#2c606f",
      },
      focus: {
        ring: "#367588",
      },
    },
  },
};

const THEME_PRESETS: Record<AppThemeName, { light: object; dark: object }> = {
  default: { light: defaultThemePreset, dark: defaultDarkThemePreset },
  minimal: { light: minimalThemePreset, dark: minimalDarkThemePreset },
  slate: { light: slateThemePreset, dark: slateDarkThemePreset },
  nexus: { light: nexusThemePreset, dark: nexusDarkThemePreset },
  prism: { light: prismThemePreset, dark: prismDarkThemePreset },
  atlas: { light: atlasThemePreset, dark: atlasDarkThemePreset },
  sterling: { light: sterlingThemePreset, dark: sterlingDarkThemePreset },
};

// ── localStorage persistence ──────────────────────────────────────────────────

const THEME_STORAGE_KEY = "admin:theme";

type PersistedTheme = { darkMode: boolean; themeName: AppThemeName };

function resolveThemeName(raw: unknown): AppThemeName {
  return typeof raw === "string" && VALID_THEME_NAMES.has(raw as AppThemeName)
    ? (raw as AppThemeName)
    : "atlas";
}

function loadPersistedTheme(): PersistedTheme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { darkMode: false, themeName: "atlas" };
    const parsed = JSON.parse(raw) as Partial<PersistedTheme>;
    return {
      darkMode: typeof parsed.darkMode === "boolean" ? parsed.darkMode : false,
      themeName: resolveThemeName(parsed.themeName),
    };
  } catch {
    return { darkMode: false, themeName: "atlas" };
  }
}

function persistTheme(darkMode: boolean, themeName: AppThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ darkMode, themeName }));
  } catch {
    // localStorage may be unavailable (private browsing, storage quota, etc.)
  }
}

/**
 * Plain signal-based theme service (no ngrx).
 * Applies the idnest teal brand accent on top of every preset.
 * Persists under key `admin:theme` in localStorage.
 */
@Injectable({ providedIn: "root" })
export class AppThemeService {
  private readonly _persisted = loadPersistedTheme();
  readonly darkMode = signal<boolean>(this._persisted.darkMode);
  readonly themeName = signal<AppThemeName>(this._persisted.themeName);

  constructor() {
    effect(() => {
      const presets = THEME_PRESETS[this.themeName()];
      const base = this.darkMode() ? presets.dark : presets.light;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyTailngTheme(createTheme(base as any, IDNEST_ACCENT_OVERRIDE) as any);
    });
  }

  setDarkMode(isDark: boolean): void {
    this.darkMode.set(isDark);
    persistTheme(isDark, this.themeName());
  }

  setThemeName(name: AppThemeName): void {
    this.themeName.set(name);
    persistTheme(this.darkMode(), name);
  }
}
