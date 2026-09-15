/**
 * Pure-logic tests for cardwindows WIRING — the adopt → release → overlay-
 * visible flow driven through the real Kernel + the store subscription, plus
 * the manifest gate. Bare-node script, kernel.test.ts harness convention:
 *
 *   cd frontend && npx tsc src/plugins/local/cardwindows/registration.test.ts \
 *     --outDir /tmp/conductor-cardwindows-tests --module commonjs \
 *     --moduleResolution node --target es2020 --strict --skipLibCheck \
 *   && node /tmp/conductor-cardwindows-tests/plugins/local/cardwindows/registration.test.js
 *
 * THE REGRESSION PROOF: `assertClickFlowHealthy` encodes what a click must
 * produce (selection released, overlay notified via the store subscription,
 * window content = the CORE base, exactly one window left visible). Run
 * against a kernel wired the way v1 shipped (plugin registered at module
 * eval, before bootstrap's emptiness-guarded body) it THROWS — the incident,
 * reproduced deterministically. Run against the fixed wiring it passes.
 */

import { Kernel } from "../../../kernel/kernel";
import type { CardSurfaceComponent, OverlaySurfaceComponent } from "../../../kernel/seams";
import { SURFACE_CARD, SURFACE_OVERLAY } from "../../../kernel/seams";
import type { Card } from "../../../types";
import {
  ADOPTER_PRIORITY,
  activateFromManifest,
  adoptAndRelease,
  pluginEnabled,
  registerCardWindows,
} from "./registration";
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

// ── stand-ins (module-order simulation needs values, not React trees) ───────

const ADOPTER = { name: "cardwindows adopter" } as unknown as CardSurfaceComponent;
const OVERLAY = { name: "cardwindows overlay" } as unknown as OverlaySurfaceComponent;
const CORE_DETAIL = { name: "core CardDetail drawer" } as unknown as CardSurfaceComponent;
const COMPS = { adopter: ADOPTER, overlay: OVERLAY };

const CAPACITY = 6; // what the host would pass (visibleCapacity(width))
const card = (id: string): Card =>
  ({ id, external_id: id.toUpperCase(), title: `card ${id}` }) as unknown as Card;

/** bootstrap.ts's body (fixed guard semantics: keyed on the priority-0 row). */
function runBootstrapBody(k: Kernel): void {
  if (!k.services.providers(SURFACE_CARD).some((p) => p.priority === 0))
    k.services.register(SURFACE_CARD, CORE_DETAIL, { priority: 0 });
}

/** v1's module-eval order, verbatim: the plugin package registers during the
 * plugins/registry import — BEFORE bootstrap's body — and bootstrap's OLD
 * guard was `providers(...).length === 0`. */
function wireOldShippedOrder(k: Kernel): void {
  k.services.register(SURFACE_CARD, ADOPTER, { priority: ADOPTER_PRIORITY });
  k.collections.add(SURFACE_OVERLAY, OVERLAY);
  if (k.services.providers(SURFACE_CARD).length === 0)
    k.services.register(SURFACE_CARD, CORE_DETAIL, { priority: 0 });
}

/** One click, end to end, through the store subscription — mirroring each
 * component's real behavior by provider identity:
 * - App renders the ACTIVE surface.card provider; the adopter's effect is
 *   adoptAndRelease(card, vp, App.onClose).
 * - The overlay learns of windows ONLY via store.subscribe.
 * - Each workspace tile hosts the BASE provider (getBase); hosting the
 *   ADOPTER means its effect runs again with the TILE's onClose —
 *   store.close(id). */
