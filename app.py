"""
GUI backend for the Petri net prototyping tool.

This is deliberately a thin layer: every request just calls straight into
petri.py's PETRI/State/Action/Transition API and turns PetriError/ValueError
into a JSON error response. No net-editing logic lives here -- it all lives
in the model, so the same guarantees apply whether you're using the CLI or
the GUI.

Node (x, y) canvas positions are *not* part of the core model (the model
should stay UI-agnostic), so they're tracked here in a small `positions`
dict and saved/loaded alongside the net's own JSON.

Run with:  python3 app.py
Then open: http://127.0.0.1:5000
"""

from flask import Flask, jsonify, request, render_template, send_file
import io
import json

from petri import PETRI, State, Action, PetriError

app = Flask(__name__)

net = PETRI("Untitled Net")
positions = {}          # node name -> {"x":, "y":, "rotation":, "label_dx":, "label_dy":}
arc_labels = {}         # arc name -> {"label_dx":, "label_dy":}
arc_curves = {}         # arc name -> {"bend": float}  (perpendicular offset of the curve's control point)


def node_kind(name):
    if name in net.states:
        return "state"
    if name in net.actions:
        return "action"
    return None


def net_payload():
    return {
        "name": net.name,
        "states": [
            {
                "name": s.name, "description": s.description, "ficha_count": s.ficha_count,
                **{"x": 80, "y": 80, "rotation": 0, "label_dx": 0, "label_dy": 46,
                   **positions.get(s.name, {})},
            }
            for s in net.states.values()
        ],
        "actions": [
            {
                "name": a.name, "description": a.description, "enum": a.enum,
                "enabled": net.is_enabled(a.name),
                **{"x": 240, "y": 80, "rotation": 0, "label_dx": 0, "label_dy": 46,
                   **positions.get(a.name, {})},
            }
            for a in net.actions.values()
        ],
        "transitions": [
            {
                "name": t.name, "description": t.description,
                "source": t.source.name, "target": t.target.name,
                "weight": t.weight, "arc_type": t.arc_type, "side": t.side,
                **{"label_dx": 6, "label_dy": -6, **arc_labels.get(t.name, {})},
                **{"bend": 0, **arc_curves.get(t.name, {})},
            }
            for t in net.transitions.values()
        ],
    }


def err(e, code=400):
    return jsonify({"error": str(e)}), code


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/net", methods=["GET"])
def get_net():
    return jsonify(net_payload())


@app.route("/api/net/new", methods=["POST"])
def new_net():
    global net, positions, arc_labels, arc_curves
    data = request.get_json(force=True) or {}
    net = PETRI(data.get("name", "Untitled Net"))
    positions = {}
    arc_labels = {}
    arc_curves = {}
    return jsonify(net_payload())


@app.route("/api/net/name", methods=["POST"])
def rename_net():
    data = request.get_json(force=True) or {}
    net.name = data.get("name", net.name)
    return jsonify(net_payload())


@app.route("/api/state", methods=["POST"])
def add_state():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return err("State name is required.")
    try:
        net.add_state(State(name, data.get("description", "")))
    except PetriError as e:
        return err(e)
    positions[name] = {"x": data.get("x", 80), "y": data.get("y", 80)}
    return jsonify(net_payload())


@app.route("/api/action", methods=["POST"])
def add_action():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return err("Action name is required.")
    try:
        net.add_action(Action(name, data.get("description", ""), len(net.actions)))
    except PetriError as e:
        return err(e)
    positions[name] = {"x": data.get("x", 240), "y": data.get("y", 80)}
    return jsonify(net_payload())


@app.route("/api/transition", methods=["POST"])
def add_transition():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    source = data.get("source")
    target = data.get("target")
    if not (name and source and target):
        return err("Arc name, source and target are all required.")
    try:
        weight = int(data.get("weight", 1))
        net.add_transition_by_names(
            name, data.get("description", ""), source, target,
            weight=weight, arc_type=data.get("arc_type", "normal"),
        )
    except (PetriError, ValueError) as e:
        return err(e)
    return jsonify(net_payload())


@app.route("/api/ficha", methods=["POST"])
def add_ficha():
    data = request.get_json(force=True) or {}
    name = data.get("name")
    delta = int(data.get("delta", 0))
    try:
        net.add_ficha(name, delta)
    except (PetriError, ValueError) as e:
        return err(e)
    return jsonify(net_payload())


@app.route("/api/node/<name>/position", methods=["POST"])
def move_node(name):
    data = request.get_json(force=True) or {}
    if node_kind(name) is None:
        return err(f"No node named '{name}'.", 404)
    existing = positions.get(name, {})
    positions[name] = {**existing, "x": data.get("x", 0), "y": data.get("y", 0)}
    return jsonify(net_payload())


@app.route("/api/node/<name>/label_position", methods=["POST"])
def move_node_label(name):
    data = request.get_json(force=True) or {}
    if node_kind(name) is None:
        return err(f"No node named '{name}'.", 404)
    existing = positions.get(name, {})
    positions[name] = {**existing, "label_dx": data.get("dx", 0), "label_dy": data.get("dy", 46)}
    return jsonify(net_payload())


