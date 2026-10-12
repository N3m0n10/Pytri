from petri import PETRI, State, Action


def build_net_three_enabled():
    net = PETRI("Three Enabled Net")
    # places
    net.add_state(State("p1", ""))
    net.add_state(State("p2", ""))
    net.add_state(State("p3", ""))
    net.add_state(State("p4", ""))
    # actions
    net.add_action(Action("t1", ""))
    net.add_action(Action("t2", ""))
    net.add_action(Action("t3", ""))
    # arcs (two per action: pre and post)
    net.add_transition_by_names("a1", "p1->t1", "p1", "t1")
    net.add_transition_by_names("a2", "t1->p4", "t1", "p4")
    net.add_transition_by_names("a3", "p2->t2", "p2", "t2")
    net.add_transition_by_names("a4", "t2->p4", "t2", "p4")
    net.add_transition_by_names("a5", "p3->t3", "p3", "t3")
    net.add_transition_by_names("a6", "t3->p4", "t3", "p4")
    # initial marking: enable all three actions
    net.set_ficha("p1", 1)
    net.set_ficha("p2", 1)
    net.set_ficha("p3", 1)
    net.set_ficha("p4", 0)
    return net


def find_action_for_transition(net, parent_marking, child_marking):
    # Build ordered lists consistent with matrix methods
    ordered_arcs = list(net.transitions.values())
    ordered_actions = list(net.actions.values())
    num_arcs = len(ordered_arcs)
    C = net.incidence_matrix

    # helper to build fired_vec for an action (set arcs touching the action)
    def fired_vec_for_action(action):
        vec = [0] * num_arcs
        for idx, arc in enumerate(ordered_arcs):
            if arc.source == action or arc.target == action:
                vec[idx] = 1
        return vec

    # try each action
    for a_idx, action in enumerate(ordered_actions):
        vec = fired_vec_for_action(action)
        # compute delta = C * vec
        num_states = len(parent_marking)
        delta = [0] * num_states
        for i in range(num_states):
            s = 0
            for j in range(num_arcs):
                s += C[i][j] * vec[j]
            delta[i] = s
        candidate = [parent_marking[i] + delta[i] for i in range(num_states)]
        if candidate == child_marking:
            # return a per-action vector (one entry per action)
            action_vec = [0] * len(ordered_actions)
            action_vec[a_idx] = 1
            return action.name, action_vec
    return None, None


def print_tree_with_actions(net: PETRI):
    tree = net.tree_test  # levels of markings
    ordered_arcs = list(net.transitions.values())
    state_names = list(net.states)
    print(f"Tree for net '{net.name}':")
    visited = set()
    for level_idx, level in enumerate(tree):
        print(f"Level {level_idx}:")
        for marking in level:
            print("  - x = [" + " ".join(str(x) for x in marking) + "]")
        # if next level exists, identify actions leading to each child
        if level_idx + 1 < len(tree):
            parent_level = level
            child_level = tree[level_idx + 1]
            # match each child to some parent + action
            for child in child_level:
                matched = False
                for parent in parent_level:
                    action_name, vec = find_action_for_transition(net, parent, child)
                    if action_name:
                        f_str = "[" + " ".join(str(x) for x in vec) + "]"
                        print(f"    child from parent {parent} -> x = {child}, t = {f_str}, tr = {action_name}")
                        matched = True
                        break
                if not matched:
                    print(f"    child x = {child} -> action not identified")


if __name__ == '__main__':
    net = build_net_three_enabled()
    print_tree_with_actions(net)
