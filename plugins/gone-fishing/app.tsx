import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import {
  CATCH_CHANNEL,
  findSpecies,
  MAPS,
  mapName,
  RARITIES,
  SEASONS,
  seasonOf,
  SPECIES,
  timeOfDay,
  type Catch,
  type MapId,
  type Rarity,
  type Species,
} from "./catalog.js";
import {
  approachingFish,
  changeMap,
  finish,
  newGame,
  press,
  release,
  resume,
  step,
  type GameEvent,
  type GameState,
} from "./game.js";
import { drawFishPortrait, PIXEL_SCALE, PondScene, SCENE_HEIGHT } from "./scene.js";
import { insertComposerSlot, squareComposerTop } from "./composer-dom.js";
import { flood } from "./underwater.js";
import {
  BOATS,
  DEFAULT_LOOK,
  DOGS,
  HATS,
  isUnlocked,
  JACKETS,
  PAINTS,
  PROFILE_CHANNEL,
  resolveSeason,
  SEASON_NAMES,
  SKINS,
  type Look,
  type Option,
} from "./look.js";
import { progressLabel, requirementLabel, type Stats } from "./progress.js";

type FishBook = PluginRpcResult<(typeof rpcContract)["fishBook"]>;
type Profile = PluginRpcResult<(typeof rpcContract)["profile"]>;

// Declared in package.json under bb.branding.experimental_icons.
const FISH_ICON = "gone-fishing/fish";
const FISH_BOOK_ACTION = "fish-book";
const TACKLE_BOX_ACTION = "tackle-box";
/** Longest single simulation step; longer gaps (a throttled tab) run in chunks. */
const MAX_STEP_MS = 100;
/** Longest gap one tick catches up on, so a sleeping laptop does not fish all night. */
const MAX_CATCH_UP_MS = 1_000;
const FRAME_MS = 33;
const BACKGROUND_TICK_MS = 250;
/**
 * `isRunning` dips to false for a moment at turn boundaries (a message sent
 * mid-turn, a queued message starting). Only a stop that lasts docks the boat.
 */
const STOP_GRACE_MS = 3_000;

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  legendary: "Legendary",
};

// One session per thread: the catches from the agent's current (or last) run.
// Module-level so the dock row survives the banner remounting on navigation.

type SessionCatch = Catch & {
  id: number;
  firstOfSpecies: boolean;
  personalBest: boolean;
  /** Maps and cosmetics this catch unlocked. */
  unlocked: string[];
};
type Session = { catches: SessionCatch[]; ended: boolean; dismissed: boolean };

const sessions = new Map<string, Session>();
const sessionListeners = new Set<() => void>();
let nextCatchId = 1;

function setSession(threadId: string, session: Session) {
  sessions.set(threadId, session);
  for (const listener of sessionListeners) listener();
}

function subscribeSessions(listener: () => void) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function useSession(threadId: string): Session | undefined {
  return useSyncExternalStore(subscribeSessions, () => sessions.get(threadId));
}

function startSession(threadId: string) {
  const session = sessions.get(threadId);
  if (!session || session.ended)
    setSession(threadId, { catches: [], ended: false, dismissed: false });
}

function endSession(threadId: string) {
  const session = sessions.get(threadId);
  if (session && !session.ended) setSession(threadId, { ...session, ended: true });
}

function addCatch(threadId: string, caught: Catch): number {
  const id = nextCatchId++;
  const session = sessions.get(threadId) ?? { catches: [], ended: false, dismissed: false };
  setSession(threadId, {
    ...session,
    catches: [
      ...session.catches,
      { ...caught, id, firstOfSpecies: false, personalBest: false, unlocked: [] },
    ],
  });
  return id;
}

function patchCatch(threadId: string, id: number, patch: Partial<SessionCatch>) {
  const session = sessions.get(threadId);
  if (!session) return;
  setSession(threadId, {
    ...session,
    catches: session.catches.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  });
}

function speciesName(id: string): string {
  return findSpecies(id)?.name ?? id;
}

/** "a" Bluegill, "an" Atlantic Salmon. */
function article(name: string): "a" | "an" {
  return /^[AEIOU]/i.test(name) ? "an" : "a";
}

function describeCatch(caught: Catch): string {
  return `${speciesName(caught.speciesId)}, ${caught.lengthCm} cm (${caught.tier})`;
}

