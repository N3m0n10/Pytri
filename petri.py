"""
Core Petri net data model.

Naming note (kept from the original prototype, mapped to standard / TINA
terminology so the mismatch doesn't trip anyone up later):

    This code        Standard Petri net / TINA term
    ---------        ------------------------------
    State             Place            (holds tokens -> `ficha_count`)
    Transition         Transition       (the thing that "fires")
    Arc                Arc              (connects a Place <-> Transition)

A Petri net is bipartite: arcs only ever connect a State to a Transition, or
a Transition to a State. Two States (or two Transitions) can never be linked
directly. All validation below enforces that.
"""

import json

# --------------------------------------------------------------------------- #
# Auxiliar classes
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #

class PetriError(Exception):
    """Base class for all structural errors raised by the PETRI model."""


class DuplicateNameError(PetriError):
    pass


class InvalidArcError(PetriError):
    """Raised when an arc would violate the bipartite structure, or would
    duplicate an existing arc between the same pair of nodes."""


class NotFoundError(PetriError):
    pass


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #

class State:
    """A Place: holds tokens ("fichas")."""

    def __init__(self, name: str, description: str = ""):
        self.name = name
        self.description = description
        self.ficha_count = 0


class Transition:
    """A firing transition in a Petri net."""

    def __init__(self, name: str, description: str, enum=None, type: str = "normal"):
        self.name = name
        self.description = description
        self.enum = enum
        self.type = type # can be "timed"


class Arc:
    """An arc connecting a State and a Transition."""

    VALID_ARC_TYPES = ("normal", "inhibitor", "read")

    def __init__(self, name: str, description: str, source, target,
                 weight: int = 1, arc_type: str = "normal"):
        self.name = name
        self.description = description
        self.source = source
        self.target = target
        if weight < 1:
            raise ValueError("Arc weight must be a positive integer.")
        self.weight = weight
        if arc_type not in self.VALID_ARC_TYPES:
            raise ValueError(f"arc_type must be one of {self.VALID_ARC_TYPES}")
        if arc_type in ("inhibitor", "read") and not isinstance(source, State):
            raise ValueError(
                f"'{arc_type}' arcs only make sense from a State to a Transition "
                "(they guard a transition by testing a place's marking)."
            )
        self.arc_type = arc_type

    @property
    def side(self) -> str:
        """Return 'pre' for State -> Transition and 'post' for Transition -> State."""
        return "pre" if isinstance(self.source, State) else "post"


