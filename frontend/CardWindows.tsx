/**
 * The cardwindows workspace host — a "surface.overlay" collection item
 * (always mounted by App; renders null with zero open cards).
 *
 * ONE-VIEW model (owner clarification 2026-09-10): the workspace is a fixed
 * RIGHT REGION that coexists beside the app's REAL board whenever it has
 * cards — not a separate view. The former rail/chip/返回看板 machinery is
 * deleted; the original Board stays rendered and fully interactive on the
 * left, shrunk via the --ws-inset mechanism below.
 *
 * - INSET: App's content margin is `calc(var(--dw) + var(--ws-inset, 0px))`
 *   (one-line core hook, documented in App.tsx). This host PUBLISHES the
 *   region's width by setting --ws-inset on <html> (an effect; cleared when
 *   the region empties or unmounts), so the app — board, terminals, any main
 *   view — cedes exactly the region's width, the same way the drawer cedes
 *   --dw. No kernel service needed: a CSS variable is already a reactive,
 *   zero-provider-default seam.
 * - REGION WIDTH: regionWidth() — 60% of the viewport (never under the
 *   2-column-grid minimum); the dock's far-left ◧/◨ toggle collapses the
 *   BOARD side (persisted), handing the tiles the full width.
 * - VIEW COEXISTENCE (owner rule 2026-09-11): the region renders ONLY on
 *   boardish views (main board + custom dashboards — App's `boardish` prop),
 *   squeezing whichever board is shown. On terminals/plugin tabs it hides
 *   entirely (visibility, not unmount — terminal buffers in tiles survive)
 *   and the inset drops to 0. Cards stay in the store; the region reappears
 *   on the next boardish view. The flag is mirrored into the store so the
 *   adopter can fall back to the drawer on non-board views.
 * - TILES/DOCK/ZOOM: unchanged from the workspace build — derived zero-sum
 *   layout (1 full / 2–3 columns / 4–6 grid / LRU-minimize past capacity),
 *   bottom dock (open-card chips, entry-mode toggle, layout presets), ⛶
 *   zoom. Minimized tiles stay mounted (hidden) so terminal buffers survive.
 *
 * - COMPACT HEADER: every TILED card hides CardDetail's own header block by
 *   default (the core `compactHeader` prop, see kernel/seams.ts) — the tile
 *   title bar carries a ball dot + agent_state tag, and a CHEVRON on the
 *   title bar toggles the REAL header block inline below it (its own
 *   Done/Snooze/Pin/Dismiss/group buttons — no re-implemented menu).
 *   Zoomed (maximized) view always shows the full header.
 * - DRAG-ARRANGE: dragging a tile by its title bar and dropping on another
 *   tile SWAPS their layout slots (store.swapSlots — slot semantics, never
 *   free-floating; the hovered drop slot shows an amber ring; order persists
 *   with the session). Disabled while zoom mode is on.
 *
 * Z-LAYERING (documented decision): the region sits at z-40 — UNDER the
 * drawer (50, the plugin-disabled/mobile fallback surface), header popovers
 * (55), fullscreen terminal (60) and modals (70) — every modal outranks the
 * tiles. Tile-internal z (CardDetail's 50/60) stays inside each
 * tile's stacking context via the transform containing-block.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OverlaySurfaceProps } from "../../../kernel/seams";
import { baseCardSurface } from "../../../kernel/seams";
import type { Card } from "../../../types";
import type { Rect } from "./tiling";
import { GAP, regionWidth, tileRects, visibleCapacity } from "./tiling";
import type { WinState } from "./windowStore";
import * as store from "./windowStore";

/** Same measurement CardDetail itself does — the app header band height. */
function useHeaderH(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const measure = () =>
      setH(document.querySelector("header")?.getBoundingClientRect().height ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return h;
}

function useViewportW(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

const ballDotCls = (ball: string) =>
  ball === "human" ? "bg-amber-400" : ball === "ai" ? "bg-sky-400" : "bg-zinc-500";

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function CardWindowsOverlay({ cards, onOpenCard, onChanged, boardish }: OverlaySurfaceProps) {
  const { wins, zoomedId, mode, boardCollapsed, regionFrac } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  );
  const headerH = useHeaderH();
  const viewportW = useViewportW();

  // mirror App's boardish flag into the store (runtime only) — region math
  // and any future entry decisions read one source of truth
  useEffect(() => {
    store.setBoardish(boardish);
  }, [boardish]);

  // restore the persisted session once the board list is available (runs at
  // most once — hydrate() guards internally; the region just reappears)
  useEffect(() => {
    if (cards.length > 0) store.hydrate(cards);
  }, [cards]);

  const present = wins.length > 0;
  const shown = present && boardish; // view-coexistence: hide off-board
  const width = shown ? regionWidth(viewportW, boardCollapsed, regionFrac) : 0;

  // publish the region's width as the app-wide right inset (see module doc).
  // An effect, not render output: it mutates <html> style, and must clear
  // itself when the region empties or this host unmounts.
  useEffect(() => {
    const root = document.documentElement;
    if (width > 0) root.style.setProperty("--ws-inset", `${width}px`);
    else root.style.removeProperty("--ws-inset");
    return () => {
      root.style.removeProperty("--ws-inset");
    };
  }, [width]);

  // measure the tiles area (region minus dock) for derived rects
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [present]);

  // divider drag (board/workspace split): live updates are rAF-throttled and
  // UNPERSISTED (setRegionFrac persist:false); release persists. Double-click
  // resets to the default split. The ◧ dock toggle is unaffected.
  const dividerRaf = useRef(0);
  const dividerDragging = useRef(false);
  const onDividerDown = (e: React.PointerEvent) => {
    dividerDragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dividerDragging.current) return;
    const x = e.clientX;
    if (dividerRaf.current) return; // one update per frame
    dividerRaf.current = requestAnimationFrame(() => {
      dividerRaf.current = 0;
      store.setRegionFrac((window.innerWidth - x) / window.innerWidth, { persist: false });
    });
  };
  const onDividerUp = () => {
    if (!dividerDragging.current) return;
    dividerDragging.current = false;
    if (dividerRaf.current) {
      cancelAnimationFrame(dividerRaf.current);
      dividerRaf.current = 0;
    }
    store.setRegionFrac(store.snapshot().regionFrac); // persist the final split
  };

  // drag-arrange state — REGRESSION NOTE (2026-09-12, React #310 in prod):
  // these two hooks were first added BELOW the `if (!present) return null`
  // early return. An empty workspace rendered fewer hooks than the render
  // right after the first card was adopted, and React crashed at root on
  // card open ("Rendered more hooks than during the previous render").
  // EVERY hook in this component must stay above that early return.
  const dragRef = useRef<{ id: string; sx: number; sy: number; active: boolean; over: string | null } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);

  if (!present) return null;

  const bySeq = [...wins].sort((a, b) => a.seq - b.seq);
  const tiled = bySeq.filter((w) => !w.minimized);
  const rects = tileRects(tiled.length, area.w, area.h, mode);
  const rectOf = new Map<string, Rect>(tiled.map((w, i) => [w.id, rects[i]]));
  const zoomRect: Rect = { x: GAP, y: GAP, w: area.w - 2 * GAP, h: area.h - 2 * GAP };
  const topStack = tiled.reduce((m, w) => Math.max(m, w.stack), 0);
  const activeId = zoomedId ?? tiled.find((w) => w.stack === topStack)?.id ?? null;
  const capacity = visibleCapacity(area.w || width);
  const liveCard = (w: WinState): Card => cards.find((c) => c.id === w.id) ?? w.card;

  // ── drag-arrange (slot swap) ── title-bar drag with a 6px threshold so the
  // bar's buttons still click; hit-testing runs against the derived rects, so
  // the drop target is exactly the hovered slot. Zoom mode disables it (one
  // maximized tile has no slots to swap). The dragRef/drag HOOKS live above
  // the early return with every other hook — see the regression note there.
  const canDrag = !zoomedId;
  const onTileDragStart = (e: React.PointerEvent, id: string) => {
    if (!canDrag) return;
    if ((e.target as HTMLElement).closest("button,input,a")) return; // buttons stay buttons
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, active: false, over: null };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTileDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      d.active = true;
    }
    const a = areaRef.current?.getBoundingClientRect();
    let over: string | null = null;
    if (a) {
      const px = e.clientX - a.left;
      const py = e.clientY - a.top;
      for (const [id, r] of rectOf) {
        if (id !== d.id && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
          over = id;
          break;
        }
      }
    }
    d.over = over;
    setDrag({ id: d.id, over });
  };
  const onTileDragEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.active && d.over) store.swapSlots(d.id, d.over);
    setDrag(null);
  };

  return (
    <div
      className={`fixed right-0 bottom-0 z-40 flex flex-col bg-zinc-950 border-l border-zinc-800 ${
        shown ? "" : "invisible pointer-events-none"
      }`}
      style={{ top: headerH, width: shown ? width : regionWidth(viewportW, boardCollapsed, regionFrac) }}
      aria-hidden={!shown}
    >
      {!boardCollapsed && (
        /* board/workspace divider — drag to resize the split (min board 360px,
           min region = one column); double-click restores the 60% default */
        <div
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          onDoubleClick={() => store.resetRegionFrac()}
          className="absolute left-0 inset-y-0 w-1.5 -translate-x-1/2 z-20 cursor-ew-resize touch-none hover:bg-sky-500/40 active:bg-sky-500/60"
          title="拖曳調整看板/工作區比例(雙擊還原 60%)"
        />
      )}
      <div ref={areaRef} className="relative flex-1 min-h-0">
        {bySeq.map((w) => {
          const zoomed = zoomedId === w.id;
          const rect = zoomed ? zoomRect : rectOf.get(w.id);
          const hidden = w.minimized || !rect;
          return (
            <Tile
              key={w.id}
              win={w}
              card={liveCard(w)}
              allCards={cards}
              rect={rect ?? zoomRect}
              hidden={hidden}
              zoomed={zoomed}
              active={w.id === activeId}
              headerH={headerH}
              onOpenCard={onOpenCard}
              onChanged={onChanged}
              canDrag={canDrag}
              dragSource={drag?.id === w.id}
              dropTarget={drag?.over === w.id}
              onDragStart={onTileDragStart}
              onDragMove={onTileDragMove}
              onDragEnd={onTileDragEnd}
            />
          );
        })}
      </div>
      {/* dock */}
      <div className="shrink-0 h-11 px-2 flex items-center gap-2 border-t border-zinc-800 bg-zinc-900/90">
        {/* board-collapse toggle — compact, lives with the workspace controls
            (owner 2026-09-11: no mid-boundary floating chevron) */}
        <button
          onClick={() => store.setBoardCollapsed(!boardCollapsed)}
          className={`shrink-0 px-1.5 py-1 rounded text-sm leading-none border ${
            boardCollapsed
              ? "bg-sky-600/30 border-sky-500/50 text-sky-200"
              : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200"
          }`}
          title={boardCollapsed ? "展開看板" : "收合看板(工作區全寬)"}
          aria-label={boardCollapsed ? "Show board" : "Collapse board"}
        >
          {boardCollapsed ? "◨" : "◧"}
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          {bySeq.map((w) => {
            const c = liveCard(w);
            const pulsing = ((c.cached?.rhapsody_activity as unknown[]) || []).length > 0;
            return (
              <span
                key={w.id}
                className={`group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded cursor-pointer border text-xs shrink-0 ${
                  w.id === activeId && !w.minimized
                    ? "bg-zinc-700/80 border-sky-500/50 text-zinc-100"
                    : "bg-zinc-800/70 border-zinc-700 text-zinc-300 hover:bg-zinc-700/60"
                } ${w.minimized ? "opacity-40 hover:opacity-80" : ""}`}
                onClick={() => store.focus(w.id, capacity)}
                onAuxClick={(e) => {
                  if (e.button === 1) store.close(w.id); // middle-click = close
                }}
                title={`${c.external_id} ${c.title}${w.minimized ? "(已縮小)" : ""}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${ballDotCls(c.ball)} ${pulsing ? "animate-pulse" : ""}`}
                />
                <span className="font-mono text-[10px] text-zinc-400">{c.external_id}</span>
                <span className="max-w-[9rem] truncate">{truncate(c.title, 18)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    store.close(w.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 px-0.5 rounded text-zinc-400 hover:text-zinc-100"
                  title="關閉"
                  aria-label={`Close ${c.external_id}`}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {(
            [
              ["columns", "並排"],
              ["grid", "四分割"],
              ["auto", "自動"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => store.setMode(m)}
              className={`px-2 py-1 rounded text-[11px] border ${
                mode === m
                  ? "bg-sky-600/30 border-sky-500/50 text-sky-200"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
              title={m === "auto" ? "依張數自動排版" : label}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({
  win,
  card,
  allCards,
  rect,
  hidden,
  zoomed,
  active,
  headerH,
  onOpenCard,
  onChanged,
  canDrag,
  dragSource,
  dropTarget,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  win: WinState;
  card: Card;
  allCards: Card[];
  rect: Rect;
  hidden: boolean;
  zoomed: boolean;
  active: boolean;
  headerH: number;
  onOpenCard: (id: string) => void;
  onChanged: () => void;
  canDrag: boolean;
  dragSource: boolean;
  dropTarget: boolean;
  onDragStart: (e: React.PointerEvent, id: string) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: () => void;
}) {
  const BaseDetail = baseCardSurface(); // the priority-0 core drawer component
  // TILED cards fold the card's own header away by DEFAULT — beside the tile
  // title bar it is redundancy (owner 2026-09-12; the old height threshold
  // missed big monitors). The title-bar chevron expands the REAL header block
  // inline below (its own action buttons — nothing re-implemented); the
  // zoomed (maximized single) view always shows it.
  const [headerOpen, setHeaderOpen] = useState(false);
  const compact = !zoomed && !headerOpen;
  return (
    <div
      className={`absolute flex flex-col rounded-lg border overflow-hidden bg-surface-raised ${
        dropTarget
          ? "border-amber-400/80 ring-2 ring-amber-400/50" // drop indicator (slot swap)
          : active
            ? "border-sky-500/60 ring-1 ring-sky-500/30"
            : "border-zinc-700"
      } ${dragSource ? "opacity-70" : ""}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: zoomed ? 2 : 1,
        ...(hidden ? { visibility: "hidden" as const, pointerEvents: "none" as const } : {}),
      }}
      onPointerDownCapture={() => {
        if (!active) store.focus(win.id);
      }}
    >
      {/* title bar — drag it to SWAP slots with the tile you drop on */}
      <div
        className={`flex items-center gap-2 pl-3 pr-1.5 py-1 border-b border-zinc-800 bg-zinc-900/80 shrink-0 select-none touch-none ${
          canDrag ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        onPointerDown={(e) => onDragStart(e, win.id)}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <span className="font-mono text-[11px] text-zinc-400 shrink-0">{card.external_id}</span>
        <span className="text-xs text-zinc-200 truncate flex-1">{card.title}</span>
        {compact && (
          <>
            {/* header hidden — its essentials ride here: ball dot + state tag */}
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${ballDotCls(card.ball)}`}
              title={`ball: ${card.ball}`}
            />
            {card.agent_state && (
              <span className="shrink-0 max-w-[7rem] truncate text-[10px] text-zinc-500" title={card.agent_state}>
                {card.agent_state}
              </span>
            )}
          </>
        )}
        {!zoomed && (
          /* chevron: expand/collapse the card's REAL header block inline */
          <button
            onClick={() => setHeaderOpen((v) => !v)}
            className={`shrink-0 px-1.5 py-0.5 rounded hover:bg-zinc-700/60 ${
              headerOpen ? "text-sky-300" : "text-zinc-400 hover:text-zinc-100"
            }`}
            title={headerOpen ? "收合卡片標頭" : "展開卡片標頭(Done/Snooze/Pin…)"}
            aria-label={headerOpen ? "Collapse card header" : "Expand card header"}
          >
            {headerOpen ? "▴" : "▾"}
          </button>
        )}
        <button
          onClick={() => store.toggleZoom(win.id)}
          className={`shrink-0 px-1.5 py-0.5 rounded hover:bg-zinc-700/60 ${
            zoomed ? "text-sky-300" : "text-zinc-400 hover:text-zinc-100"
          }`}
          title={zoomed ? "還原排列" : "放大(暫時撐滿工作區)"}
          aria-label={zoomed ? "Restore tile" : "Zoom tile"}
        >
          ⛶
        </button>
        <button
          onClick={() => store.minimize(win.id)}
          className="shrink-0 px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60"
          title="縮到 Dock"
          aria-label="Minimize to dock"
        >
          –
        </button>
        <button
          onClick={() => store.close(win.id)}
          className="shrink-0 px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60"
          title="關閉"
          aria-label="Close tile"
        >
          ✕
        </button>
      </div>
      {/* content: clip + transformed host — CardDetail's fixed drawer lays out
          against the tile; -headerH cancels its own header offset */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          // [transform:translateZ(0)] (class, not inline style, so the has-
          // variant below can override it): the containing block that makes
          // CardDetail's fixed drawer lay out against the tile. While a
          // terminal inside is MAXIMIZED (data-term-maximized), the transform
          // drops → TerminalView's `fixed inset-x-0 top-0 z-[60]` resolves to
          // the real viewport again, so its toolbar row (paste image, ⤡ exit)
          // is visible instead of being pushed into the tile's clipped -headerH
          // band. CSS-only flip — nothing reparents, the iframe never remounts.
          className="absolute inset-x-0 bottom-0 [transform:translateZ(0)] has-[[data-term-maximized]]:[transform:none]"
          style={{ top: -headerH }}
        >
          <BaseDetail
            card={card}
            allCards={allCards}
            width={rect.w}
            compactHeader={compact}
            onResize={() => {
              /* tiles are laid out by the workspace; the drawer's edge-drag is inert here */
            }}
            onClose={() => store.close(win.id)}
            onOpenCard={onOpenCard}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  );
}
