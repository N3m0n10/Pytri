import json
from petri import PETRI


def run_from_json(path):
    net = PETRI.load_json(path)
    tree = net.tree_mtrx()
    print(f"Tree (matrix view) for net loaded from {path}:")
    for level_idx, level in enumerate(tree):
        print(f"Level {level_idx}:")
        for marking, fired, trans_name, terminal in level:
            m_str = "[" + " ".join(str(x) for x in marking) + "]"
            f_str = "[" + " ".join(str(x) for x in fired) + "]"
            term = "TERMINAL" if terminal else ""
            print(f"  - x = {m_str}, t = {f_str}, tr = {trans_name} {term}")


if __name__ == '__main__':
    run_from_json('/media/regular_capivara/HD - COMUM/COMUM/VSCODE/Pytri/Example_Net.json')