/**
 * cardwindows — LOCAL plugin (gitignored): replaces the fixed right drawer
 * with a full-screen tiled card WORKSPACE (multi-open, dock, zoom; UX spec
 * 2026-08-17 + owner amendments — mouse-only, tiling-first, no floating).
 * ZERO core edits beyond the committable kernel seams it stands on
 * ("surface.overlay" collection + baseCardSurface()).
 *
 * REGISTRATION IS MANIFEST-GATED AND ASYNC — deliberately NOT at module eval
 * (see registration.ts's incident history: eager registration ran BEFORE
 * kernel/bootstrap.ts's body and suppressed the core defaults; and it also
 * made the manager's disable toggle a no-op until a rebuild). This module's
 * import side effect only KICKS OFF the manifest fetch:
 *
 *   manifest lists "cardwindows"  → activateFromManifest() registers
 *     1. surface.card @ 100 — CardWindowAdopter (owner final simplification
 *        2026-09-11): ONE path — every desktop card click adopts into the
 *        workspace tiles (calling App's onClose() so selection + --dw margin
 *        clear) and renders null. The classic drawer remains only as the
 *        plugin-disabled fallback (manifest gate below) and on mobile.
 *     2. surface.overlay — CardWindowsOverlay: the workspace as a fixed
 *        RIGHT REGION coexisting beside the real board whenever it has
 *        cards (publishing its width app-wide via the --ws-inset CSS var),
 *        each tile wrapping the REAL core CardDetail via baseCardSurface().
 *        See CardWindows.tsx.
 *   manifest omits it (disabled/removed) or the fetch fails → ZERO
 *     registrations: the app behaves exactly as if this directory didn't
 *     exist — core drawer, no rebuild, re-enable + reload to come back.
 *
 * Late arrival is safe: App resolves cardSurface()/surfaceOverlays() on every
 * render, and any click re-renders App — the first render that needs the
 * adopter is by construction one that resolves it. getPluginManifest() is
 * cached app-wide, so this adds no extra request.
 */

import { useEffect } from "react";
import { getPluginManifest } from "../../../api";
import type { CardSurfaceProps } from "../../../kernel/seams";
import { baseCardSurface, kernel } from "../../../kernel/seams";
import { CardWindowsOverlay } from "./CardWindows";
import { activateFromManifest, adoptAndRelease } from "./registration";
import { visibleCapacity } from "./tiling";

function CardWindowAdopter(props: CardSurfaceProps) {
  const { card, onClose } = props;
  const desktop = window.matchMedia("(min-width: 640px)").matches;
  // ONE path (owner final simplification 2026-09-11): every card click on
  // desktop adopts into the workspace tiles. Adopt-and-release runs in an
  // EFFECT, never during render — releasing the selection is a setState in
  // the parent — and is idempotent under StrictMode's double effect (adopt
  // dedupes to focus; onClose re-clears null).
  useEffect(() => {
    if (!desktop) return;
    adoptAndRelease(card, visibleCapacity(window.innerWidth), onClose);
    // card.id, not card: the same card's object identity changes on every board
    // poll, and re-adopting on each poll would re-front the card unasked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, desktop]);
  if (desktop) return null;
  // mobile: the core drawer — the workspace has no usable surface there.
  // Guaranteed not to be ourselves: registration.ts refuses to register
  // unless a priority-0 base exists.
  const Base = baseCardSurface();
  return <Base {...props} />;
}

// Import side effect: start the manifest-gated activation. Runs well after
// bootstrap registered the core defaults (fetch resolution is always after
// every module body). activateFromManifest is idempotent, so an HMR re-eval
// of this module re-running the fetch registers nothing twice. A manifest
// error deliberately stays inactive — a broken backend must degrade to the
// core drawer, not to a surface that half-works.
getPluginManifest()
  .then((manifests) => {
    activateFromManifest(kernel, manifests, {
      adopter: CardWindowAdopter,
      overlay: CardWindowsOverlay,
    });
  })
  .catch(() => {
    /* manifest unavailable → behave as plugin-absent */
  });
