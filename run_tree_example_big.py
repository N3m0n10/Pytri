from petri import PETRI, State, Action


def build_example_net():
    net = PETRI("Bigger Net")
    # create 4 places
    for i in range(1, 5):
        net.add_state(State(f"p{i}", f"place {i}"))
    # create 3 actions
    net.add_action(Action("t1", "t1"))
    net.add_action(Action("t2", "t2"))
    net.add_action(Action("t3", "t3"))

    # arcs (as transitions/edges):
    # p1 -> t1 -> p2
    # p2 -> t2 -> p3
    # p3 -> t3 -> p4
    # p4 -> t1 -> p1 (feedback)
    net.add_transition_by_names("a1", "p1->t1", "p1", "t1")
    net.add_transition_by_names("a2", "t1->p2", "t1", "p2")
    net.add_transition_by_names("a3", "p2->t2", "p2", "t2")
    net.add_transition_by_names("a4", "t2->p3", "t2", "p3")
    net.add_transition_by_names("a5", "p3->t3", "p3", "t3")
    net.add_transition_by_names("a6", "t3->p4", "t3", "p4")
    net.add_transition_by_names("a7", "p4->t1", "p4", "t1")
    net.add_transition_by_names("a8", "t1->p1", "t1", "p1")

    # initial marking
    net.set_ficha("p1", 1)
    net.set_ficha("p2", 0)
    net.set_ficha("p3", 0)
    net.set_ficha("p4", 0)
    return net


def print_tree_matrix(net: PETRI):
    tree = net.tree_mtrx()
    state_names = list(net.states)
    print(f"Tree (matrix view) for net '{net.name}':")
    for level_idx, level in enumerate(tree):
        print(f"Level {level_idx}:")
        for marking, fired, trans_name, terminal in level:
            m_str = "[" + " ".join(str(x) for x in marking) + "]"
            f_str = "[" + " ".join(str(x) for x in fired) + "]"
            term = "TERMINAL" if terminal else ""
            print(f"  - x = {m_str}, t = {f_str}, tr = {trans_name} {term}")


if __name__ == "__main__":
    net = build_example_net()
    print_tree_matrix(net)
