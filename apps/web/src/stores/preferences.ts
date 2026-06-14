import { create } from "zustand"

type Density = "comfortable" | "compact"
type ViewMode = "table" | "grid"

interface PreferenceState {
  density: Density
  viewMode: ViewMode
  setDensity: (density: Density) => void
  setViewMode: (viewMode: ViewMode) => void
}

export const usePreferences = create<PreferenceState>((set) => ({
  density: "comfortable",
  viewMode: "table",
  setDensity: (density) => set({ density }),
  setViewMode: (viewMode) => set({ viewMode }),
}))
