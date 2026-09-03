# Petri Net Prototyper

## Run it
    pip install -r requirements.txt
    python3 app.py
Then open http://127.0.0.1:5000

## Files
- `petri.py`   -- core model (framework-agnostic). Also runnable standalone as a CLI: `python3 petri.py`.
- `app.py`     -- Flask backend, thin REST wrapper around petri.py.
- `templates/index.html` -- single-page canvas GUI (vanilla JS/SVG, no build step).

No simulation is implemented yet -- the `Simulation` class in petri.py is
intentionally left as a stub for a later milestone.

## Run online

You can use https://github.io/N3m0n10/Pytri for running it online. 
This version is a build in css/js and is placed at */docs*
