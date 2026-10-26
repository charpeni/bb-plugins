import type { Phase } from "./breakdown.js";

// Fixed palette shared with Agent Calendar, validated for CVD separation in both modes.
export const PHASE_COLORS: Record<"light" | "dark", Record<Phase, string>> = {
  light: {
    waiting: "#eda100",
    startup: "#a3a29d",
    compaction: "#2a78d6",
    tools: "#1baf7a",
    subagents: "#c8c7c2",
    writing: "#e87ba4",
    thinking: "#9085e9",
    model: "#4a3aa7",
  },
  dark: {
    waiting: "#c98500",
    startup: "#6f6e69",
    compaction: "#3987e5",
    tools: "#199e70",
    subagents: "#55544f",
    writing: "#d55181",
    thinking: "#b4adf3",
    model: "#7d70e0",
  },
};

export const FAILED_COLOR = { light: "#e34948", dark: "#e66767" } as const;