/** The catch worth bragging about: rarest first, then biggest for its species. */
function bestCatch(catches: readonly SessionCatch[]): SessionCatch | undefined {
  const score = (entry: SessionCatch) => {
    const species = findSpecies(entry.speciesId);
    if (!species) return 0;
    const fraction = (entry.lengthCm - species.minCm) / Math.max(1, species.maxCm - species.minCm);
    return RARITIES.indexOf(species.rarity) + fraction * 0.99;
  };
  return catches.reduce<SessionCatch | undefined>(
    (best, entry) => (best === undefined || score(entry) > score(best) ? entry : best),
    undefined,
  );
}

type Hud = { text: string; mode: string; fight: boolean };

function hudFor(game: GameState, lastCatch: SessionCatch | undefined): Hud {
  const phase = game.phase;
  const active = game.mode === "active";
  const mode = active ? "Your rod" : "Auto";
  const hud = (text: string, fight = false): Hud => ({ text, mode, fight });
  switch (phase.kind) {
    case "casting":
      return hud("Casting…");
    case "waiting": {
      // Name the fish swimming up, so a rare one is worth taking the rod for.
      const approach = approachingFish(game);
      const species = approach ? findSpecies(approach.fish.speciesId) : undefined;
      if (species?.rarity === "legendary") {
        return hud(`A legendary ${species.name} is coming up!${active ? "" : " Take the rod"}`);
      }
      if (species?.rarity === "rare") return hud(`A rare ${species.name} is coming up…`);
      if (species)
        return hud(`${article(species.name) === "an" ? "An" : "A"} ${species.name} is coming up…`);
      return hud(
        active ? "Waiting for a bite…" : "Fishing while the agent works. Click to take the rod",
      );
    }
    case "nibble":
      return hud(active ? "Bite! Click to hook it" : "Bite!");
    case "fighting": {
      if (game.finishing) return hud("The agent's done. Landing this one…", true);
      if (phase.fish.legendary && !active) return hud("Something big… take the rod!", true);
      if (active) return hud(phase.running ? "It's running. Let go!" : "Hold to reel", true);
      return hud(phase.running ? "It's running…" : "Reeling in…", true);
    }
    case "landed": {
      const caught = lastCatch ?? phase.fish;
      const flags = lastCatch?.unlocked.length
        ? ` · Unlocked ${lastCatch.unlocked.join(", ")}!`
        : lastCatch?.firstOfSpecies === true
          ? " · New species!"
          : lastCatch?.personalBest === true
            ? " · Personal best!"
            : "";
      return hud(`${describeCatch(caught)}${flags}`);
    }
    case "lost":
      return hud(
        {
          missed: "Missed it.",
          snapped: "Snap! You held on through a run.",
          escaped: "It got away.",
          "too-big": "The big one got away. Take the rod to land legendaries.",
        }[phase.reason],
      );
    case "docked":
      return hud("Back at the dock");
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      // Storage can be unavailable (private browsing, blocked cookies).
      return false;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Best effort only.
      }
    },
    [key],
  );
  return [value, update];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// One profile for the whole window, so a change in the tackle box reaches every
// pond in the same frame.
let sharedProfile: Profile | null = null;
const profileListeners = new Set<() => void>();

function setSharedProfile(next: Profile) {
  sharedProfile = next;
  for (const listener of profileListeners) listener();
}

function subscribeProfile(listener: () => void) {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

// Signals are not replayed, so catch up after the socket reconnects.
function useResyncOnReconnect(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) refresh();
    connectedBefore.current = true;
  }, [connection, refresh]);
}

/** Bumped by every profile load and save; only the latest answer may land. */
let profileRequest = 0;

/**
 * The saved look and the player's progress, kept fresh over realtime. Ponds
 * only need the look; `liveStats` also refreshes progress after every catch.
 */
