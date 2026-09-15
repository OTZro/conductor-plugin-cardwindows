/**
 * The cardwindows workspace store — module-level state machine, pure logic
 * (no React, no DOM), node-testable (cardwindows.test.ts).
 *
 * ONE-VIEW model (owner clarification 2026-09-10): the workspace is a RIGHT
 * REGION coexisting beside the real board whenever it has cards — there is
 * no separate view to enter or leave, so the former view state machine
 * (view/"toBoard"/"toWorkspace", the workspace chip) is DELETED. The store
 * holds the tile LIST plus region preferences — no rects (tile geometry is
 * derived at render from tiling.ts), no drag state, no per-card geometry
 * persistence.
 *
 * State machine:
 * - wins[]: open cards, seq = adoption order (slot order), stack = focus
 *   recency (dock highlight + LRU victim selection), minimized = lives in the
 *   dock only, out of the tile layout (component stays MOUNTED — the host
 *   hides it — so terminal buffers survive). wins empty ⟹ the region is gone.
 * - zoomedId: sticky ZOOM MODE (owner 2026-09-11, tmux-zoom-like): while set,
 *   ONE card is maximized and the dock chips act as tabs — focusing another
 *   card switches WHICH card is maximized, and a newly adopted card arrives
 *   maximized. Only the explicit ⛶ un-toggle (or the last card closing)
 *   exits the mode; closing/minimizing the zoomed card advances to the next
 *   most-recent visible card. Persisted with the session.
 * - mode: "auto" | "columns" | "grid" — the dock's layout chips; sticky for
 *   the session once touched.
 * - boardCollapsed: the boundary chevron's persisted preference — true hides
 *   the board side and the tiles take the full viewport width.
 * - LRU rule (spec §2.6.4): adopt/restore beyond the host-supplied capacity
 *   minimizes the least-recently-focused visible tile into the dock. Never
 *   stacks, never drops.
 *
 * Session persistence (owner amendment): ONLY the open-card id list (+
 * minimized ids, zoom target, layout mode) — localStorage, single key.
 * hydrate(cards) restores it once real card objects are available; the
 * region simply reappears beside the board. Storage falls back to an
 * in-memory map under node or when localStorage throws.
 */

import type { Card } from "../../../types";
import type { LayoutMode } from "./tiling";
import { MAX_VISIBLE, REGION_FRAC_DEFAULT } from "./tiling";

export type WinState = {
  id: string; // card id
  /** the card as adopted — fallback for cards missing from the live board
   * list (snoozed/dismissed); the host prefers the live object */
  card: Card;
  seq: number; // adoption order — tile slot order
  stack: number; // focus recency — higher = more recent (dock highlight, LRU)
  minimized: boolean;
  /** last known `card.lane` (baseline: the lane at adopt/hydrate time) — the
   * done-transition detector's memory (see syncLanes). Never used for
   * anything but that comparison. */
  lane: string;
};

export type Snapshot = {
  wins: readonly WinState[];
  zoomedId: string | null;
  mode: LayoutMode;
  /** boundary-chevron preference (persisted): true = the board side is
   * hidden and the tiles region spans the full viewport width. */
  boardCollapsed: boolean;
  /** the draggable divider's split — the region's fraction of the viewport
   * (persisted; regionWidth() clamps it against both minimums). */
  regionFrac: number;
  /** runtime mirror of App's boardish flag (synced by the host, NOT
   * persisted): the region renders only on board-like views; on terminals/
   * plugin tabs it hides and the inset drops to 0 (cards stay adopted). */
  boardish: boolean;
};

// ── session persistence ─────────────────────────────────────────────────────

const SESSION_KEY = "conductor.cardwindows.session";
const BOARD_COLLAPSED_KEY = "conductor.cardwindows.boardCollapsed"; // boundary chevron
const REGION_FRAC_KEY = "conductor.cardwindows.regionFrac"; // divider split

