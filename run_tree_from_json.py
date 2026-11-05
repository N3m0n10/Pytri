import argparse
import json
from petri import PETRI


def run_from_json(path, max_levels=10):
    net = PETRI.load_json(path)
    tree, truncated = net.coverability_tree(max_levels=max_levels)
    print(f"Coverability tree for net loaded from {path}:")
    for level_idx, level in enumerate(tree):
        print(f"Level {level_idx}:")
        for marking, fired, trans_name, terminal in level:
            m_str = "[" + " ".join(str(x) for x in marking) + "]"
            f_str = "[" + " ".join(str(x) for x in fired) + "]"
            term = "TERMINAL" if terminal else ""
            print(f"  - x = {m_str}, t = {f_str}, tr = {trans_name} {term}")
    if truncated:
        print(f"Coverability tree truncated at {max_levels} levels.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Print a Petri net coverability tree.")
    parser.add_argument("path", nargs="?", default="Example_Net.json")
    parser.add_argument("--max-levels", type=int, default=10)
    args = parser.parse_args()
    run_from_json(args.path, args.max_levels)