#!/usr/bin/env python3
"""Independent workflow oracle. No Go subprocesses, copied implementation,
third-party dependencies, live providers, or wall-clock data are involved.

The 128 cases cover 8 graph families x 2 retry modes x 2 priorities x 4
capacity configurations. Analysis uses recursive path enumeration; scheduling
recomputes ready sets and occupancy from interval records at every event.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps/server/internal/workflow/testdata"
MAX_DELAY = 86_400_000

FAMILIES = {
    "chain": [[], [0], [1], [2], [3], [4], [5]],
    "diamonds": [[], [0], [0], [1, 2], [3], [3], [4, 5]],
    "fanout": [[], [0], [0], [0], [0], [0], [0]],
    "fanin": [[], [], [], [], [], [], [0, 1, 2, 3, 4, 5]],
    "disconnected": [[], [0], [1], [], [3], [], []],
    "ladder": [[], [], [0], [1], [0, 2], [1, 3], [4, 5]],
    "forkjoin": [[], [0], [0], [0], [1, 2], [2, 3], [4, 5]],
    "mesh": [[], [], [0, 1], [0], [1, 2], [2, 3], [3, 4, 5]],
}


def retry(node):
    attempts = node.get("maxAttempts", 1) or 1
    failed_time = node.get("timeoutMs", 0) or node["durationMs"]
    base = node.get("backoffMs", 0)
    multiplier = node.get("backoffMultiplier", 2) or 2
    cap = node.get("maxBackoffMs", 0) or MAX_DELAY
    # Direct mathematical series, independently of the iterative Go helper.
    delays = sum(min(base * multiplier**i, cap) for i in range(attempts - 1))
    return node["durationMs"] + (attempts - 1) * failed_time + delays


def reference(req):
    nodes = {node["id"]: node for node in req["definition"]["nodes"]}
    opts = req["options"]
    ids = sorted(nodes)
    parents = {id_: nodes[id_].get("dependsOn", []) for id_ in ids}
    children = {id_: [child for child in ids if id_ in parents[child]] for id_ in ids}
    costs = {id_: nodes[id_].get("costMicros", 0) * (nodes[id_].get("maxAttempts", 1) if opts["mode"] == "retryBound" else 1) for id_ in ids}
    durations = {id_: retry(nodes[id_]) if opts["mode"] == "retryBound" else nodes[id_]["durationMs"] for id_ in ids}

    @lru_cache(None)
    def paths_from(id_):
        return [(id_,) + path for child in children[id_] for path in paths_from(child)] or [(id_,)]

    @lru_cache(None)
    def paths_to(id_):
        return [path + (id_,) for parent in parents[id_] for path in paths_to(parent)] or [(id_,)]

    roots = [id_ for id_ in ids if not parents[id_]]
    sinks = [id_ for id_ in ids if not children[id_]]
    all_paths = [path for root in roots for path in paths_from(root)]
    lengths = {path: sum(durations[id_] for id_ in path) for path in all_paths}
    critical_ms = max(lengths.values())
    critical_path = list(min(path for path in all_paths if lengths[path] == critical_ms))
    tails = {id_: max(sum(durations[x] for x in path) for path in paths_from(id_)) for id_ in ids}
    earliest_finish = {id_: max(sum(durations[x] for x in path) for path in paths_to(id_)) for id_ in ids}
    levels = {id_: max(len(path) - 1 for path in paths_to(id_)) for id_ in ids}
    layers = [[id_ for id_ in ids if levels[id_] == level] for level in range(max(levels.values()) + 1)]
    metrics = []
    for id_ in ids:
        early = earliest_finish[id_] - durations[id_]
        latest = critical_ms - tails[id_]
        metrics.append({
            "id": id_, "durationMs": durations[id_], "retryBoundMs": retry(nodes[id_]),
            "costMicros": costs[id_], "earliestStartMs": early,
            "earliestFinishMs": earliest_finish[id_], "latestStartMs": latest,
            "slackMs": latest - early, "tailMs": tails[id_], "level": levels[id_],
            "critical": latest == early,
        })
    total_work = sum(durations.values())
    work = {}
    for id_ in ids:
        for resource, units in nodes[id_].get("resources", {}).items():
            work[resource] = work.get(resource, 0) + units * durations[id_]
    resource_bounds = {key: (value + opts["resources"][key] - 1) // opts["resources"][key] for key, value in work.items()}
    parallel_bound = (total_work + opts["maxParallel"] - 1) // opts["maxParallel"]
    analysis = {"nodes": metrics, "roots": roots, "sinks": sinks,
                "criticalPath": critical_path, "criticalPathMs": critical_ms,
                "totalWorkMs": total_work, "totalCostMicros": sum(costs.values()),
                "parallelLowerBoundMs": parallel_bound, "resourceLowerBoundsMs": resource_bounds}

    time = 0
    slots = []
    ends = {}
    active = {}
    started = set()
    peak_parallel = 0
    peak_resources = {}
    while len(ends) < len(ids):
        ready = [id_ for id_ in ids if id_ not in started and all(parent in ends for parent in parents[id_])]
        ready.sort(key=lambda id_: (-tails[id_], id_) if opts["priority"] == "criticalPath" else (id_,))
        for id_ in ready:
            if len(active) >= opts["maxParallel"]:
                continue
            resources = nodes[id_].get("resources", {})
            # Reconstruct resource occupancy and group membership from active
            # nodes, rather than mutating counters as the implementation does.
            occupied = {}
            groups = {}
            for running in active:
                for key, units in nodes[running].get("resources", {}).items():
                    occupied[key] = occupied.get(key, 0) + units
                group = nodes[running].get("concurrencyKey", "")
                if group:
                    groups[group] = groups.get(group, 0) + 1
            if any(occupied.get(key, 0) + units > opts["resources"][key] for key, units in resources.items()):
                continue
            group = nodes[id_].get("concurrencyKey", "")
            if group and groups.get(group, 0) >= opts["concurrencyLimits"][group]:
                continue
            ready_at = max((ends[parent] for parent in parents[id_]), default=0)
            slot = {"nodeId": id_, "startMs": time, "endMs": time + durations[id_],
                    "waitMs": time - ready_at, "resources": resources.copy()}
            if group:
                slot["concurrencyKey"] = group
            slots.append(slot)
            started.add(id_)
            active[id_] = slot["endMs"]
            peak_parallel = max(peak_parallel, len(active))
            for key, units in resources.items():
                peak_resources[key] = max(peak_resources.get(key, 0), occupied.get(key, 0) + units)
        if not active:
            raise AssertionError("Unschedulable oracle input")
        time = min(active.values())
        ended = [id_ for id_ in active if active[id_] == time]
        for id_ in ended:
            ends[id_] = active.pop(id_)
    lower = max([critical_ms, parallel_bound, *resource_bounds.values()])
    return {"order": [id_ for layer in layers for id_ in layer], "layers": layers,
            "analysis": analysis, "slots": slots, "makespanMs": time,
            "peakParallel": peak_parallel, "peakResources": peak_resources,
            "withinBudget": opts["budgetMicros"] == 0 or sum(costs.values()) <= opts["budgetMicros"],
            "withinDeadline": opts["deadlineMs"] == 0 or time <= opts["deadlineMs"],
            "optimal": time == lower}


def family_cases(name, shape, family_index):
    cases = []
    for mode in ["nominal", "retryBound"]:
        for priority in ["criticalPath", "id"]:
            for config in range(4):
                nodes = []
                for i, deps in enumerate(shape):
                    node = {"id": f"n{i}", "name": f"{name} task {i}",
                            "kind": ["agent", "tool", "checkpoint"][i % 3],
                            "dependsOn": [f"n{parent}" for parent in deps],
                            "durationMs": 10 + ((i * 17 + family_index * 23) % 67),
                            "costMicros": 1000 + i * 301 + family_index * 97,
                            "maxAttempts": 1 + (i + family_index) % 4,
                            "backoffMs": (i * 3 + family_index) % 11,
                            "backoffMultiplier": 1 + i % 4,
                            "maxBackoffMs": [0, 7, 20][i % 3],
                            "resources": {}}
                    if i % 3 != 2:
                        node["timeoutMs"] = node["durationMs"] + 13
                    if i % 2 == 0:
                        node["resources"]["cpu"] = 1 + i % 2
                    if i % 3 == 1:
                        node["resources"]["model"] = 1
                    if i % 3 == 0:
                        node["concurrencyKey"] = "exclusive"
                    nodes.append(node)
                # Different input orders verify canonical ordering independently
                # of authoring order, especially for disconnected components.
                if config % 2:
                    nodes.reverse()
                    for node in nodes:
                        node["dependsOn"].reverse()
                opts = {"maxParallel": [1, 2, 3, 6][config],
                        "resources": {"cpu": [1, 1, 2, 4][config], "model": [1, 2, 1, 3][config]},
                        "concurrencyLimits": {"exclusive": [1, 1, 2, 3][config]},
                        "mode": mode, "priority": priority,
                        "budgetMicros": [0, 10000, 20000, 100000][config],
                        "deadlineMs": [0, 150, 300, 1000][config]}
                request = {"definition": {"version": 1, "name": f"{name} {config}", "nodes": nodes}, "options": opts}
                cases.append({"name": f"{name}-{mode}-{priority}-capacity{config}", "request": request, "expected": reference(request)})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify checked-in corpus without writing")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    for index, (name, shape) in enumerate(FAMILIES.items()):
        content = json.dumps(family_cases(name, shape, index), ensure_ascii=False, indent=2) + "\n"
        destination = OUT / f"{name}.json"
        if args.check:
            if not destination.exists() or destination.read_text() != content:
                raise SystemExit(f"Corpus differs: {destination.relative_to(ROOT)}")
        else:
            destination.write_text(content)
        entries.append((destination.name, content.count("\n"), hashlib.sha256(content.encode()).hexdigest()))
    print(f"{'Verified' if args.check else 'Generated'} 128 independent oracle cases; {sum(lines for _, lines, _ in entries):,} corpus lines")
    for name, lines, digest in entries:
        print(f"{name}: {lines} lines, sha256 {digest}")


if __name__ == "__main__":
    main()
