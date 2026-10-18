import unittest

import app as flask_app
from petri import Arc, PETRI, State, Transition


class ModelNamingTests(unittest.TestCase):
    def build_cycle(self):
        net = PETRI("Cycle")
        net.add_state(State("p1"))
        net.add_state(State("p2"))
        net.add_transition(Transition("t1", "move forward"))
        net.add_transition(Transition("t2", "move back"))
        net.add_arc(Arc("a1", "consume p1", net.states["p1"], net.transitions["t1"]))
        net.add_arc(Arc("a2", "produce p2", net.transitions["t1"], net.states["p2"]))
        net.add_arc(Arc("a3", "consume p2", net.states["p2"], net.transitions["t2"]))
        net.add_arc(Arc("a4", "produce p1", net.transitions["t2"], net.states["p1"]))
        net.set_ficha("p1", 1)
        return net

    def test_canonical_schema_and_firing(self):
        net = self.build_cycle()

        self.assertEqual(set(net.to_dict()), {"name", "states", "transitions", "arcs"})
        self.assertEqual([transition.name for transition in net.transitions.values()], ["t1", "t2"])
        self.assertEqual([arc.name for arc in net.arcs.values()], ["a1", "a2", "a3", "a4"])
        self.assertEqual(net.list_enabled_transitions(), ["t1"])
        self.assertEqual(net.fire("t1"), {"p1": 0, "p2": 1})

    def test_loads_legacy_schema_and_exports_canonical_schema(self):
        legacy_data = {
            "name": "Legacy",
            "states": [{"name": "p1", "ficha_count": 1}],
            "actions": [{"name": "t1", "description": "timed", "type": "timed"}],
            "transitions": [{
                "name": "a1", "source": "p1", "target": "t1",
                "weight": 1, "arc_type": "read",
            }],
        }

        net = PETRI.from_dict(legacy_data)

        self.assertEqual(net.transitions["t1"].type, "timed")
        self.assertIsInstance(net.arcs["a1"], Arc)
        self.assertEqual(set(net.to_dict()), {"name", "states", "transitions", "arcs"})
        self.assertEqual(net.list_enabled_transitions(), ["t1"])

    def test_tree_firing_vector_indexes_transitions(self):
        net = self.build_cycle()
        tree = net.tree_mtrx()

        self.assertEqual(tree[1][0][0], [0, 1])
        self.assertEqual(tree[1][0][1], [1, 0])
        self.assertEqual(tree[1][0][2], "t1")
        self.assertTrue(tree[2][0][3])
        self.assertEqual(tree[2][0][0], [1, 0])

    def test_flask_api_uses_transition_and_arc_names(self):
        client = flask_app.app.test_client()
        client.post("/api/net/new", json={"name": "API naming"})
        client.post("/api/state", json={"name": "p1"})
        client.post("/api/state", json={"name": "p2"})
        client.post("/api/ficha", json={"name": "p1", "delta": 1})
        transition_response = client.post("/api/transition", json={"name": "t1"})
        self.assertEqual(transition_response.status_code, 200)
        client.post("/api/arc", json={"name": "a1", "source": "p1", "target": "t1"})
        client.post("/api/arc", json={"name": "a2", "source": "t1", "target": "p2"})

        payload = client.get("/api/net").get_json()
        self.assertIn("transitions", payload)
        self.assertIn("arcs", payload)
        self.assertNotIn("actions", payload)
        self.assertEqual(payload["transitions"][0]["name"], "t1")
        self.assertEqual([arc["name"] for arc in payload["arcs"]], ["a1", "a2"])

        fired = client.post("/api/transition/t1/fire")
        self.assertEqual(fired.status_code, 200)
        self.assertEqual({state["name"]: state["ficha_count"] for state in fired.get_json()["states"]},
                         {"p1": 0, "p2": 1})


if __name__ == "__main__":
    unittest.main()