function simulateClickFlow(k: Kernel, c: Card) {
  let selection: string | null = c.id;
  let overlayNotified = false;
  const un = store.subscribe(() => {
    overlayNotified = true;
  });
  const active = k.services.get<CardSurfaceComponent>(SURFACE_CARD);
  // ONE path (index.tsx): the enabled adopter always adopts on desktop;
  // resolving the CORE component instead means the plugin is absent/disabled
  // and the click gets the classic drawer.
  let renderedDrawer = false;
  if (active === ADOPTER) adoptAndRelease(c, CAPACITY, () => (selection = null));
  else renderedDrawer = true;
  const base = k.services.getBase<CardSurfaceComponent>(SURFACE_CARD);
  for (const w of [...store.snapshot().wins]) {
    if (base === ADOPTER) adoptAndRelease(w.card as Card, CAPACITY, () => store.close(w.id));
  }
  un();
  return {
    selection,
    overlayNotified,
    base,
    renderedDrawer,
    winsAfter: store.snapshot().wins.length,
  };
}

/** What a healthy click MUST produce — the assertion set that fails on v1
 * wiring. */
function assertClickFlowHealthy(k: Kernel): void {
  const r = simulateClickFlow(k, card("a"));
  assert(r.selection === null, "adopter released the selection (drawer margin clears)");
  assert(r.overlayNotified, "store subscription notified the overlay");
  assert(r.base !== ADOPTER, `window hosts the CORE base, not the adopter`);
  assert(r.base === CORE_DETAIL, "base resolves to the core drawer component");
  assert(r.winsAfter === 1, `exactly one tile open after the flow, got ${r.winsAfter}`);
}

// ── the incident, reproduced (proves the flow test fails on v1 wiring) ──────

test("v1 shipped wiring: core defaults suppressed; click flow FAILS (incident reproduced)", () => {
  store.resetStore();
  const k = new Kernel();
  wireOldShippedOrder(k);
  assert(
    !k.services.providers(SURFACE_CARD).some((p) => p.priority === 0),
    "old emptiness guard skipped the core registration",
  );
  const r = simulateClickFlow(k, card("a"));
  assert(r.base === ADOPTER, "getBase resolves the adopter ITSELF — nothing else registered");
  assert(r.winsAfter === 0, "hosted adopter self-closed the tile in the same flush");
  assert(r.selection === null && r.overlayNotified, "…while looking half-alive: click did nothing visible");
  // and the healthy-flow contract throws on this kernel — the regression proof
  store.resetStore();
  let thrown: unknown = null;
  try {
    assertClickFlowHealthy(k);
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error, "assertClickFlowHealthy must FAIL against v1 wiring");
  console.log(`      ↳ reproduced v1 failure: ${(thrown as Error).message}`);
});

// ── the fixed wiring ────────────────────────────────────────────────────────

test("fixed wiring: bootstrap first, manifest-gated activation → click flow healthy", () => {
  store.resetStore();
  const k = new Kernel();
  runBootstrapBody(k); // fixed order/guard: core registered before activation
  const scope = activateFromManifest(k, [{ id: "officraft" }, { id: "cardwindows" }], COMPS);
  assert(scope !== null, "manifest lists cardwindows → activated");
  assert(k.services.get(SURFACE_CARD) === ADOPTER, "adopter is the active surface");
  assert(k.collections.all(SURFACE_OVERLAY)[0] === OVERLAY, "overlay contributed");
  assertClickFlowHealthy(k);
  // unload restores the drawer
  scope!.dispose();
  assert(k.services.get(SURFACE_CARD) === CORE_DETAIL, "dispose restores the core drawer");
  assert(k.collections.all(SURFACE_OVERLAY).length === 0, "overlay withdrawn");
});

test("fixed guard semantics: even v1's eval order can no longer suppress the core", () => {
  store.resetStore();
  const k = new Kernel();
  // plugin somehow registers first (eager-registration regression) …
  registerCardWindowsUnsafe(k); // helper below: what an eager v1 would do
  // … bootstrap's FIXED body still registers the core:
  runBootstrapBody(k);
  assert(k.services.getBase(SURFACE_CARD) === CORE_DETAIL, "core base present despite plugin-first order");
});
// (only used above — v1's unconditional registration, minus its own guards)
function registerCardWindowsUnsafe(k: Kernel): void {
  k.services.register(SURFACE_CARD, ADOPTER, { priority: ADOPTER_PRIORITY });
  k.collections.add(SURFACE_OVERLAY, OVERLAY);
}

