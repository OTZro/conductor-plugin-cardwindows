/**
 * Pure layout math for the cardwindows WORKSPACE — no DOM, no React, node-
 * testable (cardwindows.test.ts).
 *
 * Tiling-first (UX spec 2026-08-17 + owner amendments): every rect is DERIVED
 * from the tile count and the workspace's content-area size on each render —
 * zero-sum splits, so occlusion is structurally impossible. There is no
 * cascade, no free-floating placement, no per-window slots and no persisted
 * geometry anymore (all deleted with the redesign).
 *
 * Layout policy (owner-amended):
 *   N=1  → the full content area (the workspace IS the detail view)
 *   2–3  → equal-width columns
 *   4–6  → 2-column grid (2×2 → 2×3); a lone window on the last row spans the
 *          full width (no dead cell)
 *   >6   → never laid out here: the store LRU-minimizes into the dock first
 *          (MAX_VISIBLE), so n arriving here is already capped
 * Width degradation (spec §2.3): columns whose cells would fall under MIN_W
 * degrade to the grid; a workspace too narrow for even a 2-column grid tiles
 * one card at a time (visibleCapacity → 1).
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type LayoutMode = "auto" | "columns" | "grid";

/** Gap between tiles and around the content-area edges. */
export const GAP = 8;

/** Narrowest usable card detail (CardDetail's own width clamp floor). */
export const MIN_W = 380;

/** Hard cap on simultaneously visible tiles; past it the store LRU-minimizes
 * to the dock (never stacks — spec §2.6 rule 4). */
export const MAX_VISIBLE = 6;

/** Default board/workspace split: the region takes 60% of the viewport. */
export const REGION_FRAC_DEFAULT = 0.6;

/** The board side never shrinks below this while the split is draggable. */
export const MIN_BOARD_W = 360;

/** The workspace REGION's width beside the board (owner one-view model):
 * FRAC of the viewport (the draggable divider's persisted split, default
 * 60%), clamped so the region never drops under its one-column minimum and
 * the board keeps ≥ MIN_BOARD_W whenever the viewport allows both (region
 * minimum wins when it can't). Board collapsed → the tiles take everything. */
export function regionWidth(
  viewportW: number,
  boardCollapsed: boolean,
  frac: number = REGION_FRAC_DEFAULT,
): number {
  if (boardCollapsed) return viewportW;
  const lo = MIN_W + 2 * GAP; // one full-width tile
  const hi = Math.max(viewportW - MIN_BOARD_W, lo);
  return Math.round(Math.min(Math.max(frac * viewportW, lo), hi));
}

/** How many tiles this workspace width can show at once: 6 when a 2-column
 * grid keeps cells ≥ MIN_W, else one full-width tile at a time. */
export function visibleCapacity(w: number): number {
  return (w - 3 * GAP) / 2 >= MIN_W ? MAX_VISIBLE : 1;
}

/** Resolve "auto" (and the width-degradation rule) to a concrete layout.
 * Manual "columns" also degrades when its cells would dip under MIN_W —
 * the mode chip is a preference, the readability floor is a rule. */
export function effectiveMode(n: number, mode: LayoutMode, w: number): "columns" | "grid" {
  const columnsFit = n * MIN_W + (n + 1) * GAP <= w;
  if (mode === "columns") return columnsFit ? "columns" : "grid";
  if (mode === "grid") return "grid";
  return n <= 3 && columnsFit ? "columns" : "grid";
}

const round = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/** Rects for N tiles inside a W×H content area (container-relative, origin
 * 0,0), in slot order. N=1 always fills the area regardless of mode. */
export function tileRects(n: number, w: number, h: number, mode: LayoutMode): Rect[] {
  if (n <= 0) return [];
  const iw = w - 2 * GAP; // inner area, inset by the edge gap
  const ih = h - 2 * GAP;
  if (n === 1) return [round({ x: GAP, y: GAP, w: iw, h: ih })];
  if (effectiveMode(n, mode, w) === "columns") {
    const cw = (iw - GAP * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) =>
      round({ x: GAP + i * (cw + GAP), y: GAP, w: cw, h: ih }),
    );
  }
  const rows = Math.ceil(n / 2);
  const ch = (ih - GAP * (rows - 1)) / rows;
  const halfW = (iw - GAP) / 2;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const lastLone = i === n - 1 && n % 2 === 1;
    return round({
      x: GAP + col * (halfW + GAP),
      y: GAP + row * (ch + GAP),
      w: lastLone ? iw : halfW,
      h: ch,
    });
  });
}