@app.route("/api/node/<name>/rotate", methods=["POST"])
def rotate_node(name):
    """Rotate a node's visual element by 90deg (only meaningful for Actions,
    the transition bars -- Places are drawn as circles and look the same at
    any rotation, but the endpoint works for either)."""
    if node_kind(name) is None:
        return err(f"No node named '{name}'.", 404)
    existing = {"x": 0, "y": 0, "rotation": 0, **positions.get(name, {})}
    existing["rotation"] = (existing.get("rotation", 0) + 90) % 360
    positions[name] = existing
    return jsonify(net_payload())


@app.route("/api/node/<name>/rename", methods=["POST"])
def rename_node(name):
    data = request.get_json(force=True) or {}
    new_name = (data.get("new_name") or "").strip()
    if not new_name:
        return err("A new name is required.")
    kind = node_kind(name)
    try:
        if kind == "state":
            net.rename_state(name, new_name)
        elif kind == "action":
            net.rename_action(name, new_name)
        else:
            return err(f"No node named '{name}'.", 404)
    except PetriError as e:
        return err(e)
    if name in positions:
        positions[new_name] = positions.pop(name)
    return jsonify(net_payload())


@app.route("/api/autoname/<kind>", methods=["GET"])
def autoname(kind):
    if kind == "state":
        return jsonify({"name": net.next_state_name()})
    if kind == "action":
        return jsonify({"name": net.next_action_name()})
    if kind == "transition":
        return jsonify({"name": net.next_transition_name()})
    return err(f"Unknown kind '{kind}'.", 404)


# ---- simulation-prep endpoints ---------------------------------------------
# Not wired into the GUI yet (there's no simulation view), but the firing
# rule itself is ready in petri.py and reachable here for testing/tooling
# ahead of building the actual simulation controls.

@app.route("/api/action/<name>/enabled", methods=["GET"])
def action_enabled(name):
    try:
        return jsonify({"name": name, "enabled": net.is_enabled(name)})
    except PetriError as e:
        return err(e, 404)


@app.route("/api/action/<name>/fire", methods=["POST"])
def fire_action(name):
    try:
        net.fire(name)
    except PetriError as e:
        return err(e)
    return jsonify(net_payload())


@app.route("/api/node/<name>", methods=["DELETE"])
def delete_node(name):
    kind = node_kind(name)
    try:
        if kind == "state":
            net.remove_state(name)
        elif kind == "action":
            net.remove_action(name)
        else:
            return err(f"No node named '{name}'.", 404)
    except PetriError as e:
        return err(e)
    positions.pop(name, None)
    return jsonify(net_payload())


@app.route("/api/transition/<name>", methods=["DELETE"])
def delete_transition(name):
    try:
        net.remove_transition(name)
    except PetriError as e:
        return err(e)
    arc_labels.pop(name, None)
    arc_curves.pop(name, None)
    return jsonify(net_payload())


@app.route("/api/transition/<name>/label_position", methods=["POST"])
def move_transition_label(name):
    data = request.get_json(force=True) or {}
    if name not in net.transitions:
        return err(f"No arc named '{name}'.", 404)
    arc_labels[name] = {"label_dx": data.get("dx", 6), "label_dy": data.get("dy", -6)}
    return jsonify(net_payload())


@app.route("/api/transition/<name>/curve", methods=["POST"])
def curve_transition(name):
    """Bend an arc away from the straight line between its endpoints.
    `bend` is a signed pixel offset for the curve's control point,
    perpendicular to the straight line; 0 means straight."""
    data = request.get_json(force=True) or {}
    if name not in net.transitions:
        return err(f"No arc named '{name}'.", 404)
    try:
        bend = float(data.get("bend", 0))
    except (TypeError, ValueError):
        return err("bend must be a number.")
    arc_curves[name] = {"bend": bend}
    return jsonify(net_payload())


@app.route("/api/export", methods=["GET"])
def export_net():
    payload = net.to_dict()
    payload["_positions"] = positions
    payload["_arc_labels"] = arc_labels
    payload["_arc_curves"] = arc_curves
    buf = io.BytesIO(json.dumps(payload, indent=2).encode("utf-8"))
    buf.seek(0)
    return send_file(buf, mimetype="application/json", as_attachment=True,
                      download_name=f"{net.name.replace(' ', '_')}.json")


@app.route("/api/import", methods=["POST"])
def import_net():
    global net, positions, arc_labels, arc_curves
    data = request.get_json(force=True) or {}
    try:
        loaded_positions = data.pop("_positions", {})
        loaded_arc_labels = data.pop("_arc_labels", {})
        loaded_arc_curves = data.pop("_arc_curves", {})
        net = PETRI.from_dict(data)
        positions = loaded_positions
        arc_labels = loaded_arc_labels
        arc_curves = loaded_arc_curves
    except Exception as e:
        return err(f"Could not load file: {e}")
    return jsonify(net_payload())


if __name__ == "__main__":
    app.run(debug=False)