function useProfile({ liveStats = false }: { liveStats?: boolean } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const profile = useSyncExternalStore(subscribeProfile, () => sharedProfile);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++profileRequest;
    try {
      const next = await rpc.call("profile");
      if (request === profileRequest) setSharedProfile(next);
      setError(null);
    } catch (cause) {
      if (request === profileRequest) setError(errorMessage(cause));
    }
  }, [rpc]);
  const refresh = useCallback(() => void load(), [load]);
  const refreshStats = useCallback(() => {
    if (liveStats) void load();
  }, [liveStats, load]);
  useEffect(refresh, [refresh]);
  useRealtime(PROFILE_CHANNEL, refresh);
  useRealtime(CATCH_CHANNEL, refreshStats);
  useResyncOnReconnect(refresh);

  const saveLook = useCallback(
    async (look: Look) => {
      const request = ++profileRequest;
      if (sharedProfile) setSharedProfile({ ...sharedProfile, look });
      try {
        const saved = await rpc.call("setLook", look);
        if (request === profileRequest) setSharedProfile(saved);
        setError(null);
      } catch (cause) {
        const message = errorMessage(cause);
        // Put the saved look back, then say why the choice did not stick.
        await load();
        setError(message);
      }
    },
    [load, rpc],
  );
  return { profile, error, saveLook };
}

function IconButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

/**
 * A slot right above the chat input. Banners render at the top of bb's card
 * stack, so the pond portals here to sit next to the chat input instead. Null
 * when bb's markup is not recognized; the pond then stays in the banner.
 */
function useComposerSlot(
  markerRef: RefObject<HTMLElement | null>,
  pluginId: string,
): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const created = marker ? insertComposerSlot(marker, pluginId) : null;
    if (!created) return;
    setSlot(created);
    return () => created.remove();
  }, [markerRef, pluginId]);
  return slot;
}

function PondBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return (
    <ThreadPond
      threadId={composer.scope.threadId}
      isRunning={composer.isRunning}
      compact={composer.layout === "compact"}
    />
  );
}