class PETRI:
    """Own the places, firing transitions, and arcs of a Petri net."""

    def __init__(self, name):
        self.name = name
        self.states = {}
        self.transitions = {}
        self.arcs = {}
        self.count_arcs = 0
        self._next_state_seq = 0
        self._next_transition_seq = 0
        self._next_arc_seq = 0
        self._removed_state_names = set()
        self._removed_transition_names = set()
        self._removed_arc_names = set()
        self._history = []
        self._history_matrix = []

    @classmethod
    def _save_step(cls, petri_net: 'PETRI'):
        petri_net._history.append(petri_net.to_dict())

    @classmethod
    def _save_step_matrix(cls, petri_net: 'PETRI'):
        petri_net._history_matrix.append([petri_net.incidence_matrix, petri_net.output_matrix])

    def add_simulation(self, simulation: 'Simulation'):
        self.simulation = simulation

    def run_simulation(self):
        if hasattr(self, 'simulation'):
            self.simulation.run()
        else:
            print("No simulation has been added to this Petri net.")

    def get_node(self, name: str):
        if name in self.states:
            return self.states[name]
        if name in self.transitions:
            return self.transitions[name]
        raise NotFoundError(f"No state or transition named '{name}' exists.")

    def _name_taken(self, name: str) -> bool:
        return name in self.states or name in self.transitions

    def next_state_name(self) -> str:
        while True:
            self._next_state_seq += 1
            name = f"p{self._next_state_seq}"
            if not self._name_taken(name):
                return name

    def next_transition_name(self) -> str:
        while True:
            self._next_transition_seq += 1
            name = f"t{self._next_transition_seq}"
            if not self._name_taken(name):
                return name

    def next_arc_name(self) -> str:
        while True:
            self._next_arc_seq += 1
            name = f"a{self._next_arc_seq}"
            if name not in self.arcs:
                return name

    def rename_state(self, old_name: str, new_name: str):
        if old_name not in self.states:
            raise NotFoundError(f"State '{old_name}' does not exist.")
        if new_name != old_name and self._name_taken(new_name):
            raise DuplicateNameError(f"'{new_name}' is already in use.")
        if len(old_name) > 1 and old_name[0] == 'p' and old_name[1:].isdigit():
            self._removed_state_names.add(old_name)
        state = self.states.pop(old_name)
        state.name = new_name
        self.states[new_name] = state
        return state

    def rename_transition(self, old_name: str, new_name: str):
        if old_name not in self.transitions:
            raise NotFoundError(f"Transition '{old_name}' does not exist.")
        if new_name != old_name and self._name_taken(new_name):
            raise DuplicateNameError(f"'{new_name}' is already in use.")
        if len(old_name) > 1 and old_name[0] == 't' and old_name[1:].isdigit():
            self._removed_transition_names.add(old_name)
        transition = self.transitions.pop(old_name)
        transition.name = new_name
        self.transitions[new_name] = transition
        return transition

    def rename_arc(self, old_name: str, new_name: str):
        if old_name not in self.arcs:
            raise NotFoundError(f"Arc '{old_name}' does not exist.")
        if new_name != old_name and new_name in self.arcs:
            raise DuplicateNameError(f"'{new_name}' is already in use.")
        if len(old_name) > 1 and old_name[0] == 'a' and old_name[1:].isdigit():
            self._removed_arc_names.add(old_name)
        arc = self.arcs.pop(old_name)
        arc.name = new_name
        self.arcs[new_name] = arc
        return arc

    # ---- states (places) ------------------------------------------------#
    def add_state(self, state: 'State'):
        if state.name in self.states:
            raise DuplicateNameError(f"State '{state.name}' already exists.")
        if state.name in self.transitions:
            raise DuplicateNameError(
                f"'{state.name}' is already used as a transition name; "
                f"state and transition names share one namespace and must be unique."
            )
        self.states[state.name] = state
        return state

    def remove_state(self, name: str):
        if name not in self.states:
            raise NotFoundError(f"State '{name}' does not exist.")
        if len(name) > 1 and name[0] == 'p' and name[1:].isdigit():
            self._removed_state_names.add(name)
        for t_name in [t.name for t in self.arcs.values()
                        if t.source.name == name or t.target.name == name]:
            del self.arcs[t_name]
        del self.states[name]

    def add_ficha(self, place_name: str, ficha_count: int):
        """Add (or, with a negative number, remove) tokens from a place."""
        if place_name not in self.states:
            raise NotFoundError(f"State '{place_name}' does not exist. Cannot add ficha.")
        state = self.states[place_name]
        new_count = state.ficha_count + ficha_count
        if new_count < 0:
            raise ValueError(
                f"Cannot remove {abs(ficha_count)} ficha(s) from '{place_name}'; "
                f"only {state.ficha_count} available."
            )
        state.ficha_count = new_count
        return state.ficha_count

    def set_ficha(self, place_name: str, count: int):
        """Set the marking of a place directly (used by the GUI's initial-marking editor)."""
        if place_name not in self.states:
            raise NotFoundError(f"State '{place_name}' does not exist.")
        if count < 0:
            raise ValueError("Token count cannot be negative.")
        self.states[place_name].ficha_count = count

    # ---- transitions -----------------------------------------------------#
    def add_transition(self, transition: 'Transition'):
        if transition.name in self.transitions:
            raise DuplicateNameError(f"Transition '{transition.name}' already exists.")
        if transition.name in self.states:
            raise DuplicateNameError(
                f"'{transition.name}' is already used as a state name; "
                f"state and transition names share one namespace and must be unique."
            )
        self.transitions[transition.name] = transition
        return transition

    def remove_transition(self, name: str):
        if name not in self.transitions:
            raise NotFoundError(f"Transition '{name}' does not exist.")
        if len(name) > 1 and name[0] == 't' and name[1:].isdigit():
            self._removed_transition_names.add(name)
        for arc_name in [arc.name for arc in self.arcs.values()
                        if arc.source.name == name or arc.target.name == name]:
            del self.arcs[arc_name]
        del self.transitions[name]

    # ---- arcs ------------------------------------------------------------#
    def _validate_endpoints(self, source_name: str, target_name: str):
        state_to_transition = source_name in self.states and target_name in self.transitions
        transition_to_state = source_name in self.transitions and target_name in self.states
        if not (state_to_transition or transition_to_state):
            raise InvalidArcError(
                "Petri nets are bipartite: an arc must connect a State to a "
                "Transition, or a Transition to a State (never State-State or "
                "Transition-Transition)."
            )

    def add_arc(self, arc: 'Arc'):
        self._validate_endpoints(arc.source.name, arc.target.name)
        if arc.name in self.arcs:
            raise DuplicateNameError(f"Arc '{arc.name}' already exists.")
        for existing in self.arcs.values():
            if existing.source.name == arc.source.name and existing.target.name == arc.target.name:
                raise DuplicateNameError(
                    f"An arc from '{arc.source.name}' to '{arc.target.name}' "
                    f"already exists ('{existing.name}')."
                )
        self.arcs[arc.name] = arc
        self.count_arcs += 1
        return arc

    def add_arc_by_names(self, name: str, description: str,
                         source_name: str, target_name: str,
                         weight: int = 1, arc_type: str = "normal"):
        """Look up endpoints by name and create an arc between them."""
        source = self.get_node(source_name)
        target = self.get_node(target_name)
        arc = Arc(name, description, source, target, weight, arc_type)
        return self.add_arc(arc)

    def remove_arc(self, name: str):
        if name not in self.arcs:
            raise NotFoundError(f"Arc '{name}' does not exist.")
        if len(name) > 1 and name[0] == 'a' and name[1:].isdigit():
            self._removed_arc_names.add(name)
        del self.arcs[name]

    # ---- matrix -----------------------------------------------------------
    @property
    def incidence_matrix(self):
        """Return a matrix with states as rows and arcs as columns.
        Entry [i][j] is +weight when arc j produces into state i and
        -weight when arc j consumes from state i,
                    0 otherwise.
        """
        states = self.states
        arcs = list(self.arcs.values())
        state_index = {name: i for i, name in enumerate(states)}
        num_states = len(states)
        num_arcs = len(arcs)

        matrix = [[0] * num_arcs for _ in range(num_states)]

        for j, arc in enumerate(arcs):
            src_idx = state_index.get(arc.source.name)
            tgt_idx = state_index.get(arc.target.name)

            if src_idx is not None:
                matrix[src_idx][j] -= arc.weight   # tokens consumed
            if tgt_idx is not None:
                matrix[tgt_idx][j] += arc.weight   # tokens produced

        return matrix

    @property
    def output_matrix(self):
        return [state.ficha_count for state in self.states.values()]

    def next_output(self, arcs_fired):
        """Compute a marking delta from a 0/1 vector with one slot per arc."""
        x = self.incidence_matrix   # shape (num_states, num_arcs)
        y = self.output_matrix      # shape (num_states,)
        num_states = len(y)
        num_arcs = len(x[0]) if num_states else 0

        if len(arcs_fired) != num_arcs:
            raise ValueError(
                f"arcs_fired has length {len(arcs_fired)}, "
                f"expected {num_arcs}"
            )

        output = []
        for i in range(num_states):
            delta = sum(x[i][j] * arcs_fired[j] for j in range(num_arcs))
            output.append(y[i] + delta)

        return output
        
    # ---- inspection -------------------------------------------------------#
    def arcs_of(self, node_name: str):
        """All arcs touching a State or Transition, split by direction."""
        incoming = [arc for arc in self.arcs.values() if arc.target.name == node_name]
        outgoing = [arc for arc in self.arcs.values() if arc.source.name == node_name]
        return {"incoming": incoming, "outgoing": outgoing}

    # ---- Description  ---------------------------------------------#
    @property
    def net_type(self):
        """Return a string describing the net type based on its arcs."""
        """Naming according to TINA"""
        has_inhibitor = any(arc.arc_type == "inhibitor" for arc in self.arcs.values())
        has_read = any(arc.arc_type == "read" for arc in self.arcs.values())
        if has_inhibitor and has_read:
            return "Inhibitor + Read Arc Petri Net"
        elif has_inhibitor:
            return "Inhibitor Petri Net"
        elif has_read:
            return "Read Arc Petri Net"
        else:
            return "Ordinary Petri Net"

    @property
    def net_descriptionn(self):
        """Naming according to Discrete control naming, and the book {TODO:check name}"""
        # TODO: USE MATRIX
        type_list = []
        one_ticket = sum(state.ficha_count for state in self.states.values()) == 1
        one_connection_t = any((len(arc.source) < 2 and len(arc.target) < 2) for arc in self.arcs.values())
        pres = [arc.source.name for arc in self.arcs.values() if isinstance(arc.source, State)]
        posts = [arc.target.name for arc in self.arcs.values() if isinstance(arc.target, State)]
        all_weight_1 = all(arc.weight == 1 for arc in self.arcs.values())
        if all_weight_1:
            type_list.append("Ordinary")
            if one_connection_t:
                type_list.append("State Machine")
                if one_ticket:
                    type_list.append("Automatus like")
        if posts == set(posts):
            type_list.append("Free of conflicts")
            if pres == set(pres):
                type_list.append("Marked Graph")
        return type_list

    @property  # NOTE: This is a stub for future work. The idea is to build a reachability tree of all possible markings from the current marking, but this is not yet implemented.
    def tree_simple(self): 
        """Compatibility wrapper: return a reachability tree computed by
        the matrix-based `tree_test` implementation. This avoids mutating
        the live net state and is safe to run for testing."""
        return self.tree_test

    def tree_mtrx(self):
        """Build a breadth-first reachability tree using the incidence
        matrix and a marking vector. Returns a list of levels; each level
        is a list of tuples: (marking_list, transition_name) where
        `transition_name` is the transition fired to reach that marking
        from its parent. The root level contains the current marking with
        transition_name set to None.
        """
        # Helper: deterministic ordering of transitions (consistent with matrices)
        def _ordered_transitions():
            return list(self.transitions.values())

        def _transition_name_by_index(idx: int):
            trans = _ordered_transitions()
            return trans[idx].name if 0 <= idx < len(trans) else None

        def _next_output_from_marking(marking, fired_vec):
            # incidence_matrix: rows = states, cols = transitions
            C = self.incidence_matrix
            num_states = len(marking)
            num_trans = len(fired_vec)
            # guard size
            if not C:
                return list(marking)
            # compute delta = C * fired_vec
            delta = [0] * num_states
            for i in range(num_states):
                s = 0
                for j in range(num_trans):
                    s += C[i][j] * fired_vec[j]
                delta[i] = s
            return [marking[i] + delta[i] for i in range(num_states)]

        # BFS setup
        root = list(self.output_matrix)
        if len(self.states) == 0:
            return []

        transitions = _ordered_transitions()
        num_trans = len(transitions)

        visited = {tuple(root)}
        # levels will contain lists of tuples: (marking, fired_vector, transition_name, terminal_flag)
        levels = [[(root, [0] * num_trans, None, False)]]
        current_level = [root]

        while current_level:
            next_level = []
            for marking in current_level:
                enabled_flags = self.is_enabled_by_matrix(marking)
                for j, ok in enumerate(enabled_flags):
                    if not ok:
                        continue
                    transition = transitions[j]
                    fired_vec = [0] * num_trans
                    fired_vec[j] = 1
                    new_marking = list(marking)
                    for arc in self.pre_arcs(transition.name):
                        if arc.arc_type == "normal":
                            place_index = list(self.states).index(arc.source.name)
                            new_marking[place_index] -= arc.weight
                    for arc in self.post_arcs(transition.name):
                        place_index = list(self.states).index(arc.target.name)
                        new_marking[place_index] += arc.weight

                    key = tuple(new_marking)
                    terminal = key in visited
                    if not terminal:
                        visited.add(key)
                    next_level.append((new_marking, fired_vec, transition.name, terminal))
            if next_level:
                levels.append(next_level)
            current_level = [marking for marking, _, _, terminal in next_level if not terminal]

        return levels
        
    @property
    def tree_test(self):
        """Breadth-first reachability tree: list of levels; each level is a list of marking vectors."""
        root = list(self.output_matrix)
        if len(self.states) == 0:
            return []

        ordered_arcs = list(self.arcs.values())
        ordered_transitions = list(self.transitions.values())
        num_arcs = len(ordered_arcs)

        def _fired_vec_for_transition(transition):
            vec = [0] * num_arcs
            for idx, arc in enumerate(ordered_arcs):
                if arc.source == transition or arc.target == transition:
                    vec[idx] = 1
            return vec

        # map state name -> index in marking vector
        state_index = {name: i for i, name in enumerate(self.states)}

        visited = {tuple(root)}
        levels = [[root]]
        current_level = [root]

        while current_level:
            next_level = []
            for marking in current_level:
                for transition in ordered_transitions:
                    enabled = True
                    for pre in [arc for arc in ordered_arcs if arc.side == 'pre' and arc.target == transition]:
                        src_idx = state_index.get(pre.source.name)
                        if src_idx is None:
                            enabled = False
                            break
                        tokens = marking[src_idx]
                        if pre.arc_type in ("normal", "read"):
                            if tokens < pre.weight:
                                enabled = False
                                break
                        elif pre.arc_type == "inhibitor" and tokens >= pre.weight:
                            enabled = False
                            break
                    if not enabled:
                        continue

                    fired_vec = _fired_vec_for_transition(transition)
                    # compute new marking from marking (without touching live net)
                    C = self.incidence_matrix
                    if not C:
                        new_marking = list(marking)
                    else:
                        num_states = len(marking)
                        delta = [0] * num_states
                        for i in range(num_states):
                            s = 0
                            for j in range(num_arcs):
                                s += C[i][j] * fired_vec[j]
                            delta[i] = s
                        new_marking = [marking[i] + delta[i] for i in range(num_states)]

                    # skip markings that would be negative
                    if any(n < 0 for n in new_marking):
                        continue

                    key = tuple(new_marking)
                    if key not in visited:
                        visited.add(key)
                        next_level.append(new_marking)

            if next_level:
                levels.append(next_level)
            current_level = next_level

        return levels

    # ---- simulation primitives ---------------------------------------------#
    # The actual run loop (Simulation.run/next_state -- deciding *which*
    # enabled transition to fire and stepping through time) is still future
    # work. What's here is the net-level firing rule itself: whether an
    # transition's preconditions hold, and what firing it does to the marking.
    # This is what a simulation loop will call into.

    #def calc_state_by_matrix(self, transitions_fired:list):
        #count_f = {f: transitions_fired.count(f) for f in set(transitions_fired)} # dict with trans_name: count_fired
        #counted_t = [count_f.get(t.name, 0) for t in self.transitions] # same, but adding the ones with zeros 
        #size_rows = len(self.states)
        #size_cols = len(self.transitions)
        #rows = [self.incidence_matrix[i * size_cols:(i + 1) * size_cols] for i in range(size_rows)]
        # Matrix multiplication: delta = C * counted_t, where C is the incidence matrix and counted_t is the vector of transition firings
        #delta = [sum(row[i] * counted_t[i] for i in range(len(counted_t)))
        #    for row in rows]

        # 4. Add the result to the initial output/marking array
        #return [out + change for out, change in zip(self.output_matrix, delta)]

    #def get_state_by_matrix(self, transitions_fired:list):
        #new_state = self.calc_state_by_matrix(transitions_fired)
        #for i, state in enumerate(self.states.values()):
        #    state.ficha_count = new_state[i]
        #return new_state

    def pre_arcs(self, transition_name: str):
        """Input arcs (State -> Transition) feeding a transition."""
        if transition_name not in self.transitions:
            raise NotFoundError(f"Transition '{transition_name}' does not exist.")
        return [arc for arc in self.arcs.values()
                if arc.target.name == transition_name and arc.side == "pre"]

    def post_arcs(self, transition_name: str):
        """Output arcs (Transition -> State) produced by a transition."""
        if transition_name not in self.transitions:
            raise NotFoundError(f"Transition '{transition_name}' does not exist.")
        return [arc for arc in self.arcs.values()
                if arc.source.name == transition_name and arc.side == "post"]

    def is_enabled(self, transition_name: str) -> bool:
        """True if every precondition on `transition_name` is satisfied by the
        current marking: normal/read arcs need >= weight tokens available,
        inhibitor arcs need FEWER than `weight` tokens present."""
        for arc in self.pre_arcs(transition_name):
            tokens = arc.source.ficha_count
            if arc.arc_type in ("normal", "read"):
                if tokens < arc.weight:
                    return False
            elif arc.arc_type == "inhibitor" and tokens >= arc.weight:
                return False
        return True

    def is_enabled_by_matrix(self, output_matrix):
        """Return an enabled flag for each transition at the given marking."""
        transitions = list(self.transitions.values())
        num_states = len(self.states)
        if len(output_matrix) != num_states:
            raise ValueError(
                f"output_matrix has length {len(output_matrix)}, expected {num_states}"
            )

        state_index = {name: i for i, name in enumerate(self.states)}
        enabled_list = []
        for transition in transitions:
            enabled = True
            for arc in self.pre_arcs(transition.name):
                tokens = output_matrix[state_index[arc.source.name]]
                if arc.arc_type in ("normal", "read") and tokens < arc.weight:
                    enabled = False
                    break
                if arc.arc_type == "inhibitor" and tokens >= arc.weight:
                    enabled = False
                    break
            enabled_list.append(enabled)
        return enabled_list
        

    def list_enabled_transitions(self):
        """Names of all transitions enabled under the current marking."""
        return [name for name in self.transitions if self.is_enabled(name)]

    def fire(self, transition_name: str):
        """Fire `transition_name`: consume tokens along its normal input arcs and
        produce tokens along its output arcs (read/inhibitor arcs never move
        tokens, they only guard). Raises PetriError if not enabled."""
        if not self.is_enabled(transition_name):
            raise PetriError(
                f"Transition '{transition_name}' is not enabled -- a precondition on "
                f"one of its input places is not satisfied."
            )
        for arc in self.pre_arcs(transition_name):
            if arc.arc_type == "normal":
                arc.source.ficha_count -= arc.weight
        for arc in self.post_arcs(transition_name):
            arc.target.ficha_count += arc.weight
        return {name: s.ficha_count for name, s in self.states.items()}

    def show_attributes(self):
        print("----------------------------------")
        print(f"PETRI Net Name: {self.name}")
        print("----------------------------------")
        print("States:")
        for state in self.states.values():
            print(f"  - {state.name}: {state.description} | Fichas: {state.ficha_count}")
        print("----------------------------------")
        print("Transitions:")
        for transition in self.transitions.values():
            print(f"  - {transition.name}: {transition.description} (type: {transition.type})")
        print("----------------------------------")
        print("Arcs:")
        for arc in self.arcs.values():
            print(f"  - {arc.name}: {arc.description} ({arc.source.name} -> {arc.target.name}) "
                  f"[side={arc.side}, weight={arc.weight}, type={arc.arc_type}]")
        print("----------------------------------")
        table = self.incidence_matrix
        print("Incidence Matrix:")
        print("   " + " ".join(f"{name:>5}" for name in self.arcs))
        for i, state in enumerate(self.states):
            row = table[i * len(self.arcs):(i + 1) * len(self.arcs)]
            print(f"{state:>3} " + " ".join(f"{val:>5}" for val in row))

    def return_attr(self):
        return {"name": self.name, "states": self.states,
                "transitions": self.transitions, "arcs": self.arcs}

    def EXPORT(self):
        return {"states": self.states, "transitions": self.transitions, "arcs": self.arcs}

    # ---- persistence -------------------------------------------------------#
    def to_dict(self):
        return {
            "name": self.name,
            "states": [
                {"name": s.name, "description": s.description, "ficha_count": s.ficha_count}
                for s in self.states.values()
            ],
            "transitions": [
                {"name": transition.name, "description": transition.description,
                 "enum": transition.enum, "type": transition.type}
                for transition in self.transitions.values()
            ],
            "arcs": [
                {
                    "name": arc.name, "description": arc.description,
                    "source": arc.source.name, "target": arc.target.name,
                    "weight": arc.weight, "arc_type": arc.arc_type,
                }
                for arc in self.arcs.values()
            ],
        }

    @classmethod
    def from_dict(cls, data: dict):
        net = cls(data["name"])
        legacy_format = "arcs" not in data
        for s in data.get("states", []):
            state = State(s["name"], s.get("description", ""))
            state.ficha_count = s.get("ficha_count", 0)
            net.states[state.name] = state
        transition_data = data.get("actions", []) if legacy_format else data.get("transitions", [])
        arc_data = data.get("transitions", []) if legacy_format else data.get("arcs", [])
        for item in transition_data:
            net.transitions[item["name"]] = Transition(
                item["name"], item.get("description", ""), item.get("enum"),
                item.get("type", "normal"),
            )
        for item in arc_data:
            source = net.get_node(item["source"])
            target = net.get_node(item["target"])
            net.arcs[item["name"]] = Arc(
                item["name"], item.get("description", ""), source, target,
                weight=item.get("weight", 1), arc_type=item.get("arc_type", "normal"),
            )
        net.count_arcs = len(net.arcs)
        return net

    def save_json(self, filepath: str):
        with open(filepath, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load_json(cls, filepath: str):
        with open(filepath) as f:
            data = json.load(f)
        return cls.from_dict(data)

    @staticmethod  # TODO: tree node for the tree class. With n children per node (n = transition num) 
    def Node(mother,childer:list):
        pass


class Simulation:
    """Thin wrapper around the net's firing primitives (`PETRI.is_enabled`
    and `PETRI.fire`). What's still a stub on purpose is the *policy* --
    `run`/`next_state` would need to decide which of possibly several
    enabled transitions to fire and how to step through time, and that's a
    design choice (interactive stepping? random? priority order? TINA-style
    firing intervals?) left for the actual simulation milestone."""

    def __init__(self, petri_net: PETRI):
        self.petri_net = petri_net

    def run(self):
        pass  # TODO: stepping/scheduling policy

    def next_state(self):
        pass  # TODO: pick + fire the next transition per that policy

    def enabled_transitions(self, transition_name: str | None = None):
        """With a name: check that transition; otherwise list enabled transitions."""
        if transition_name is not None:
            return self.petri_net.is_enabled(transition_name)
        return self.petri_net.list_enabled_transitions()

    def fire_transition(self, transition_name: str):
        return self.petri_net.fire(transition_name)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
if __name__ == "__main__":

    Petri = PETRI("My Petri Net")
    print("PETRI Net construction via CLI")

    while True:
        print("\nChoose an option:")
        print("1. Add State")
        print("2. Add Arc")
        print("3. Add Transition")
        print("4. Add Ficha")
        print("5. Show Petri Net attributes")
        print("6. Save to JSON")
        print("7. Load from JSON")
        print("8. Exit")

        choice = input("Enter your choice: ")

        try:
            if choice == "1":
                suggested = Petri.next_state_name()
                state_name = input(f"Enter state name [{suggested}]: ").strip() or suggested
                state_description = input("Enter state description: ")
                Petri.add_state(State(state_name, state_description))
                print(f"State '{state_name}' added.")

            elif choice == "2":
                suggested = Petri.next_arc_name()
                arc_name = input(f"Enter arc name [{suggested}]: ").strip() or suggested
                arc_description = input("Enter arc description: ")
                source_name = input("Enter source name: ")
                target_name = input("Enter target name: ")
                weight_raw = input("Enter weight [1]: ").strip()
                weight = int(weight_raw) if weight_raw else 1
                arc_type = input("Arc type [normal/inhibitor/read] (normal): ").strip() or "normal"
                Petri.add_arc_by_names(
                    arc_name, arc_description, source_name, target_name, weight, arc_type
                )
                print(f"Arc '{arc_name}' added.")

            elif choice == "3":
                suggested = Petri.next_transition_name()
                transition_name = input(f"Enter transition name [{suggested}]: ").strip() or suggested
                transition_description = input("Enter transition description: ")
                Petri.add_transition(Transition(transition_name, transition_description, len(Petri.transitions)))
                print(f"Transition '{transition_name}' added.")

            elif choice == "4":
                place_name = input("Enter place name: ")
                ficha_count = int(input("Enter number of fichas to add (negative to remove): "))
                Petri.add_ficha(place_name, ficha_count)
                print(f"Fichas added to place '{place_name}'.")

            elif choice == "5":
                Petri.show_attributes()

            elif choice == "6":
                path = input("Save to file path: ")
                Petri.save_json(path)
                print(f"Saved to {path}.")

            elif choice == "7":
                path = input("Load from file path: ")
                Petri = PETRI.load_json(path)
                print(f"Loaded '{Petri.name}' from {path}.")

            elif choice == "8":
                print("Exiting...")
                break

            else:
                print("Invalid choice. Please try again.")

        except PetriError as e:
            print(f"Error: {e}")
        except ValueError as e:
            print(f"Error: {e}")
