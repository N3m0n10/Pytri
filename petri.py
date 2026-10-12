"""
Core Petri net data model.

Naming note (kept from the original prototype, mapped to standard / TINA
terminology so the mismatch doesn't trip anyone up later):

    This code        Standard Petri net / TINA term
    ---------        ------------------------------
    State             Place            (holds tokens -> `ficha_count`)
    Action             Transition       (the thing that "fires")
    Transition (class) Arc              (connects a Place <-> Transition)

A Petri net is bipartite: arcs only ever connect a State to an Action, or
an Action to a State. Two States (or two Actions) can never be linked
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


class InvalidTransitionError(PetriError):
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


class Action:
    """A Transition (bar) in the classic Petri net sense."""

    def __init__(self, name: str, description: str, enum=None):
        self.name = name
        self.description = description
        self.enum = enum


class Transition:
    """An Arc between a State and an Action (in either direction).

    side:     read-only, derived from which end is the State. 'pre' means
              State -> Action (an input arc: consumed when the Action
              fires). 'post' means Action -> State (an output arc:
              produced when the Action fires). This isn't stored -- it's
              always recomputed from source/target so it can never drift
              out of sync with the actual arc direction.
    weight:   number of tokens consumed/produced when the arc's Action fires.
    arc_type: 'normal' | 'inhibitor' | 'read'
              inhibitor/read only make sense on the 'pre' side (a Place
              guarding a Transition), since they test a place's marking
              rather than move tokens through the Action.
    """

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
                f"'{arc_type}' arcs only make sense from a State to an Action "
                f"(they guard a transition by testing a place's marking)."
            )
        self.arc_type = arc_type

    @property
    def side(self) -> str:
        """'pre' (State -> Action, an input arc) or 'post' (Action -> State,
        an output arc). Derived from the endpoint types, always correct."""
        return "pre" if isinstance(self.source, State) else "post"


class PETRI:
    """Owns the whole net: its States, Actions and the Transitions (arcs)
    connecting them. Structural validation lives here so that both the CLI
    and any GUI/front-end built on top get the same guarantees for free.
    """

    def __init__(self, name):
        self.name = name
        self.states = {}
        self.transitions = {}
        self.actions = {}
        self.count_t = 0
        # Monotonically increasing counters used only to suggest the next
        # free autoname; they never go backwards even if nodes get deleted,
        # so a suggested name can never collide with one handed out earlier.
        self._next_state_seq = 0
        self._next_action_seq = 0
        self._next_transition_seq = 0
        # handle removed naming
        self._removed_state_names = set()
        self._removed_action_names = set()
        self._removed_transition_names = set()
        # Ctrl Z
        self._history = []
        self._history_matrix = []

    # ---- saving steps -------------------------------------------------- #
    @classmethod
    def _save_step(cls, petri_net: 'PETRI'):
        """Save the current state of the Petri net to the history stack."""
        snapshot = petri_net.to_dict()
        petri_net._history.append(snapshot)

    @classmethod
    def _save_step_matrix(cls, petri_net: 'PETRI'):
        """Save the current state of the Petri net to the history stack."""
        snapshot = [petri_net.incidence_matrix,petri_net.output_matrix]
        petri_net._history_matrix.append(snapshot)

    # ---- simulation hook (unused for now, kept for future work) -------- #
    def add_simulation(self, simulation: 'Simulation'):
        self.simulation = simulation

    def run_simulation(self):
        if hasattr(self, 'simulation'):
            self.simulation.run()
        else:
            print("No simulation has been added to this Petri net.")

    # ---- node lookup ----------------------------------------------------#
    def get_node(self, name: str):
        """Resolve a name to its State or Action object, wherever it lives."""
        if name in self.states:
            return self.states[name]
        if name in self.actions:
            return self.actions[name]
        raise NotFoundError(f"No state or action named '{name}' exists.")

    def _name_taken(self, name: str) -> bool:
        return name in self.states or name in self.actions

    # ---- autonaming -------------------------------------------------------#
    def next_state_name(self) -> str:
        """Suggest an unused name for a new place, e.g. 'p1', 'p2', ..."""
        while True:
            self._next_state_seq += 1
            name = f"p{self._next_state_seq}"
            if not self._name_taken(name):
                return name

    def next_action_name(self) -> str:
        """Suggest an unused name for a new transition, e.g. 't1', 't2', ..."""
        while True:
            self._next_action_seq += 1
            name = f"t{self._next_action_seq}"
            if not self._name_taken(name):
                return name

    def next_transition_name(self) -> str:
        """Suggest an unused name for a new arc, e.g. 'a1', 'a2', ..."""
        while True:
            self._next_transition_seq += 1
            name = f"a{self._next_transition_seq}"
            if name not in self.transitions:
                return name

    # ---- renaming -----------------------------------------------------------#
    def rename_state(self, old_name: str, new_name: str):
        if old_name not in self.states:
            raise NotFoundError(f"State '{old_name}' does not exist.")
        if new_name != old_name and self._name_taken(new_name):
            raise DuplicateNameError(f"'{new_name}' is already in use.")
        if len(old_name) > 1 and old_name[0] == 'p' and old_name[1:].isdigit():
            self._removed_state_names.add(old_name)
        state = self.states.pop(old_name)
        state.name = new_name          # arcs hold a reference to this object,
        self.states[new_name] = state  # so they pick up the new name for free
        return state

    def rename_action(self, old_name: str, new_name: str):
        if old_name not in self.actions:
            raise NotFoundError(f"Action '{old_name}' does not exist.")
        if new_name != old_name and self._name_taken(new_name):
            raise DuplicateNameError(f"'{new_name}' is already in use.")
        if len(old_name) > 1 and old_name[0] == 't' and old_name[1:].isdigit():
            self._removed_action_names.add(old_name)
        action = self.actions.pop(old_name)
        action.name = new_name
        self.actions[new_name] = action
        return action

    def rename_transition(self, old_name: str, new_name: str):
            if old_name not in self.transitions:
                raise NotFoundError(f"Transition '{old_name}' does not exist.")
            if new_name != old_name and self._name_taken(new_name):
                raise DuplicateNameError(f"'{new_name}' is already in use.")
            if len(old_name) > 1 and old_name[0] == 'a' and old_name[1:].isdigit():
                self._removed_transition_names.add(old_name)
            transition = self.transitions.pop(old_name)
            transition.name = new_name
            self.transitions[new_name] = transition
            return transition

    # ---- states (places) ------------------------------------------------#
    def add_state(self, state: 'State'):
        if state.name in self.states:
            raise DuplicateNameError(f"State '{state.name}' already exists.")
        if state.name in self.actions:
            raise DuplicateNameError(
                f"'{state.name}' is already used as an action name; "
                f"state and action names share one namespace and must be unique."
            )
        self.states[state.name] = state
        return state

    def remove_state(self, name: str):
        if name not in self.states:
            raise NotFoundError(f"State '{name}' does not exist.")
        if len(name) > 1 and name[0] == 'p' and name[1:].isdigit():
            self._removed_state_names.add(name)
        for t_name in [t.name for t in self.transitions.values()
                        if t.source.name == name or t.target.name == name]:
            del self.transitions[t_name]
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

    # ---- actions (transitions) ------------------------------------------#
    def add_action(self, action: 'Action'):
        if action.name in self.actions:
            raise DuplicateNameError(f"Action '{action.name}' already exists.")
        if action.name in self.states:
            raise DuplicateNameError(
                f"'{action.name}' is already used as a state name; "
                f"state and action names share one namespace and must be unique."
            )
        self.actions[action.name] = action
        return action

    def remove_action(self, name: str):
        if name not in self.actions:
            raise NotFoundError(f"Action '{name}' does not exist.")
        if len(name) > 1 and name[0] == 'a' and name[1:].isdigit():
            self._removed_action_names.add(name)
        for t_name in [t.name for t in self.transitions.values()
                        if t.source.name == name or t.target.name == name]:
            del self.transitions[t_name]
        del self.actions[name]

    # ---- transitions (arcs) ----------------------------------------------#
    def _validate_endpoints(self, source_name: str, target_name: str):
        state_to_action = source_name in self.states and target_name in self.actions
        action_to_state = source_name in self.actions and target_name in self.states
        if not (state_to_action or action_to_state):
            raise InvalidTransitionError(
                "Petri nets are bipartite: an arc must connect a State to an "
                "Action, or an Action to a State (never State-State or Action-Action)."
            )

    def add_transition(self, transition: 'Transition'):
        self._validate_endpoints(transition.source.name, transition.target.name)
        if transition.name in self.transitions:
            raise DuplicateNameError(f"Transition (arc) '{transition.name}' already exists.")
        for t in self.transitions.values():
            if t.source.name == transition.source.name and t.target.name == transition.target.name:
                raise DuplicateNameError(
                    f"An arc from '{transition.source.name}' to '{transition.target.name}' "
                    f"already exists ('{t.name}')."
                )
        self.transitions[transition.name] = transition
        self.count_t += 1
        return transition

    def add_transition_by_names(self, name: str, description: str,
                                 source_name: str, target_name: str,
                                 weight: int = 1, arc_type: str = "normal"):
        """Convenience wrapper: look up source/target by name and create the arc.
        This is what the CLI and the GUI/API both call."""
        source = self.get_node(source_name)
        target = self.get_node(target_name)
        transition = Transition(name, description, source, target, weight, arc_type)
        return self.add_transition(transition)

    def remove_transition(self, name: str):
        if name not in self.transitions:
            raise NotFoundError(f"Transition (arc) '{name}' does not exist.")
        if len(name) > 1 and name[0] == 't' and name[1:].isdigit():
            self._removed_transition_names.add(name)
        del self.transitions[name]

    # ---- matrix -----------------------------------------------------------
    @property
    def incidence_matrix(self):
        """Returns a 2D matrix: rows = states, cols = transitions.
        Entry [i][j] = +weight if transition j produces into state i,
                    -weight if transition j consumes from state i,
                    0 otherwise.
        """
        states = self.states
        transitions = list(self.transitions.values())
        state_index = {name: i for i, name in enumerate(states)}
        num_states = len(states)
        num_trans = len(transitions)
        ordered_actions = list(self.actions.values())
        num_actions = len(ordered_actions)

        matrix = [[0] * num_trans for _ in range(num_states)]

        for j, tr in enumerate(transitions):
            src_idx = state_index.get(tr.source.name)
            tgt_idx = state_index.get(tr.target.name)

            if src_idx is not None:
                matrix[src_idx][j] -= tr.weight   # tokens consumed
            if tgt_idx is not None:
                matrix[tgt_idx][j] += tr.weight   # tokens produced

        return matrix

    @property
    def output_matrix(self):
        return [state.ficha_count for state in self.states.values()]

    def next_output(self, transition_fired):
        """transition_fired: list/vector of length num_transitions,
        typically a 0/1 firing vector.
        Returns the new marking vector.
        """
        x = self.incidence_matrix   # shape (num_states, num_transitions)
        y = self.output_matrix      # shape (num_states,)
        num_states = len(y)
        num_trans = len(x[0]) if num_states else 0

        if len(transition_fired) != num_trans:
            raise ValueError(
                f"transition_fired has length {len(transition_fired)}, "
                f"expected {num_trans}"
            )

        output = []
        for i in range(num_states):
            delta = sum(x[i][j] * transition_fired[j] for j in range(num_trans))
            output.append(y[i] + delta)

        return output
        
    # ---- inspection -------------------------------------------------------#
    def arcs_of(self, node_name: str):
        """All arcs touching a given State/Action, split into incoming/outgoing."""
        incoming = [t for t in self.transitions.values() if t.target.name == node_name]
        outgoing = [t for t in self.transitions.values() if t.source.name == node_name]
        return {"incoming": incoming, "outgoing": outgoing}

    # ---- Description  ---------------------------------------------#
    @property
    def net_type(self):
        """Return a string describing the net type based on its arcs."""
        """Naming according to TINA"""
        has_inhibitor = any(t.arc_type == "inhibitor" for t in self.transitions.values())
        has_read = any(t.arc_type == "read" for t in self.transitions.values())
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
        all_connected = all((len(t.source) > 0 and len(t.target) > 0) for t in self.transitions.values())
        one_connection_t = any((len(t.source) < 2 and len(t.target) < 2) for t in self.transitions.values())
        pres = [t.source.name for t in self.transitions.values() if isinstance(t.source, State)]
        posts = [t.target.name for t in self.transitions.values() if isinstance(t.target, State)]
        one_connection_s = any((len(t.source) < 2 and len(t.target) < 2) for t in self.transitions.values())
        all_weight_1 = all(t.weight == 1 for t in self.transitions.values())
        has_inhibitor = any(t.arc_type == "inhibitor" for t in self.transitions.values())
        has_read = any(t.arc_type == "read" for t in self.transitions.values())
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
        if any(pres.count(pre) > 1 for pre in set(pres)):
            type_list.append("Free Choice")
            #    type_list.append("Expanded Free Choice") # TODO: annoying
        if any(t.value > 1 for t in self.transitions.values()):
            type_list.append("Generalized")
        # type_list.append("Live")
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
                    fired_vec = [0] * num_trans
                    fired_vec[j] = 1
                    new_marking = _next_output_from_marking(marking, fired_vec)
                    # reject negative markings
                    if any(n < 0 for n in new_marking):
                        continue
                    key = tuple(new_marking)
                    trans_name = _transition_name_by_index(j)
                    # convert per-arc fired vector into per-action fired vector
                    action_vec = [0] * num_actions
                    for arc_idx, val in enumerate(fired_vec):
                        if val:
                            arc = transitions[arc_idx]
                            # determine which action this arc touches
                            action_obj = arc.source if isinstance(arc.source, Action) else arc.target
                            try:
                                a_idx = ordered_actions.index(action_obj)
                                action_vec[a_idx] = 1
                            except ValueError:
                                pass

                    if key in visited:
                        # Already seen -> treat as terminal (record but don't expand)
                        next_level.append((new_marking, action_vec, trans_name, True))
                        continue
                    visited.add(key)
                    next_level.append((new_marking, action_vec, trans_name, False))
            if next_level:
                levels.append(next_level)
            # prepare next iteration: strip markings for BFS frontier
            current_level = [m for m, _, _, _ in next_level]

        return levels
        
    @property
    def tree_test(self):
        """Breadth-first reachability tree: list of levels; each level is a list of marking vectors."""
        root = list(self.output_matrix)
        if len(self.states) == 0:
            return []

        ordered_arcs = list(self.transitions.values())
        ordered_actions = list(self.actions.values())
        num_arcs = len(ordered_arcs)

        # helper: build fired vector that includes all arcs (pre+post) of an action
        def _fired_vec_for_action(action):
            vec = [0] * num_arcs
            for idx, arc in enumerate(ordered_arcs):
                if arc.source == action or arc.target == action:
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
                for action in ordered_actions:
                    # check enabled for this action under `marking`
                    enabled = True
                    for pre in [a for a in ordered_arcs if a.side == 'pre' and a.target == action]:
                        src_idx = state_index.get(pre.source.name)
                        if src_idx is None:
                            enabled = False
                            break
                        tokens = marking[src_idx]
                        if pre.arc_type in ("normal", "read"):
                            if tokens < pre.weight:
                                enabled = False
                                break
                        elif pre.arc_type == "inhibitor":
                            if tokens >= pre.weight:
                                enabled = False
                                break
                    if not enabled:
                        continue

                    fired_vec = _fired_vec_for_action(action)
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
    # enabled action to fire and stepping through time) is still future
    # work. What's here is the net-level firing rule itself: whether an
    # action's preconditions hold, and what firing it does to the marking.
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

    def pre_arcs(self, action_name: str):
        """Input arcs (State -> Action) feeding a given action."""
        if action_name not in self.actions:
            raise NotFoundError(f"Action '{action_name}' does not exist.")
        return [t for t in self.transitions.values()
                if t.target.name == action_name and t.side == "pre"]

    def post_arcs(self, action_name: str):
        """Output arcs (Action -> State) produced by a given action."""
        if action_name not in self.actions:
            raise NotFoundError(f"Action '{action_name}' does not exist.")
        return [t for t in self.transitions.values()
                if t.source.name == action_name and t.side == "post"]

    def is_enabled(self, action_name: str) -> bool:
        """True if every precondition on `action_name` is satisfied by the
        current marking: normal/read arcs need >= weight tokens available,
        inhibitor arcs need FEWER than `weight` tokens present."""
        for t in self.pre_arcs(action_name):
            tokens = t.source.ficha_count
            if t.arc_type in ("normal", "read"):
                if tokens < t.weight:
                    return False
            elif t.arc_type == "inhibitor" and tokens >= t.weight:
                return False
        return True

    def is_enabled_by_matrix(self, output_matrix):
        """Return a list of booleans (per transition) indicating whether
        the transition would be enabled under the provided marking
        vector `output_matrix`.

        This mirrors `is_enabled` but works from a marking vector instead
        of the live `State.ficha_count` values. It respects arc types:
        - `normal`/`read`: requires place tokens >= weight
        - `inhibitor`: requires place tokens < weight

        The function returns a list with one boolean per transition in
        the same order as `self.transitions`.
        """
        # Gather transitions in deterministic order (same as other matrix methods)
        transitions = list(self.transitions.values())
        # Validate input length: expected one token count per state
        num_states = len(self.states)
        if len(output_matrix) != num_states:
            raise ValueError(
                f"output_matrix has length {len(output_matrix)}, expected {num_states}"
            )

        # Map state name -> index into provided output_matrix
        state_index = {name: i for i, name in enumerate(self.states)}

        enabled_list = []
        for tr in transitions:
            enabled = True
            # For each pre-arc (State -> Action), check its guarding condition
            if tr.side == "pre":
                src_idx = state_index.get(tr.source.name)
                if src_idx is None:
                    # malformed net: transition has a State endpoint not in states
                    enabled = False
                else:
                    tokens = output_matrix[src_idx]
                    if tr.arc_type in ("normal", "read"):
                        if tokens < tr.weight:
                            enabled = False
                    elif tr.arc_type == "inhibitor":
                        if tokens >= tr.weight:
                            enabled = False
            else:
                # If the stored Transition object happens to be a post arc
                # (Action -> State) when iterating transitions we still need
                # to check pre-arcs for the action. So compute pre-arcs by
                # scanning the net instead.
                for pre in self.pre_arcs(tr.source.name if isinstance(tr.source, Action) else tr.target.name):
                    # pre is an arc feeding an action; only consider those
                    src_idx = state_index.get(pre.source.name)
                    if src_idx is None:
                        enabled = False
                        break
                    tokens = output_matrix[src_idx]
                    if pre.arc_type in ("normal", "read"):
                        if tokens < pre.weight:
                            enabled = False
                            break
                    elif pre.arc_type == "inhibitor":
                        if tokens >= pre.weight:
                            enabled = False
                            break

            enabled_list.append(enabled)

        return enabled_list
        

    def list_enabled_actions(self):
        """Names of all actions currently enabled under the net's marking."""
        return [name for name in self.actions if self.is_enabled(name)]

    def fire(self, action_name: str):
        """Fire `action_name`: consume tokens along its normal input arcs and
        produce tokens along its output arcs (read/inhibitor arcs never move
        tokens, they only guard). Raises PetriError if not enabled."""
        if not self.is_enabled(action_name):
            raise PetriError(
                f"Action '{action_name}' is not enabled -- a precondition on "
                f"one of its input places is not satisfied."
            )
        for t in self.pre_arcs(action_name):
            if t.arc_type == "normal":
                t.source.ficha_count -= t.weight
        for t in self.post_arcs(action_name):
            t.target.ficha_count += t.weight
        return {name: s.ficha_count for name, s in self.states.items()}

    def show_attributes(self):
        print("----------------------------------")
        print(f"PETRI Net Name: {self.name}")
        print("----------------------------------")
        print("States:")
        for state in self.states.values():
            print(f"  - {state.name}: {state.description} | Fichas: {state.ficha_count}")
        print("----------------------------------")
        print("Actions:")
        for action in self.actions.values():
            print(f"  - {action.name}: {action.description} (enum: {action.enum})")
        print("----------------------------------")
        print("Transitions (arcs):")
        for t in self.transitions.values():
            print(f"  - {t.name}: {t.description} ({t.source.name} -> {t.target.name}) "
                  f"[side={t.side}, weight={t.weight}, type={t.arc_type}]")
        print("----------------------------------")
        table = self.incidence_matrix
        print("Incidence Matrix:")
        print("   " + " ".join(f"{name:>5}" for name in self.transitions))
        for i, state in enumerate(self.states):
            row = table[i * len(self.transitions):(i + 1) * len(self.transitions)]
            print(f"{state:>3} " + " ".join(f"{val:>5}" for val in row))

    def return_attr(self):
        return {"name": self.name, "states": self.states,
                "actions": self.actions, "transitions": self.transitions}

    def EXPORT(self):
        return {"states": self.states, "transitions": self.transitions, "actions": self.actions}

    # ---- persistence -------------------------------------------------------#
    def to_dict(self):
        return {
            "name": self.name,
            "states": [
                {"name": s.name, "description": s.description, "ficha_count": s.ficha_count}
                for s in self.states.values()
            ],
            "actions": [
                {"name": a.name, "description": a.description, "enum": a.enum}
                for a in self.actions.values()
            ],
            "transitions": [
                {
                    "name": t.name, "description": t.description,
                    "source": t.source.name, "target": t.target.name,
                    "weight": t.weight, "arc_type": t.arc_type,
                }
                for t in self.transitions.values()
            ],
        }

    @classmethod
    def from_dict(cls, data: dict):
        net = cls(data["name"])
        for s in data.get("states", []):
            state = State(s["name"], s.get("description", ""))
            state.ficha_count = s.get("ficha_count", 0)
            net.states[state.name] = state
        for a in data.get("actions", []):
            net.actions[a["name"]] = Action(a["name"], a.get("description", ""), a.get("enum"))
        for t in data.get("transitions", []):
            source = net.get_node(t["source"])
            target = net.get_node(t["target"])
            net.transitions[t["name"]] = Transition(
                t["name"], t.get("description", ""), source, target,
                weight=t.get("weight", 1), arc_type=t.get("arc_type", "normal"),
            )
        net.count_t = len(net.transitions)
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
    enabled actions to fire and how to step through time, and that's a
    design choice (interactive stepping? random? priority order? TINA-style
    firing intervals?) left for the actual simulation milestone."""

    def __init__(self, petri_net: PETRI):
        self.petri_net = petri_net

    def run(self):
        pass  # TODO: stepping/scheduling policy

    def next_state(self):
        pass  # TODO: pick + fire the next action per that policy

    def enabled_transitions(self, transition_name: str = None):  
        """With a name: is that one action enabled? Without: list every
        currently-enabled action name."""
        if transition_name is not None:
            return self.petri_net.is_enabled(transition_name)
        return self.petri_net.list_enabled_actions()

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
        print("2. Add Transition (arc)")
        print("3. Add Action")
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
                suggested = Petri.next_transition_name()
                transition_name = input(f"Enter transition (arc) name [{suggested}]: ").strip() or suggested
                transition_description = input("Enter transition description: ")
                source_name = input("Enter source name: ")
                target_name = input("Enter target name: ")
                weight_raw = input("Enter weight [1]: ").strip()
                weight = int(weight_raw) if weight_raw else 1
                arc_type = input("Arc type [normal/inhibitor/read] (normal): ").strip() or "normal"
                Petri.add_transition_by_names(
                    transition_name, transition_description, source_name, target_name, weight, arc_type
                )
                print(f"Transition '{transition_name}' added.")

            elif choice == "3":
                suggested = Petri.next_action_name()
                action_name = input(f"Enter action name [{suggested}]: ").strip() or suggested
                action_description = input("Enter action description: ")
                Petri.add_action(Action(action_name, action_description, len(Petri.actions)))
                print(f"Action '{action_name}' added.")

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
