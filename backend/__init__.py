"""cardwindows — LOCAL plugin (gitignored): free-floating, multi-open card windows.

Backend-wise this is a pure DECLARATION — no tab, no widgets, no polls, no router.
The whole behavior lives in the frontend package
(``frontend/src/plugins/local/cardwindows/``), which registers against the FE
kernel: a ``surface.card`` provider (priority 100) that adopts a selected card
into a floating window instead of the fixed right drawer, and a
``surface.overlay`` collection item hosting the windows (each one renders the
REAL core CardDetail inside draggable/resizable chrome, with 並排/四分割 tiling).

The declaration exists so the plugin manager panel can list/disable/remove it.
NOTE the FE caveat: frontend layouts are collected at BUILD time
(``import.meta.glob``), so disabling here stops nothing visible by itself — the
fixed drawer returns only after the frontend directory is absent (manager's
remove moves both dirs to ``~/.conductor/disabled-plugins/``) AND a frontend
rebuild + page reload (the manager's apply endpoint does both). This is spelled
out for users in ``conductor-plugin.json``.
"""

from __future__ import annotations

from conductor.plugins.base import Plugin

PLUGIN = Plugin(
    id="cardwindows",
    label="CardWin",
    icon="🗔",
    order=130,
)