type SessionData = { ids: string[]; minimized: string[]; zoomed: string | null; mode: LayoutMode };

let memStore: Record<string, string> = {};
const storage = {
  get(key: string): string | null {
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    } catch {
      /* fall through */
    }
    return memStore[key] ?? null;
  },
  set(key: string, val: string): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, val);
        return;
      }
    } catch {
      /* quota / private mode — keep the in-memory copy */
    }
    memStore[key] = val;
  },
};

function saveSession(): void {
  const data: SessionData = {
    ids: [...wins].sort((a, b) => a.seq - b.seq).map((w) => w.id),
    minimized: wins.filter((w) => w.minimized).map((w) => w.id),
    zoomed: zoomedId,
    mode,
  };
  storage.set(SESSION_KEY, JSON.stringify(data));
}

function readSession(): SessionData | null {
  try {
    const raw = JSON.parse(storage.get(SESSION_KEY) || "null");
    return raw && typeof raw === "object" && Array.isArray(raw.ids) ? (raw as SessionData) : null;
  } catch {
    return null;
  }
}

function readBoardCollapsed(): boolean {
  return storage.get(BOARD_COLLAPSED_KEY) === "1";
}

function readRegionFrac(): number {
  const v = Number(storage.get(REGION_FRAC_KEY));
  return Number.isFinite(v) && v > 0 ? v : REGION_FRAC_DEFAULT;
}

// ── the store ───────────────────────────────────────────────────────────────

let wins: WinState[] = [];
let zoomedId: string | null = null;
let mode: LayoutMode = "auto";
let boardCollapsed = readBoardCollapsed();
let regionFrac = readRegionFrac();
let boardish = true; // App's default view is the board; the host syncs this
let seqCounter = 0;
let stackCounter = 0;
let hydrated = false;
const listeners = new Set<() => void>();

// useSyncExternalStore contract: same reference until something changed.
let snap: Snapshot = { wins: [], zoomedId, mode, boardCollapsed, regionFrac, boardish };

export function snapshot(): Snapshot {
  return snap;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  snap = { wins: [...wins], zoomedId, mode, boardCollapsed, regionFrac, boardish };
  saveSession();
  for (const fn of [...listeners]) fn();
}

const visible = () => wins.filter((w) => !w.minimized);

/** Zoom-mode advance: the next most-recently-focused visible card, excluding
 * EXCLUDEID — null exits the mode when nobody is left to maximize. */
function nextZoomTarget(excludeId: string): string | null {
  const rest = visible().filter((w) => w.id !== excludeId);
  if (rest.length === 0) return null;
  return rest.reduce((m, w) => (w.stack > m.stack ? w : m), rest[0]).id;
}

/** Enforce the visible-tile cap: LRU-minimize (lowest stack among visible)
 * until at most CAPACITY tiles remain. Never touches the frontmost. */
function enforceCapacity(capacity: number): void {
  const cap = Math.max(1, Math.min(capacity, MAX_VISIBLE));
  let vis = visible();
  while (vis.length > cap) {
    const lru = vis.reduce((m, w) => (w.stack < m.stack ? w : m), vis[0]);
    lru.minimized = true;
    if (zoomedId === lru.id) zoomedId = nextZoomTarget(lru.id); // mode stays, target advances
    vis = visible();
  }
}

/** Open CARD as a workspace tile (the region appears beside the board when
 * this is the first). Already open → focus + restore only (no duplicate;
 * StrictMode-safe). CAPACITY comes from the host (visibleCapacity(width)). */
export function adopt(card: Card, capacity: number = MAX_VISIBLE): void {
  const existing = wins.find((w) => w.id === card.id);
  if (existing) {
    focusInternal(existing, capacity);
    emit();
    return;
  }
  wins.push({
    id: card.id,
    card,
    seq: ++seqCounter,
    stack: ++stackCounter,
    minimized: false,
    lane: card.lane,
  });
  // sticky zoom mode: a card adopted while zoomed arrives MAXIMIZED (the
  // mode persists and the newcomer becomes its target); outside the mode the
  // newcomer just joins the tiles.
  if (zoomedId) zoomedId = card.id;
  enforceCapacity(capacity);
  emit();
}

