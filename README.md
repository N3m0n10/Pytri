# Petri Net Prototyper

## Run it
    pip install -r requirements.txt
    python3 app.py
Then open http://127.0.0.1:5000

## Files
- `petri.py`   -- core model (framework-agnostic). Also runnable standalone as a CLI: `python3 petri.py`.
- `app.py`     -- Flask backend, thin REST wrapper around petri.py.
- `templates/index.html` -- single-page canvas GUI (vanilla JS/SVG, no build step).
- `docs/`      -- browser-only static build for GitHub Pages.

## Model terms

The Python model uses standard Petri-net names: `State` is a place, `Transition`
is a firing transition, and `Arc` connects a place and transition. The model
collections are `net.states`, `net.transitions`, and `net.arcs`; use
`add_transition()` for firing nodes and `add_arc_by_names()` for connections.

New JSON exports use `states`, `transitions`, and `arcs`. Files using the older
`actions` and `transitions` layout are still accepted on import and are
normalized to the canonical schema when saved again. Python callers using the
old `Action`, arc-valued `Transition`, or `net.actions` API must migrate to the
new names.

The `Simulation` class remains a stub while timed-transition semantics are
being considered. Reachability and coverability remain separate from timed
simulation.

## Run online

You can use [online_version](https://n3m0n10.github.io/Pytri/) for running it online. 
This version is a build in css/js and is placed at */docs*!
It also works with mobile!
