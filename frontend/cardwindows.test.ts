/**
 * Pure-logic tests for the cardwindows workspace — tiling geometry and the
 * windowStore state machine (view toggle, LRU minimize, zoom, session
 * persistence). Bare-node script, kernel.test.ts harness convention:
 *
 *   cd frontend && npx tsc src/plugins/local/cardwindows/cardwindows.test.ts \
 *     --outDir /tmp/conductor-cardwindows-tests --module commonjs \
 *     --moduleResolution node --target es2020 --strict --skipLibCheck \
 *   && node /tmp/conductor-cardwindows-tests/plugins/local/cardwindows/cardwindows.test.js
 *
 * Obsolete-with-the-redesigns (deleted, not ported): drag/cascade placement,
 * per-card rect persistence, 7-slot placement, tileAll/place, the mini-board
 * rail model, and the workspace-as-separate-view state machine (one-view
 * model 2026-09-10: the region is simply present beside the board when
 * non-empty). The store persists only the open-card list + zoom/mode +
 * the two preferences, and all geometry is derived — covered below.
 */

import type { Card } from "../../../types";
import type { Rect } from "./tiling";
import {
  GAP,
  MAX_VISIBLE,
  MIN_BOARD_W,
  MIN_W,
  REGION_FRAC_DEFAULT,
  effectiveMode,
  regionWidth,
  tileRects,
  visibleCapacity,
} from "./tiling";
import * as store from "./windowStore";

// ── micro-runner ────────────────────────────────────────────────────────────