export function close(id: string): void {
  if (!wins.some((w) => w.id === id)) return;
  if (zoomedId === id) zoomedId = nextZoomTarget(id); // mode stays, target advances
  wins = wins.filter((w) => w.id !== id);
  emit(); // wins empty ⟹ the host unmounts the region and clears the inset
}

/** Auto-close-on-done (feature: a task reaching Done closes its own tile).
 * The host feeds this the live board data on every card-data update; it
 * compares each adopted card's CURRENT lane against the last one observed
 * (WinState.lane, seeded at adopt()/hydrate() time) and closes only on an
 * observed not-done→done TRANSITION — never continuously on "is done":
 * - a card already "done" when manually opened is seeded done at adopt() ⟹
 *   this never sees a transition for it, so it stays open (spec requirement).
 * - a card temporarily absent from CARDS (snoozed/dismissed/feed hiccup) is
 *   simply skipped — absence is not a close signal, and its last-known lane
 *   is left untouched so a real transition is still caught once it reappears.
 * - the very first observation of a card is never a transition: adopt()/
 *   hydrate() always seed `lane` from that same card, so lane === live.lane
 *   the first time this runs for it.
 * Closing reuses close()'s zoom-fallback rule (nextZoomTarget) but batches
 * every close from one call into a single emit(). */
export function syncLanes(cards: readonly Card[]): void {
  const byId = new Map(cards.map((c) => [c.id, c]));
  let closedAny = false;
  for (const w of [...wins]) {
    const live = byId.get(w.id);
    if (!live) continue; // missing from the feed — not a signal
    if (w.lane !== "done" && live.lane === "done") {
      if (zoomedId === w.id) zoomedId = nextZoomTarget(w.id); // mode stays, target advances
      wins = wins.filter((x) => x.id !== w.id);
      closedAny = true;
    } else {
      w.lane = live.lane;
    }
  }
  if (closedAny) emit();
}

function focusInternal(w: WinState, capacity: number): void {
  // sticky zoom mode: the dock chips act as tabs — focusing another card
  // switches WHICH card is maximized instead of leaving the mode
  if (zoomedId && zoomedId !== w.id) zoomedId = w.id;
  w.stack = ++stackCounter;
  if (w.minimized) {
    w.minimized = false; // dock click = focus + restore
    enforceCapacity(capacity); // full house → LRU another one out
  }
}

/** Focus (and restore, if minimized) one card; dock-item click. */
export function focus(id: string, capacity: number = MAX_VISIBLE): void {
  const w = wins.find((x) => x.id === id);
  if (!w) return;
  const wasTop = zoomedId
    ? zoomedId === id && !w.minimized // in zoom mode: already the maximized tab
    : !w.minimized && w.stack === wins.reduce((m, x) => Math.max(m, x.stack), 0);
  if (wasTop) return; // already frontmost — don't churn renders
  focusInternal(w, capacity);
  emit();
}

/** Send one tile to the dock; it leaves the layout but stays mounted. */
export function minimize(id: string): void {
  const w = wins.find((x) => x.id === id);
  if (!w || w.minimized) return;
  w.minimized = true;
  if (zoomedId === id) zoomedId = nextZoomTarget(id); // mode stays, target advances
  emit();
}

/** Zoom MODE toggle: ⛶ on an unzoomed tile enters the mode (that card
 * maximized); ⛶ on the maximized tile is the ONLY explicit exit — back to
 * the tiled layout. While the mode is on, focus/adopt switch its target. */
export function toggleZoom(id: string): void {
  const w = wins.find((x) => x.id === id);
  if (!w || w.minimized) return;
  if (zoomedId === id) zoomedId = null;
  else {
    zoomedId = id;
    w.stack = ++stackCounter; // zooming is also focusing
  }
  emit();
}