// ── the manifest gate ───────────────────────────────────────────────────────

test("manifest gate: disabled ⟹ exactly plugin-absent (zero registrations, no rebuild)", () => {
  store.resetStore();
  const k = new Kernel();
  runBootstrapBody(k);
  assert(!pluginEnabled([{ id: "officraft" }, { id: "sandboxnet" }]), "absent id → disabled");
  const scope = activateFromManifest(k, [{ id: "officraft" }], COMPS);
  assert(scope === null, "no activation");
  assert(k.services.get(SURFACE_CARD) === CORE_DETAIL, "core drawer is the active surface");
  assert(k.services.providers(SURFACE_CARD).length === 1, "no adopter row at all");
  assert(k.collections.all(SURFACE_OVERLAY).length === 0, "no overlay row at all");
});

test("late arrival: clicks before activation get the drawer; after, the adopter — idempotently", () => {
  store.resetStore();
  const k = new Kernel();
  runBootstrapBody(k);
  // click BEFORE the manifest resolves: the drawer serves it
  assert(k.services.get(SURFACE_CARD) === CORE_DETAIL, "pre-activation click → core drawer");
  const first = activateFromManifest(k, [{ id: "cardwindows" }], COMPS);
  assert(first !== null, "activation succeeds after manifest resolves");
  assert(k.services.get(SURFACE_CARD) === ADOPTER, "post-activation click → adopter");
  const again = activateFromManifest(k, [{ id: "cardwindows" }], COMPS);
  assert(again === null, "re-activation (HMR re-eval / manifest refetch) registers nothing twice");
  assert(
    k.services.providers(SURFACE_CARD).filter((p) => p.priority === ADOPTER_PRIORITY).length === 1,
    "exactly one adopter row",
  );
});

test("refusal: no priority-0 base ⟹ refuse to register (can never self-host)", () => {
  store.resetStore();
  const k = new Kernel(); // bootstrap has NOT run
  const scope = registerCardWindows(k, COMPS);
  assert(scope === null, "registration refused without a core base to wrap");
  assert(k.services.providers(SURFACE_CARD).length === 0, "registry untouched");
  assert(k.collections.all(SURFACE_OVERLAY).length === 0, "collection untouched");
});

// ── one-path entry (owner final simplification 2026-09-11) ──────────────────

test("enabled ⟹ every card click adopts into the tiles — no drawer, no preference", () => {
  store.resetStore();
  const sAny = store.snapshot() as unknown as Record<string, unknown>;
  assert(!("direct" in sAny), "the dual-mode preference is gone from the store");
  const k = new Kernel();
  runBootstrapBody(k);
  activateFromManifest(k, [{ id: "cardwindows" }], COMPS);
  const r = simulateClickFlow(k, card("a"));
  assert(!r.renderedDrawer && r.winsAfter === 1, "click adopted, no drawer");
  assert(r.selection === null, "selection released — the region holds the card");
  // same store serves every boardish surface (main board, Personal dashboard):
  const r2 = simulateClickFlow(k, card("b"));
  assert(r2.winsAfter === 2, "a Personal-dashboard click lands in the SAME workspace");
});

test("disabled ⟹ the classic drawer is the natural fallback (manifest gate pins it)", () => {
  store.resetStore();
  const k = new Kernel();
  runBootstrapBody(k);
  activateFromManifest(k, [{ id: "officraft" }], COMPS); // cardwindows absent
  const r = simulateClickFlow(k, card("a"));
  assert(r.renderedDrawer, "core drawer serves the click");
  assert(r.winsAfter === 0 && r.selection === "a", "no adoption, drawer selection intact");
});

// ── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  throw new Error(`registration tests failed:\n  ${failures.join("\n  ")}`);
}
