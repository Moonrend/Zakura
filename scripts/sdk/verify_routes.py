#!/usr/bin/env python3
"""Compile and execute every SDK builder against the server's route catalog.
No fixture is checked in: the server provides the expected verbs and paths.
The temporary language-specific probes are removed even after a failed check.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote
from generate import ROOT, name, snake, group


def run(command, cwd):
    subprocess.run(command, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes', type=Path, required=True)
    parser.add_argument('--go', default='go')
    args = parser.parse_args()
    routes = json.loads(args.routes.read_text())
    if not routes:
        raise SystemExit('empty route catalog')
    seen = set()
    cases = []
    for route in routes:
        operation = name(route)
        if operation in seen:
            operation += hashlib.sha256((route['method'] + route['path']).encode()).hexdigest()[:8]
        seen.add(operation)
        values = [f'value{index} 猫/%?' for index, _ in enumerate(route['parameters'])]
        bindings = dict(zip(route['parameters'], values))
        path = re.sub(r'\{([^}]+)\}', lambda match: quote(bindings[match[1]], safe=''), route['path'])
        cases.append((route, operation, values, path))

    sys.path.insert(0, str(ROOT / 'sdks/python'))
    sdk = importlib.import_module('zakura_sdk')
    client = sdk.Client('https://sdk.invalid')
    for route, operation, values, path in cases:
        request = getattr(client, snake(operation))(*values).build()
        assert request.method == route['method'] and request.url == 'https://sdk.invalid' + path, (operation, request)
    print(f'Python: verified {len(cases)} callable route builders', flush=True)

    go = 'package zakura\nimport("context";"net/http";"testing")\nfunc TestLiveRouteContract(t *testing.T){\nc,err:=NewClient(Config{BaseURL:"https://sdk.invalid"});if err!=nil{t.Fatal(err)}\nctx:=context.Background()\n'
    ts = 'import assert from "node:assert/strict";\nimport { Client } from "../src/index.js";\nconst client=new Client({baseURL:"https://sdk.invalid"});\n'
    rust = 'use zakura_sdk::{Client, Config};\n#[test]\nfn live_route_contract(){let client=Client::new(Config::new("https://sdk.invalid")).unwrap();\n'
    for route, operation, values, path in cases:
        arguments = ', '.join(json.dumps(value, ensure_ascii=False) for value in values)
        expected_method = json.dumps(route['method'])
        expected_path = json.dumps(path)
        expected_url = json.dumps('https://sdk.invalid' + path)
        go += f'{{r,e:=c.{operation}({arguments}).Build(ctx);checkRoute(t,r,e,{expected_method},{expected_path})}}\n'
        method = operation[0].lower() + operation[1:]
        ts += f'{{const r=await client.{group(route)}.{method}({arguments}).build();assert.equal(r.method,{expected_method});assert.equal(r.url,{expected_url});}}\n'
        rust += f'{{let r=client.{snake(operation)}({arguments}).build().unwrap();assert_eq!(r.method,{expected_method});assert_eq!(r.url,{expected_url});}}\n'
    go += '}\nfunc checkRoute(t *testing.T,r *http.Request,e error,method,path string){t.Helper();if e!=nil{t.Fatal(e)};if r.Method!=method||r.URL.EscapedPath()!=path{t.Fatalf("route mismatch: %s %s; expected %s %s",r.Method,r.URL.EscapedPath(),method,path)}}\n'
    ts += f'console.log("TypeScript: verified {len(cases)} callable route builders");\n'
    rust += '}\n'
    probes = {
        ROOT / 'sdks/go/zakura/route_contract_probe_test.go': go,
        ROOT / 'sdks/typescript/test/route_contract_probe.ts': ts,
        ROOT / 'sdks/rust/tests/route_contract_probe.rs': rust,
    }
    if any(path.exists() for path in probes):
        raise SystemExit('refusing to overwrite an existing route probe')
    try:
        for path, content in probes.items():
            path.write_text(content)
        run([args.go, 'test', './zakura', '-run', '^TestLiveRouteContract$', '-count=1'], ROOT / 'sdks/go')
        run(['node', '--import', 'tsx', 'test/route_contract_probe.ts'], ROOT / 'sdks/typescript')
        run(['cargo', 'test', '--locked', '--test', 'route_contract_probe'], ROOT / 'sdks/rust')
    finally:
        for path in probes:
            path.unlink(missing_ok=True)
    print(f'Verified all {len(cases)} registered operations in all four SDKs', flush=True)


if __name__ == '__main__':
    main()