/** The dock's layout chips (並排 / 四分割 / 自動) — sticky for the session. */
export function setMode(m: LayoutMode): void {
  if (mode === m) return;
  mode = m;
  emit();
}

/** Drag-arrange (slot-swap semantics, never free-floating): exchange two
 * tiles' layout slots by swapping their seq values. Slot order is exactly
 * what the session persists (ids in seq order), so an arrangement survives
 * reload. Unknown ids are a no-op. */
export function swapSlots(a: string, b: string): void {
  const wa = wins.find((w) => w.id === a);
  const wb = wins.find((w) => w.id === b);
  if (!wa || !wb || wa === wb) return;
  const t = wa.seq;
  wa.seq = wb.seq;
  wb.seq = t;
  emit();
}

/** The divider drag: FRAC clamped to a sane band; `persist:false` for the
 * live rAF updates mid-drag (localStorage stays quiet), the release calls
 * with persist on. Double-click resets via resetRegionFrac(). */
export function setRegionFrac(f: number, opts: { persist?: boolean } = {}): void {
  const { persist = true } = opts;
  const v = Math.min(Math.max(f, 0.2), 0.85);
  const changed = v !== regionFrac;
  if (changed) {
    regionFrac = v;
    emit();
  }
  if (persist) storage.set(REGION_FRAC_KEY, String(regionFrac));
}

/** Divider double-click: back to the default 60% split (persisted). */
export function resetRegionFrac(): void {
  regionFrac = REGION_FRAC_DEFAULT;
  storage.set(REGION_FRAC_KEY, String(regionFrac));
  emit();
}

/** Host-synced runtime flag — see Snapshot.boardish. Not persisted. */
export function setBoardish(v: boolean): void {
  if (boardish === v) return;
  boardish = v;
  emit();
}

/** The dock's board-collapse toggle — hide/show the board side (persisted). */
export function setBoardCollapsed(v: boolean): void {
  if (boardCollapsed === v) return;
  boardCollapsed = v;
  storage.set(BOARD_COLLAPSED_KEY, v ? "1" : "0");
  emit();
}

/** Restore the persisted session once live card objects exist (host calls
 * with the board list). Runs at most once; the region simply reappears. */
export function hydrate(cards: Card[]): void {
  if (hydrated) return;
  hydrated = true;
  const s = readSession();
  if (!s || wins.length > 0) return; // user already opened things — don't fight them
  const byId = new Map(cards.map((c) => [c.id, c]));
  const minimized = new Set(s.minimized);
  for (const id of s.ids) {
    const card = byId.get(id);
    if (!card) continue; // card left the board since — silently dropped
    wins.push({
      id,
      card,
      seq: ++seqCounter,
      stack: ++stackCounter,
      minimized: minimized.has(id),
      lane: card.lane,
    });
  }
  if (wins.length === 0) return;
  mode = s.mode === "columns" || s.mode === "grid" || s.mode === "auto" ? s.mode : "auto";
  zoomedId = s.zoomed && wins.some((w) => w.id === s.zoomed && !w.minimized) ? s.zoomed : null;
  emit();
}

/** Test-isolation helper. keepSession leaves the persisted blob in place so
 * hydration paths can be exercised. */
export function resetStore(opts: { keepSession?: boolean } = {}): void {
  wins = [];
  zoomedId = null;
  mode = "auto";
  seqCounter = 0;
  stackCounter = 0;
  hydrated = false;
  if (!opts.keepSession) memStore = {};
  boardCollapsed = readBoardCollapsed(); // preferences re-read, like a reload would
  regionFrac = readRegionFrac();
  boardish = true;
  snap = { wins: [], zoomedId, mode, boardCollapsed, regionFrac, boardish };
  for (const fn of [...listeners]) fn();
}
