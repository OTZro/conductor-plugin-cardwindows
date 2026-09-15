/**
 * cardwindows registration/wiring — PURE logic (no React, no DOM), split out of
 * index.tsx so the activation rules are node-testable (registration.test.ts).
 *
 * INCIDENT HISTORY (2026-09-09, why this module exists): v1 registered its
 * kernel providers at module-eval time. The plugins/registry glob evaluates
 * plugin packages DURING kernel/bootstrap.ts's import phase — i.e. BEFORE
 * bootstrap's body — so the adopter landed in an empty registry and
 * bootstrap's then-emptiness idempotence guard skipped registering the core
 * CardDetail/TerminalView entirely. Result: no drawer (the adopter renders
 * null) and getBase() resolving the ADOPTER itself, so every window hosted
 * the adopter, whose onClose inside a window is store.close → windows
 * self-closed in the same effect flush. Clicking a card did nothing.
 *
 * The rules that prevent every limb of that failure:
 * 1. MANIFEST GATE — activateFromManifest() only registers after the backend
 *    manifest lists "cardwindows". Disabled in the manager ⟹ absent from the
 *    manifest (a disabled module is never imported) ⟹ ZERO registrations ⟹
 *    behaves exactly like plugin-absent — core drawer, no rebuild needed.
 *    The gate is async by nature, so registration always happens long after
 *    bootstrap ran; late arrival is safe because App resolves cardSurface()/
 *    surfaceOverlays() on EVERY render — the click that needs the adopter
 *    re-renders App and resolves both in that same render. Until then (or on
 *    manifest failure) the core drawer serves clicks normally.
 * 2. BASE-EXISTS REFUSAL — registerCardWindows() refuses to register unless a
 *    priority-0 surface.card provider exists. Even if someone reverts to
 *    eager registration, the plugin can only ever WRAP a real core default,
 *    never replace-and-host itself.
 * 3. IDEMPOTENCE — a second activation (HMR re-eval, a re-fetched manifest)
 *    registers nothing twice.
 */

import type { Kernel } from "../../../kernel/kernel";
import type { CardSurfaceComponent, OverlaySurfaceComponent } from "../../../kernel/seams";
import { SURFACE_CARD, SURFACE_OVERLAY } from "../../../kernel/seams";
import type { CompositeEffect } from "../../../kernel/kernel";
import type { Card } from "../../../types";
import * as store from "./windowStore";

/** The priority the adopter claims — above core's 0, below nothing else known. */
export const ADOPTER_PRIORITY = 100;

export const PLUGIN_ID = "cardwindows";

/** Manifest gate: the backend lists only LOADED plugins (a disabled module is
 * never imported), so presence here IS the enabled bit. */
export function pluginEnabled(manifests: Array<{ id: string }>): boolean {
  return manifests.some((m) => m.id === PLUGIN_ID);
}

// Entry decision (owner final simplification 2026-09-11): while the plugin
// is enabled there is ONE path — every card click adopts into the tiles (the
// former dual-mode preference and the ⧉ drawer hand-off are deleted). The
// classic drawer exists only as the plugin-disabled fallback (manifest gate)
// and on mobile, where the workspace has no surface.

/** The adopter's whole behavior, extracted for pure-logic testing: file the
 * card into the workspace (jumping the view there), then release the given
 * selection/host. CAPACITY is the workspace's visible-tile cap (host computes
 * visibleCapacity(width)); past it the store LRU-minimizes into the dock.
 * Dedupe lives in adopt() (an already-open card is focused/restored), so this
 * is idempotent under StrictMode's double effect. */
export function adoptAndRelease(card: Card, capacity: number, release: () => void): void {
  store.adopt(card, capacity);
  release();
}

// structural slice of Kernel so tests can pass a private instance; the app
// passes the shared kernel from seams.ts
type KernelLike = Pick<Kernel, "services" | "collections" | "scope">;

/** Register the two providers (adopter + overlay) as one disposable scope.
 * Returns null — registering NOTHING — when refusing (no priority-0 base to
 * wrap: rule 2) or when already registered (rule 3). */
export function registerCardWindows(
  k: KernelLike,
  comps: { adopter: CardSurfaceComponent; overlay: OverlaySurfaceComponent },
): CompositeEffect | null {
  const rows = k.services.providers(SURFACE_CARD);
  if (rows.some((p) => p.priority === ADOPTER_PRIORITY)) return null; // already active
  if (!rows.some((p) => p.priority === 0)) {
    // no core default to wrap — registering would make the adopter its own
    // base (the incident's failure shape). Refuse loudly; the app keeps
    // whatever surface it has.
    console.warn("[cardwindows] no priority-0 surface.card base — refusing to register");
    return null;
  }
  const scope = k.scope();
  scope.add(k.services.register<CardSurfaceComponent>(SURFACE_CARD, comps.adopter, {
    priority: ADOPTER_PRIORITY,
  }));
  scope.add(k.collections.add<OverlaySurfaceComponent>(SURFACE_OVERLAY, comps.overlay));
  return scope;
}

/** The one entry point index.tsx calls once the manifest resolves. Disabled ⟹
 * null and an untouched kernel — indistinguishable from plugin-absent. */
export function activateFromManifest(
  k: KernelLike,
  manifests: Array<{ id: string }>,
  comps: { adopter: CardSurfaceComponent; overlay: OverlaySurfaceComponent },
): CompositeEffect | null {
  if (!pluginEnabled(manifests)) return null;
  return registerCardWindows(k, comps);
}