function ThreadPond({
  threadId,
  isRunning,
  compact,
}: {
  threadId: string;
  isRunning: boolean;
  compact: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const session = useSession(threadId);
  const reducedMotion = useReducedMotion();
  const [collapsed, setCollapsed] = useStoredFlag(`${pluginId}.collapsed`);
  const [fishing, setFishing] = useState(isRunning);
  const [hud, setHud] = useState<Hud>(() => hudFor(newGame(), undefined));
  const [announcement, setAnnouncement] = useState("");

  const gameRef = useRef<GameState>(newGame());
  const lastCatchRef = useRef<SessionCatch | undefined>(undefined);
  const hudRef = useRef(hud);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null);
  const tensionRef = useRef<HTMLSpanElement | null>(null);
  const onScreenRef = useRef(true);
  const { profile } = useProfile();
  const look = profile?.look ?? DEFAULT_LOOK;
  const lookRef = useRef<Look>(look);
  lookRef.current = look;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const showPond = fishing && !collapsed && !compact;
  const flooded = fishing && !collapsed;
  // Stays in the banner slot, so it can find the composer even while the pond
  // renders elsewhere.
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const slot = useComposerSlot(markerRef, pluginId);
  // In the slot, the pond and the chat input below it read as one box.
  const frame = slot ? "rounded-t-xl border-b-0" : "rounded-lg";

  // The agent's run state drives the session: cast when it starts, and dock
  // once it has stopped for a while and nothing is left on the line.
  useEffect(() => {
    if (isRunning) {
      startSession(threadId);
      gameRef.current = resume(gameRef.current);
      setFishing(true);
      return;
    }
    const timer = setTimeout(() => {
      gameRef.current = finish(gameRef.current);
      if (gameRef.current.phase.kind === "docked") {
        endSession(threadId);
        setFishing(false);
      }
    }, STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isRunning, threadId]);

  // While the pond is open, the chat input below it floods too.
  useEffect(() => {
    const marker = markerRef.current;
    if (!flooded || !marker) return;
    const drain = flood(marker, {
      getGame: () => gameRef.current,
      getLook: () => lookRef.current,
      isReducedMotion: () => reducedMotionRef.current,
    });
    return drain ?? undefined;
  }, [flooded]);

  // A new map brings its own fish; a fish on the line stays hooked.
  useEffect(() => {
    gameRef.current = changeMap(gameRef.current);
  }, [look.map]);

  const onCaught = useCallback(
    (caught: Catch, mode: "passive" | "active", mapId: MapId) => {
      const id = addCatch(threadId, caught);
      lastCatchRef.current = sessions.get(threadId)?.catches.find((entry) => entry.id === id);
      setAnnouncement(`Caught ${article(speciesName(caught.speciesId))} ${describeCatch(caught)}`);
      rpc
        .call("recordCatch", {
          threadId,
          speciesId: caught.speciesId,
          lengthCm: caught.lengthCm,
          mode,
          mapId,
        })
        .then(
          (result) => {
            patchCatch(threadId, id, {
              firstOfSpecies: result.firstOfSpecies,
              personalBest: result.personalBest,
              unlocked: result.unlocked,
            });
            if (lastCatchRef.current?.id === id) {
              lastCatchRef.current = sessions
                .get(threadId)
                ?.catches.find((entry) => entry.id === id);
            }
          },
          (cause) => console.warn(`[${pluginId}] Could not save a catch: ${errorMessage(cause)}`),
        );
    },
    [pluginId, rpc, threadId],
  );

  // One loop per open pond: steps the game, draws when visible, and drops to a
  // slow tick when the strip is collapsed, off screen, or the tab is hidden. It
  // restarts when the pond moves into the slot, which remounts its canvas.
  useEffect(() => {
    if (!fishing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = performance.now();
    const scene = canvasRef.current ? new PondScene(canvasRef.current) : null;

    const handle = (events: GameEvent[]) => {
      for (const event of events) {
        if (event.type === "caught") onCaught(event.fish, event.mode, event.mapId);
        if (event.type === "lost") setAnnouncement(hudFor(gameRef.current, undefined).text);
      }
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      let remaining = Math.min(MAX_CATCH_UP_MS, now - last);
      last = now;
      const date = new Date();
      const context = { rng: Math.random, timeOfDay: timeOfDay(date), mapId: lookRef.current.map };
      while (remaining > 0) {
        const dt = Math.min(MAX_STEP_MS, remaining);
        remaining -= dt;
        const result = step(gameRef.current, dt, context);
        gameRef.current = result.state;
        handle(result.events);
      }

      const game = gameRef.current;
      if (game.phase.kind === "docked") {
        endSession(threadId);
        setFishing(false);
        return;
      }

      const next = hudFor(game, lastCatchRef.current);
      if (
        next.text !== hudRef.current.text ||
        next.mode !== hudRef.current.mode ||
        next.fight !== hudRef.current.fight
      ) {
        hudRef.current = next;
        setHud(next);
      }
      if (game.phase.kind === "fighting") {
        progressRef.current?.style.setProperty(
          "width",
          `${Math.round(game.phase.progress * 100)}%`,
        );
        tensionRef.current?.style.setProperty("width", `${Math.round(game.phase.tension * 100)}%`);
      }

      const canvas = canvasRef.current;
      const visible =
        scene !== null &&
        canvas !== null &&
        onScreenRef.current &&
        document.visibilityState === "visible";
      if (visible) {
        scene.resize(canvas.clientWidth);
        scene.draw({
          game,
          look: lookRef.current,
          season: resolveSeason(lookRef.current, date),
          timeOfDay: context.timeOfDay,
          now,
          reducedMotion: reducedMotionRef.current,
        });
      }
      // Timers keep running (throttled) in hidden tabs, where animation frames stop.
      const delay = visible ? FRAME_MS - (performance.now() - now) : BACKGROUND_TICK_MS;
      timer = setTimeout(tick, Math.max(0, delay));
    };
    tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [fishing, showPond, onCaught, threadId, slot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!showPond || !canvas) return;
    const observer = new IntersectionObserver(([entry]) => {
      onScreenRef.current = entry?.isIntersecting ?? true;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [showPond, slot]);

  const grab = () => {
    gameRef.current = press(gameRef.current);
  };
  const letGo = () => {
    gameRef.current = release(gameRef.current);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    grab();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) grab();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " || event.key === "Enter") letGo();
  };
  const openFishBook = () => {
    navigate.openThreadPanel({ actionId: FISH_BOOK_ACTION, title: "Fish book" });
  };
  const openTackleBox = () => {
    navigate.openThreadPanel({ actionId: TACKLE_BOX_ACTION, title: "Tackle box" });
  };

  const count = session?.catches.length ?? 0;
  const liveRegion = (
    <span className="sr-only" aria-live="polite">
      {announcement}
    </span>
  );

  let content: ReactNode = null;
  if (!fishing) {
    if (session?.ended && !session.dismissed && count > 0) {
      const best = bestCatch(session.catches);
      const firsts = session.catches.filter((entry) => entry.firstOfSpecies).length;
      const unlocked = session.catches.flatMap((entry) => entry.unlocked);
      content = (
        <section
          aria-label="Gone Fishing"
          className={`flex h-8 items-center gap-2 border border-border bg-card pr-1 pl-3 text-xs text-foreground ${frame}`}
        >
          <Icon name={FISH_ICON} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Back at the dock with{" "}
            <span className="font-medium">{count === 1 ? "1 fish" : `${count} fish`}</span>
            {best ? (
              <span className="text-muted-foreground"> · best: {describeCatch(best)}</span>
            ) : null}
            {firsts > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · {firsts === 1 ? "1 new species" : `${firsts} new species`}
              </span>
            ) : null}
            {unlocked.length > 0 ? (
              <span className="text-muted-foreground"> · unlocked {unlocked.join(", ")}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={openFishBook}
            className="rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Fish book
          </button>
          <IconButton
            label="Dismiss"
            icon="X"
            onClick={() => setSession(threadId, { ...session, dismissed: true })}
          />
        </section>
      );
    }
  } else if (!showPond) {
    content = (
      <section
        aria-label="Gone Fishing"
        className={`flex h-8 items-center gap-2 border border-border bg-card pr-1 pl-3 text-xs text-foreground ${frame}`}
      >
        <Icon name={FISH_ICON} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{hud.text}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{count} caught</span>
        {compact ? null : (
          <IconButton label="Show the pond" icon="ChevronUp" onClick={() => setCollapsed(false)} />
        )}
        {liveRegion}
      </section>
    );
  } else {
    content = (
      <section
        aria-label="Gone Fishing"
        className={`relative overflow-hidden border border-border bg-card ${frame}`}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Fishing pond. Press and hold to reel; let go while the fish runs."
          className="block w-full cursor-pointer touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ height: SCENE_HEIGHT * PIXEL_SCALE }}
          // Keep the caret in the composer: clicking the pond must not steal focus.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerUp={letGo}
          onPointerCancel={letGo}
          onLostPointerCapture={letGo}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={letGo}
        >
          <canvas
            ref={canvasRef}
            className="block size-full"
            style={{ imageRendering: "pixelated" }}
            aria-hidden
          />
        </div>
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-background/85 p-0.5 shadow-sm backdrop-blur-sm">
          <span className="px-1.5 text-xs text-muted-foreground tabular-nums">{count} caught</span>
          <IconButton label="Open the fish book" icon={FISH_ICON} onClick={openFishBook} />
          <IconButton label="Open the tackle box" icon="Toolbox" onClick={openTackleBox} />
          <IconButton label="Hide the pond" icon="ChevronDown" onClick={() => setCollapsed(true)} />
        </div>
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 flex max-w-[60%] items-center gap-2 rounded-md bg-background/85 px-2 py-0.5 text-xs shadow-sm backdrop-blur-sm">
          <span className="shrink-0 font-medium text-foreground">{hud.mode}</span>
          <span className="min-w-0 truncate text-muted-foreground">{hud.text}</span>
          {hud.fight ? (
            <span className="flex w-16 shrink-0 flex-col gap-0.5" aria-hidden>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span ref={progressRef} className="block h-full w-0 bg-success" />
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-muted">
                <span ref={tensionRef} className="block h-full w-0 bg-destructive" />
              </span>
            </span>
          ) : null}
        </div>
        {liveRegion}
      </section>
    );
  }

  const hasContent = content !== null;
  useLayoutEffect(() => {
    if (!slot) return;
    slot.hidden = !hasContent;
    const marker = markerRef.current;
    if (!hasContent || !marker) return;
    return squareComposerTop(marker) ?? undefined;
  }, [slot, hasContent]);

  return (
    <>
      <span ref={markerRef} hidden />
      {slot && hasContent ? createPortal(content, slot) : content}
    </>
  );
}

function FishPortrait({ species, caught }: { species: Species; caught: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    drawFishPortrait(canvas, species);
    canvas.style.width = `${canvas.width * 4}px`;
    canvas.style.height = `${canvas.height * 4}px`;
  }, [species]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0"
      style={{
        imageRendering: "pixelated",
        filter: caught ? undefined : "brightness(0)",
        opacity: caught ? 1 : 0.2,
      }}
    />
  );
}

function timesLabel(species: Species): string | null {
  if (!species.times) return null;
  return `Swims in at ${species.times.join(" and ")}`;
}

function FishBookPanel(_props: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [book, setBook] = useState<FishBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("fishBook").then(
      (next) => {
        if (request !== latestRequest.current) return;
        setBook(next);
        setError(null);
      },
      (cause) => {
        if (request === latestRequest.current) setError(errorMessage(cause));
      },
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(CATCH_CHANNEL, load);
  useResyncOnReconnect(load);

  if (error)
    return <p className="text-sm text-destructive">Could not load the fish book: {error}</p>;
  if (!book) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const entries = new Map(book.species.map((entry) => [entry.id, entry]));
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {entries.size} of {SPECIES.length} species ·{" "}
          {book.totalCatches === 1 ? "1 catch" : `${book.totalCatches} catches`}
        </p>
        <p className="text-xs text-muted-foreground">
          {MAPS.map((map) => {
            const locals = SPECIES.filter((species) => species.homes.includes(map.id));
            const caught = locals.filter((species) => entries.has(species.id)).length;
            return `${map.name} ${caught}/${locals.length}`;
          }).join(" · ")}
        </p>
      </div>
      {RARITIES.map((rarity) => (
        <section key={rarity} className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {RARITY_LABEL[rarity]}
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {SPECIES.filter((species) => species.rarity === rarity).map((species) => {
              const entry = entries.get(species.id);
              const hint = timesLabel(species);
              return (
                <li
                  key={species.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <span className="flex w-12 shrink-0 justify-center">
                    <FishPortrait species={species} caught={entry !== undefined} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {entry ? species.name : "???"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry
                        ? `×${entry.count} · best ${entry.bestCm} cm (${entry.bestTier})`
                        : (hint ?? "Not caught yet")}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground/80">
                      {species.homes.map(mapName).join(", ")}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OptionChip({
  option,
  selected,
  stats,
  swatch,
  onSelect,
}: {
  option: Option;
  selected: boolean;
  stats: Stats;
  swatch?: string;
  onSelect: () => void;
}) {
  const unlocked = isUnlocked(option, stats);
  const requirement = option.unlock
    ? `${requirementLabel(option.unlock, mapName)} (${progressLabel(option.unlock, stats)})`
    : "";
  return (
    <button
      type="button"
      disabled={!unlocked}
      aria-pressed={selected}
      title={unlocked ? option.name : `Locked: ${requirement}`}
      onClick={onSelect}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        selected
          ? "border-foreground bg-muted text-foreground"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
    >
      {swatch ? (
        <span
          className="size-3 shrink-0 rounded-sm border border-border"
          style={{ background: swatch }}
          aria-hidden
        />
      ) : null}
      <span>{option.name}</span>
      {!unlocked && option.unlock ? (
        <span className="text-[10px] tabular-nums">{progressLabel(option.unlock, stats)}</span>
      ) : null}
    </button>
  );
}

function ChoiceRow<T extends Option>({
  label,
  options,
  value,
  stats,
  swatch,
  onSelect,
}: {
  label: string;
  options: readonly T[];
  value: string;
  stats: Stats;
  swatch?: (option: T) => string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <OptionChip
            key={option.id}
            option={option}
            selected={option.id === value}
            stats={stats}
            swatch={swatch?.(option)}
            onSelect={() => onSelect(option.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** The pond with the current look, idling. */
function LookPreview({ look }: { look: Look }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lookRef = useRef(look);
  lookRef.current = look;
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new PondScene(canvas);
    const game: GameState = {
      ...newGame(),
      phase: { kind: "waiting", elapsed: 0, biteAt: Infinity, approach: null },
    };
    let frame = 0;
    let last = -Infinity;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;
      const date = new Date();
      scene.resize(canvas.clientWidth);
      scene.draw({
        game,
        look: lookRef.current,
        season: resolveSeason(lookRef.current, date),
        timeOfDay: timeOfDay(date),
        now,
        reducedMotion: reducedMotionRef.current,
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="block w-full rounded-lg border border-border"
      style={{ height: SCENE_HEIGHT * PIXEL_SCALE, imageRendering: "pixelated" }}
    />
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function TackleBoxPanel(_props: PluginThreadPanelProps) {
  const { profile, error, saveLook } = useProfile({ liveStats: true });
  if (!profile) {
    return error ? (
      <p className="text-sm text-destructive">Could not load the tackle box: {error}</p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }

  const { look, stats } = profile;
  const choose = (part: keyof Look, id: string) => void saveLook({ ...look, [part]: id } as Look);
  const currentSeason = SEASON_NAMES[seasonOf(new Date())];
  return (
    <div className="space-y-5">
      <LookPreview look={look} />
      <p className="text-xs text-muted-foreground">
        {stats.catches} fish · {stats.species} species · {stats.legendaries} legendary · {stats.xl}{" "}
        XL. Catch more to unlock maps and gear.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <section className="space-y-2">
        <SectionTitle>Map</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-3">
          {MAPS.map((map) => {
            const unlocked = isUnlocked(map, stats);
            const species = SPECIES.filter((entry) => entry.homes.includes(map.id)).length;
            return (
              <button
                key={map.id}
                type="button"
                disabled={!unlocked}
                aria-pressed={look.map === map.id}
                onClick={() => choose("map", map.id)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  look.map === map.id
                    ? "border-foreground bg-muted"
                    : "border-border hover:bg-muted"
                } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
              >
                <span className="block text-sm font-medium text-foreground">{map.name}</span>
                <span className="block text-xs text-muted-foreground">{map.description}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {unlocked || !map.unlock
                    ? `${species} species`
                    : `Locked · ${requirementLabel(map.unlock, mapName)} (${progressLabel(map.unlock, stats)})`}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle>Season</SectionTitle>
        <ChoiceRow
          label="Seasons follow your calendar unless you pin one"
          options={[
            { id: "auto", name: `Calendar (${currentSeason})` },
            ...SEASONS.map((season) => ({ id: season, name: SEASON_NAMES[season] })),
          ]}
          value={look.season}
          stats={stats}
          onSelect={(id) => choose("season", id)}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Angler</SectionTitle>
        <ChoiceRow
          label="Skin tone"
          options={SKINS}
          value={look.skin}
          stats={stats}
          swatch={(skin) => skin.color}
          onSelect={(id) => choose("skin", id)}
        />
        <ChoiceRow
          label="Hat"
          options={HATS}
          value={look.hat}
          stats={stats}
          swatch={(hat) => Object.values(hat.ink)[0]}
          onSelect={(id) => choose("hat", id)}
        />
        <ChoiceRow
          label="Jacket"
          options={JACKETS}
          value={look.jacket}
          stats={stats}
          swatch={({ colors: [main, check] }) =>
            check ? `repeating-conic-gradient(${main} 0 25%, ${check} 0 50%) 0 0 / 6px 6px` : main
          }
          onSelect={(id) => choose("jacket", id)}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Boat</SectionTitle>
        <ChoiceRow
          label="Style"
          options={BOATS}
          value={look.boat}
          stats={stats}
          onSelect={(id) => choose("boat", id)}
        />
        <ChoiceRow
          label="Paint"
          options={PAINTS}
          value={look.paint}
          stats={stats}
          swatch={(paint) => `linear-gradient(${paint.trim} 0 40%, ${paint.hull} 40%)`}
          onSelect={(id) => choose("paint", id)}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Dog</SectionTitle>
        <ChoiceRow
          label="Coat"
          options={DOGS}
          value={look.dog}
          stats={stats}
          swatch={(dog) => (dog.none ? undefined : dog.body)}
          onSelect={(id) => choose("dog", id)}
        />
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "pond",
    scopes: ["thread"],
    banners: [{ id: "pond", chrome: "bare", component: PondBanner }],
  });
  app.slots.threadPanelAction({
    id: FISH_BOOK_ACTION,
    title: "Fish book",
    icon: FISH_ICON,
    component: FishBookPanel,
  });
  app.slots.threadPanelAction({
    id: TACKLE_BOX_ACTION,
    title: "Tackle box",
    icon: "Toolbox",
    component: TackleBoxPanel,
  });
});
