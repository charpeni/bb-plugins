import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { PHASE_HINTS, PHASE_LABELS, PHASES, type PhaseTotals } from "./breakdown.js";
import { FAILED_COLOR, PHASE_COLORS } from "./palette.js";
import { BB_SENDER, formatDuration, type Status } from "./trace.js";
import { share } from "./util.js";

export function useColors() {
  const { mode } = experimental_useCodeTheme();
  return { phases: PHASE_COLORS[mode], failed: FAILED_COLOR[mode] };
}

/**
 * The tab is a fixed-height, flush region, so the plugin owns scrolling:
 * the header and footer stay put while the body scrolls.
 */
export function PanelLayout({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex shrink-0 flex-col gap-3 px-3 pt-3 pb-2">{header}</div>
      {children}
      {footer ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border">{footer}</div>
      ) : null}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="m-3 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** A turn's prompt, marked when another thread sent it rather than the user. */
export function PromptText({ prompt, sender }: { prompt: string; sender: string | null }) {
  if (!prompt) {
    return <span className="truncate italic text-muted-foreground">Continued on its own</span>;
  }
  return (
    <>
      {sender ? (
        <span
          className="shrink-0 rounded bg-muted px-1 text-[10.5px] text-muted-foreground"
          title={
            sender === BB_SENDER
              ? "A notice from bb, such as a spawned thread finishing"
              : `Sent by thread ${sender}`
          }
        >
          {sender === BB_SENDER ? "from bb" : "from thread"}
        </span>
      ) : null}
      <span className="truncate" title={prompt}>
        {prompt}
      </span>
    </>
  );
}

export interface StatItem {
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}

export function Stats({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-y-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 border-l border-border px-2 first:border-l-0"
          title={item.hint}
        >
          <div className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {item.label}
          </div>
          <div
            className={`text-base tabular-nums ${item.alert ? "text-destructive" : "text-foreground"}`}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Where the time went, as one stacked bar with each phase's share beneath it. */
export function BreakdownBar({ phases, total }: { phases: PhaseTotals; total: number }) {
  const { phases: colors } = useColors();
  const shown = PHASES.filter((phase) => phases[phase] > 0);
  return (
    <div className="flex flex-col gap-1.5 border-b border-border pb-3">
      <div className="flex h-2.5 overflow-hidden rounded-sm bg-muted">
        {shown.map((phase) => (
          <span
            key={phase}
            title={`${PHASE_LABELS[phase]}: ${formatDuration(phases[phase])} — ${PHASE_HINTS[phase]}`}
            style={{ flex: phases[phase], background: colors[phase] }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {shown.map((phase) => (
          <span key={phase} className="flex items-center gap-1.5" title={PHASE_HINTS[phase]}>
            <i
              className="inline-block size-2.5 rounded-[2px]"
              style={{ background: colors[phase] }}
            />
            <span className="text-foreground">{PHASE_LABELS[phase]}</span>
            <span className="tabular-nums">
              {share(phases[phase], total)} · {formatDuration(phases[phase])}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <span className="relative inline-flex size-2 shrink-0" title="Running">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex size-2 shrink-0 rounded-full bg-destructive" title="Failed" />
    );
  }
  if (status === "interrupted") {
    return (
      <span
        className="inline-flex size-2 shrink-0 rounded-full bg-muted-foreground"
        title="Interrupted"
      />
    );
  }
  return null;
}

/** A small toolbar button; `pressed` marks a toggle that is on. */
export function ToolButton({
  children,
  onClick,
  title,
  pressed,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 shrink-0 rounded-md border px-2 text-xs tabular-nums transition-colors disabled:opacity-40 ${
        pressed
          ? "border-foreground/30 bg-accent text-foreground"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-surface-recessed p-0.5"
      role="tablist"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`h-6 rounded-md px-2.5 text-xs transition-colors ${
            value === option.value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Opens what the tab shows in the Traces page; null where it already is the page. */
export const OpenInPage = createContext<(() => void) | null>(null);

export function OpenInPageButton() {
  const open = useContext(OpenInPage);
  if (!open) return null;
  return (
    <ToolButton onClick={open} title="Open in the Traces page, with room for the whole waterfall">
      ⤢
    </ToolButton>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
}

/** A button that opens a short list of actions below it. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !ref.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <ToolButton onClick={() => setOpen(!open)} pressed={open}>
        {label} ▾
      </ToolButton>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 flex min-w-56 flex-col rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
