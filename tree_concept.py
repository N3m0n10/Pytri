import numpy

incidence_matrix = numpy.array([[1, 0, 0], [-1, 1, 0], [0, 1, -1], [-1, 0, 1]], dtype=int)
output = numpy.array([1, 0, 0], dtype=int)

def new_output(incidence_matrix, output, fired_vec):
    return numpy.dot(fired_vec,incidence_matrix) + output

def active_transitions(incidence_matrix, output):
    results = {}
    num_transitions = incidence_matrix.shape[0]
    for i in range(num_transitions):
        add = True
        n_out = numpy.zeros(num_transitions)
        n_out[i] = 1
        n_output = new_output(incidence_matrix, output, n_out)
        for j in range(len(output)):
            if n_output[j] < 0:
                add = False
                break
        if add:
            results[f"{i}"] = n_output # like {0: [2,1,3], 1: [0,0,0], 2: [0,2,1]}
    return results

def is_multiple_of(vec1, vec2):
    for v1,v2 in zip(vec1, vec2):
        if v2 == 0:
            if v1 != 0:
                return False
        else:
            if v1 % v2 != 0:
                return False
    return True

def tree(incidence_matrix, output):
    tree = []
    initial_marking = numpy.asarray(output, dtype=float).copy()
    next_node_id = 1
    current_level = [(0, None, "", initial_marking, [initial_marking])]
    while current_level:
        tree.append([
            (node_id, parent_id, transition, marking)
            for node_id, parent_id, transition, marking, _ in current_level
        ])
        next_level = []
        for node_id, _, _, marking, ancestors in current_level:
            transitions = active_transitions(incidence_matrix, marking)
            for transition, new_marking in transitions.items():
                accelerated = new_marking.astype(float)
                changed = True
                while changed:
                    changed = False
                    for ancestor in ancestors:
                        if numpy.all(accelerated >= ancestor):
                            increased = (accelerated > ancestor) & ~numpy.isinf(accelerated)
                            if numpy.any(increased):
                                accelerated[increased] = numpy.inf
                                changed = True
                if any(numpy.array_equal(accelerated, ancestor) for ancestor in ancestors):
                    continue
                next_level.append((
                    next_node_id,
                    node_id,
                    transition,
                    accelerated,
                    ancestors + [accelerated],
                ))
                next_node_id += 1
        current_level = next_level
    return tree

"""
Accumulation [w]:
if pos n-1 has equal or bigger values for all making (wich increases),
then the marking is an accumulation of the previous one, them the tree 
should add w to the accumulated value, and do not add the same transition
in this line.
"""

print("Incidence Matrix:")
print(incidence_matrix)
print("Initial Output:")
print(output)
result_tree = tree(incidence_matrix, output)
print("Generated Tree of Markings:")
for level_idx, level in enumerate(result_tree):
    print(f"Level {level_idx}:")
    for node_id, parent_id, transition, marking in level:
        values = " ".join("w" if numpy.isinf(x) else str(int(x)) for x in marking)
        father = "-" if parent_id is None else str(parent_id)
        print(f"  - node {node_id}, father {father}, transition {transition}: x = [{values}]")