const failures: string[] = [];
let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`FAIL  ${name}: ${err}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const card = (id: string): Card =>
  ({ id, external_id: id.toUpperCase(), title: `card ${id}` }) as unknown as Card;

// a 1512×884 workspace content area (viewport minus header minus dock)
const W = 1512;
const H = 884;

const inside = (r: Rect) =>
  r.x >= GAP - 1 && r.y >= GAP - 1 && r.x + r.w <= W - GAP + 1 && r.y + r.h <= H - GAP + 1;

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const win = (id: string) => store.snapshot().wins.find((w) => w.id === id)!;
const visibleIds = () =>
  store
    .snapshot()
    .wins.filter((w) => !w.minimized)
    .map((w) => w.id)
    .sort();

// ── tiling: full-viewport geometry ──────────────────────────────────────────

test("tileRects: N=1 fills the whole content area (full-width view)", () => {
  const [r] = tileRects(1, W, H, "auto");
  assert(r.x === GAP && r.y === GAP, "starts at the edge gap");
  assert(r.w === W - 2 * GAP && r.h === H - 2 * GAP, "full width and height");
});

test("tileRects: 2–3 in auto → equal full-height columns, in slot order", () => {
  for (const n of [2, 3]) {
    const rs = tileRects(n, W, H, "auto");
    assert(rs.length === n, `${n} rects`);
    assert(rs.every(inside), "all inside the area");
    assert(
      rs.every((r, i) => i === 0 || r.x > rs[i - 1].x),
      "left-to-right slot order",
    );
    assert(Math.abs(rs[0].w - rs[n - 1].w) <= 1, "equal widths");
    assert(rs.every((r) => r.h === H - 2 * GAP), "full-height columns");
  }
});

test("tileRects: 4 in auto → 2×2 grid; 5 → 2×3 with lone last row spanning", () => {
  const four = tileRects(4, W, H, "auto");
  assert(new Set(four.map((r) => r.y)).size === 2, "4 tiles on two rows");
  assert(four.every(inside), "quadrants inside");
  const five = tileRects(5, W, H, "auto");
  assert(new Set(five.map((r) => r.y)).size === 3, "5 tiles on three rows");
  assert(five[4].w === W - 2 * GAP, "lone fifth spans the full width — no dead cell");
});

test("tileRects: zero-sum — no two tiles ever overlap (occlusion impossible)", () => {
  for (const n of [2, 3, 4, 5, 6]) {
    for (const mode of ["auto", "columns", "grid"] as const) {
      const rs = tileRects(n, W, H, mode);
      for (let i = 0; i < rs.length; i++)
        for (let j = i + 1; j < rs.length; j++)
          assert(!overlap(rs[i], rs[j]), `n=${n} mode=${mode}: tiles ${i}/${j} overlap`);
    }
  }
});

test("effectiveMode: manual columns degrades to grid when cells would dip under MIN_W", () => {
  assert(effectiveMode(3, "columns", 1512) === "columns", "3 columns fit at 1512");
  assert(effectiveMode(3, "columns", 1000) === "grid", "3×380 doesn't fit 1000 → grid");
  assert(effectiveMode(6, "columns", 1512) === "grid", "6 columns never fit → grid");
  assert(effectiveMode(4, "auto", 1512) === "grid", "auto: 4+ is grid");
  assert(effectiveMode(2, "auto", 1512) === "columns", "auto: 2 is columns");
  const rs = tileRects(3, 1000, H, "columns");
  assert(rs.every((r) => r.w >= MIN_W), "degraded layout keeps every cell ≥ MIN_W");
});

test("visibleCapacity: 6 on a real desktop, 1 when a 2-col grid can't fit", () => {
  assert(visibleCapacity(1512) === MAX_VISIBLE, "wide → 6");
  assert(visibleCapacity(700) === 1, "narrow → one full-width tile at a time");
});

// ── region geometry (one-view model) ────────────────────────────────────────

test("regionWidth: default 60% split; collapsed takes everything", () => {
  assert(regionWidth(1512, false) === Math.round(1512 * 0.6), "60% of a wide viewport");
  assert(regionWidth(1100, false) === Math.round(1100 * 0.6), "60% holds while both minimums fit");
  assert(regionWidth(1512, true) === 1512, "board collapsed → the tiles take everything");
  assert(regionWidth(1512, true, 0.3) === 1512, "collapsed ignores the divider split");
});

test("regionWidth: the draggable split (frac) is clamped by BOTH minimums", () => {
  const lo = MIN_W + 2 * GAP; // one-column minimum
  // dragging wider: the board keeps MIN_BOARD_W
  assert(regionWidth(1512, false, 0.95) === 1512 - MIN_BOARD_W, "board floor wins a wide drag");
  // dragging narrower: the region keeps its one-column minimum
  assert(regionWidth(1512, false, 0.05) === lo, "region floor wins a narrow drag");
  // a mid drag lands exactly where the divider put it
  assert(regionWidth(1512, false, 0.5) === 756, "unclamped drags are honored 1:1");
  // viewport too small for both minimums → the REGION minimum wins
  assert(regionWidth(700, false) === lo, "region 1-col minimum beats the board floor when squeezed");
});

test("region geometry: capacity follows the region's width, not the viewport's", () => {
  const beside = regionWidth(1512, false); // 907
  assert(visibleCapacity(beside) === MAX_VISIBLE, "6-up fits in the 60% region");
  assert(visibleCapacity(regionWidth(1512, true)) === MAX_VISIBLE, "and when full-width");
  assert(visibleCapacity(600) === 1, "a squeezed region tiles one at a time");
  const rs = tileRects(4, beside, 884, "auto");
  assert(rs.every((r) => r.w >= MIN_W), "grid cells ≥ MIN_W inside the region");
  assert(rs.every((r) => r.x + r.w <= beside - GAP + 1), "tiles confined to the region");
});

// ── store: view-toggle state machine ────────────────────────────────────────

test("presence: the region exists exactly while cards are open (no view machine)", () => {
  store.resetStore();
  const sAny = store.snapshot() as unknown as Record<string, unknown>;
  assert(!("view" in sAny), "the separate-view state machine is gone from the snapshot");
  assert(store.snapshot().wins.length === 0, "empty store → host renders nothing");
  store.adopt(card("a"), 6);
  store.adopt(card("b"), 6);
  assert(visibleIds().join(",") === "a,b", "both tiled beside the board");
  store.adopt(card("a"), 6); // already open → focus only, no duplicate
  assert(store.snapshot().wins.length === 2, "no duplicate tile");
  store.close("a");
  store.close("b");
  assert(store.snapshot().wins.length === 0, "closing the last card removes the region");
});

test("boardCollapsed: the dock's collapse toggle persists like a reload", () => {
  store.resetStore();
  assert(store.snapshot().boardCollapsed === false, "board shows by default");
  store.setBoardCollapsed(true);
  assert(store.snapshot().boardCollapsed === true, "toggle collapses the board side");
  store.resetStore({ keepSession: true }); // reload: runtime gone, storage kept
  assert(store.snapshot().boardCollapsed === true, "preference survives (visual home moved, semantics didn't)");
  store.setBoardCollapsed(false);
  store.resetStore({ keepSession: true });
  assert(store.snapshot().boardCollapsed === false, "and can be re-expanded");
});

test("regionFrac: divider drag updates live unpersisted; release/reset persist", () => {
  store.resetStore();
  assert(store.snapshot().regionFrac === REGION_FRAC_DEFAULT, "default 60% split");
  store.setRegionFrac(0.45, { persist: false }); // mid-drag rAF update
  assert(store.snapshot().regionFrac === 0.45, "live value drives the region width");
  store.resetStore({ keepSession: true }); // reload before releasing the drag
  assert(store.snapshot().regionFrac === REGION_FRAC_DEFAULT, "unpersisted drag does not survive");
  store.setRegionFrac(0.45, { persist: false });
  store.setRegionFrac(store.snapshot().regionFrac); // pointer-up: persist the final split
  store.resetStore({ keepSession: true });
  assert(store.snapshot().regionFrac === 0.45, "released split survives a reload");
  store.setRegionFrac(0.05);
  assert(store.snapshot().regionFrac === 0.2, "frac itself is clamped to a sane band");
  store.resetRegionFrac(); // divider double-click
  store.resetStore({ keepSession: true });
  assert(store.snapshot().regionFrac === REGION_FRAC_DEFAULT, "double-click reset persists the default");
});

test("boardish mirror: runtime-only view flag — region math follows it, never persisted", () => {
  store.resetStore();
  assert(store.snapshot().boardish === true, "defaults boardish (App starts on the board)");
  let n = 0;
  const count = () => n;
  const un = store.subscribe(() => (n += 1));
  store.setBoardish(false); // App switched to terminals / a plugin tab
  store.setBoardish(false); // idempotent
  assert(store.snapshot().boardish === false && count() === 1, "one emit per real flip");
  // the host derives: shown = wins>0 && boardish → width 0 ⟹ --ws-inset drops
  store.adopt(card("a"), 6);
  assert(store.snapshot().wins.length === 1, "cards stay in the store while hidden");
  store.setBoardish(true); // back on a boardish view (main board or Personal)
  assert(store.snapshot().boardish === true, "region reappears with its cards");
  store.resetStore({ keepSession: true });
  assert(store.snapshot().boardish === true, "runtime flag resets — not a preference");
  un();
});

test("store notifies subscribers on every transition (the host's re-render path)", () => {
  store.resetStore();
  let n = 0;
  const count = () => n;
  const un = store.subscribe(() => (n += 1));
  const before = store.snapshot();
  store.adopt(card("a"), 6);
  assert(count() === 1 && store.snapshot() !== before, "adopt emits a fresh snapshot");
  store.setBoardCollapsed(true);
  store.setBoardCollapsed(true); // idempotent — no phantom churn
  assert(count() === 2, "preference flip emits once");
  un();
});

// ── store: LRU minimize ─────────────────────────────────────────────────────

test("LRU minimize: past capacity the least-recently-focused tile docks — never >cap visible", () => {
  store.resetStore();
  for (const id of ["a", "b", "c", "d", "e", "f"]) store.adopt(card(id), 6);
  store.focus("a", 6); // a becomes most-recent; b is now LRU
  store.adopt(card("g"), 6); // 7th card
  assert(visibleIds().length === 6, "never more than capacity visible");
  assert(win("b").minimized, "the LRU tile (b) went to the dock");
  assert(!win("g").minimized && !win("a").minimized, "newcomer and recent stay tiled");
  store.adopt(card("h"), 6);
  assert(win("c").minimized, "next LRU (c) docks for the 8th");
  assert(visibleIds().length === 6, "cap still holds");
});

test("focus restores a docked card — and LRU-evicts another when the house is full", () => {
  store.resetStore();
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) store.adopt(card(id), 6);
  assert(win("a").minimized, "a was the LRU victim");
  store.focus("a", 6); // dock click
  assert(!win("a").minimized, "restored into the layout");
  assert(visibleIds().length === 6, "capacity still enforced");
  assert(win("b").minimized, "the now-LRU b traded places");
  store.minimize("a");
  assert(win("a").minimized, "explicit minimize docks it");
  assert(visibleIds().length === 5, "minimize never auto-restores others");
});

test("capacity 1 (narrow workspace): exactly one tile visible, rest in the dock", () => {
  store.resetStore();
  store.adopt(card("a"), 1);
  store.adopt(card("b"), 1);
  store.adopt(card("c"), 1);
  assert(visibleIds().join(",") === "c", "only the newest visible");
  store.focus("a", 1);
  assert(visibleIds().join(",") === "a", "dock click swaps which one shows");
});

// ── store: drag-arrange (slot swap) ─────────────────────────────────────────

test("swapSlots: swaps exactly the two tiles' layout slots, others untouched", () => {
  store.resetStore();
  for (const id of ["a", "b", "c"]) store.adopt(card(id), 6);
  const order = () =>
    [...store.snapshot().wins].sort((x, y) => x.seq - y.seq).map((w) => w.id).join(",");
  assert(order() === "a,b,c", "adoption order is slot order");
  store.swapSlots("a", "c");
  assert(order() === "c,b,a", "a and c traded slots; b kept its place");
  const snapBefore = store.snapshot();
  store.swapSlots("a", "ghost"); // unknown id
  store.swapSlots("b", "b"); // self
  assert(store.snapshot() === snapBefore, "unknown/self swaps are silent no-ops");
  // focus (stack) is untouched by a swap — arrangement ≠ recency
  const topId = [...store.snapshot().wins].sort((x, y) => y.stack - x.stack)[0].id;
  assert(topId === "c", "most-recent card unchanged by the swap");
});

test("swapSlots: the arrangement persists with the session (survives reload)", () => {
  store.resetStore();
  const cards = ["a", "b", "c"].map(card);
  for (const c of cards) store.adopt(c, 6);
  store.swapSlots("a", "c");
  store.resetStore({ keepSession: true }); // reload
  store.hydrate(cards);
  const order = [...store.snapshot().wins].sort((x, y) => x.seq - y.seq).map((w) => w.id);
  assert(order.join(",") === "c,b,a", "swapped slot order restored from the session");
});

// ── store: zoom toggle ──────────────────────────────────────────────────────

test("zoom MODE: chip-switch retargets, adopt-while-zoomed zooms the newcomer", () => {
  store.resetStore();
  store.adopt(card("a"), 6);
  store.adopt(card("b"), 6);
  store.toggleZoom("a");
  assert(store.snapshot().zoomedId === "a", "mode entered, a maximized");
  store.focus("b", 6); // dock chip acts as a tab
  assert(store.snapshot().zoomedId === "b", "mode stays — b is the maximized tab now");
  store.focus("b", 6); // clicking the active tab again
  const snapB = store.snapshot();
  store.focus("b", 6);
  assert(store.snapshot() === snapB, "re-focusing the maximized tab emits nothing");
  store.adopt(card("c"), 6); // ⧉ / direct-mode arrival while zoomed
  assert(store.snapshot().zoomedId === "c", "newcomer arrives MAXIMIZED, mode persists");
  store.adopt(card("a"), 6); // adopting an already-open card = tab switch too
  assert(store.snapshot().zoomedId === "a", "existing card becomes the maximized tab");
});

test("zoom MODE: explicit un-toggle is the only exit; minimize/close advance the target", () => {
  store.resetStore();
  for (const id of ["a", "b", "c"]) store.adopt(card(id), 6);
  store.toggleZoom("b");
  store.minimize("b"); // zoomed card docks → next most-recent visible takes over
  assert(store.snapshot().zoomedId === "c", "minimize advances to the most recent (c)");
  store.close("c"); // zoomed card closes → advance again
  assert(store.snapshot().zoomedId === "a", "close advances to the remaining visible (a)");
  store.toggleZoom("a"); // the explicit ⛶ un-toggle
  assert(store.snapshot().zoomedId === null, "un-toggle exits the mode — back to tiles");
  store.toggleZoom("a");
  store.close("a"); // only b (minimized) remains — nobody visible to maximize
  assert(store.snapshot().zoomedId === null, "no visible card left ⟹ mode exits");
  assert(store.snapshot().wins.length === 1 && win("b").minimized, "b still docked");
  const bWin = win("b");
  store.toggleZoom("b");
  assert(store.snapshot().zoomedId === null && bWin.minimized, "a docked card can't zoom");
});

// ── store: session persistence (list + zoom/mode only) ──────────────────────

test("session: open list, minimized set, zoom and mode survive a reload (hydrate)", () => {
  store.resetStore();
  const cards = ["a", "b", "c"].map(card);
  for (const c of cards) store.adopt(c, 6);
  store.minimize("b");
  store.toggleZoom("c");
  store.setMode("grid");
  // "reload": runtime state gone, storage kept
  store.resetStore({ keepSession: true });
  assert(store.snapshot().wins.length === 0, "runtime cleared");
  store.hydrate(cards);
  const s = store.snapshot();
  assert(
    [...s.wins].sort((a, b) => a.seq - b.seq).map((w) => w.id).join(",") === "a,b,c",
    "open list restored in adoption order",
  );
  assert(win("b").minimized, "minimized set restored");
  assert(s.zoomedId === "c", "zoom MODE survives the reload (c still maximized)");
  assert(s.mode === "grid", "layout mode restored");
  store.hydrate(cards);
  assert(store.snapshot().wins.length === 3, "hydrate runs at most once");
});

test("session: cards gone from the board are dropped silently; no geometry is persisted", () => {
  store.resetStore();
  store.adopt(card("a"), 6);
  store.adopt(card("gone"), 6);
  store.resetStore({ keepSession: true });
  store.hydrate([card("a")]); // "gone" no longer on the board
  assert(
    store.snapshot().wins.map((w) => w.id).join(",") === "a",
    "unknown ids dropped on restore",
  );
  // the persisted blob is the list + view state ONLY — geometry is derived
  store.resetStore({ keepSession: true });
  store.adopt(card("x"), 6);
  const raw = JSON.parse(
    (globalThis as { localStorage?: Storage }).localStorage?.getItem?.(
      "conductor.cardwindows.session",
    ) ?? "null",
  ) as Record<string, unknown> | null;
  if (raw) {
    assert(
      Object.keys(raw).sort().join(",") === "ids,minimized,mode,zoomed",
      "session blob carries no rects/geometry",
    );
  }
});

// ── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  throw new Error(`cardwindows tests failed:\n  ${failures.join("\n  ")}`);
}
