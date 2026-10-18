from petri import PETRI, State, Transition


def build_example_net():
    net = PETRI("Example Net")
    net.add_state(State("p1", "place 1"))
    net.add_state(State("p2", "place 2"))
    net.add_transition(Transition("t1", "t1"))
    net.add_transition(Transition("t2", "t2"))
    # Arcs: p1 -> t1, t1 -> p2, p2 -> t2, t2 -> p1 (a simple token hop)
    net.add_arc_by_names("a1", "p1->t1", "p1", "t1")
    net.add_arc_by_names("a2", "t1->p2", "t1", "p2")
    net.add_arc_by_names("a3", "p2->t2", "p2", "t2")
    net.add_arc_by_names("a4", "t2->p1", "t2", "p1")
    net.set_ficha("p1", 1)
    net.set_ficha("p2", 0)
    return net


def print_reachability_tree(net: PETRI):
    tree = net.tree_test
    state_names = list(net.states)
    print(f"Reachability tree for net '{net.name}':")
    for level_idx, level in enumerate(tree):
        print(f"Level {level_idx}:")
        for marking in level:
            labeled = ", ".join(f"{s}={m}" for s, m in zip(state_names, marking))
            print("  -", labeled)


if __name__ == "__main__":
    net = build_example_net()
    print_reachability_tree(net)
