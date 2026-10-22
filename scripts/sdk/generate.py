#!/usr/bin/env python3
"""Generate executable route builders for Go, TypeScript, Python and Rust.
The input is obtained by walking the live Chi routing tree, not by matching
source strings. Request/response domain schemas are deliberately not invented.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import keyword
import re
import subprocess
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def pascal(value):
    return ''.join(part[:1].upper() + part[1:] for part in re.findall(r'[A-Za-z0-9]+', value))


def words(route):
    parts = [route['method'].lower()]
    for segment in route['path'].strip('/').split('/'):
        if segment.startswith('{'):
            parts += ['by', segment[1:-1]]
        else:
            parts += re.findall(r'[A-Za-z0-9]+', segment)
    return parts


def name(route):
    return ''.join(pascal(part) for part in words(route))


def snake(value):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', value).lower()


def var(value):
    result = re.sub(r'\W', '_', value)
    if keyword.iskeyword(result) or result in ('self', 'client', 'options', 'type', 'match', 'ref', 'move', 'async', 'await'):
        result += '_value'
    return result


def group(route):
    pieces = route['path'].strip('/').split('/')
    return re.sub(r'\W', '_', pieces[1] if len(pieces) > 1 else pieces[0])


def go_route(route):
    n = route['name']
    args = ', '.join(f'{var(p)} string' for p in route['parameters'])
    params = ', '.join(f'"{p}": {var(p)}' for p in route['parameters'])
    data = f'''type {n}Request struct {{
    client *Client
    options CallOptions
}}
func (c *Client) {n}({args}) *{n}Request {{
    return &{n}Request{{client: c, options: CallOptions{{Method: "{route['method']}", Path: "{route['path']}", Params: map[string]string{{{params}}}}}}}
}}
func (r *{n}Request) WithOptions(options CallOptions) *{n}Request {{
    copy := *r
    options.Method = r.options.Method
    options.Path = r.options.Path
    options.Params = cloneParams(r.options.Params)
    copy.options = cloneOptions(options)
    return &copy
}}
func (r *{n}Request) WithQuery(values url.Values) *{n}Request {{
    options := cloneOptions(r.options)
    options.Query = cloneQuery(values)
    return r.WithOptions(options)
}}
func (r *{n}Request) WithHeaders(headers http.Header) *{n}Request {{
    options := cloneOptions(r.options)
    options.Headers = cloneHeaders(headers)
    return r.WithOptions(options)
}}
func (r *{n}Request) WithTimeout(timeout time.Duration) *{n}Request {{
    options := cloneOptions(r.options)
    options.Timeout = timeout
    return r.WithOptions(options)
}}
func (r *{n}Request) Build(ctx context.Context) (*http.Request, error) {{
    return r.client.Build(ctx, cloneOptions(r.options))
}}
func (r *{n}Request) Execute(ctx context.Context) (*Response, error) {{
    return r.client.Execute(ctx, cloneOptions(r.options))
}}
func (r *{n}Request) Decode(ctx context.Context, target any) error {{
    response, err := r.Execute(ctx)
    if err != nil {{
        return err
    }}
    return response.Decode(target)
}}
'''
    if route['method'] in ('POST', 'PUT', 'PATCH', 'DELETE'):
        data += f'''func (r *{n}Request) WithJSON(body any) *{n}Request {{
    options := cloneOptions(r.options)
    options.Body = body
    options.HasJSONBody = true
    options.RawBody = nil
    return r.WithOptions(options)
}}
func (r *{n}Request) WithRaw(body []byte, contentType string) *{n}Request {{
    options := cloneOptions(r.options)
    options.Body = nil
    options.HasJSONBody = false
    options.RawBody = append([]byte{{}}, body...)
    options.ContentType = contentType
    return r.WithOptions(options)
}}
'''
    return data


def ts_route(route):
    n = route['name']
    properties = '\n'.join(f'  readonly {var(p)}: string;' for p in route['parameters'])
    record = ', '.join(f'"{p}": parameters.{var(p)}' for p in route['parameters'])
    default = ' = {}' if not route['parameters'] else ''
    return f'''export interface {n}Parameters {{
{properties}
}}
export class {n}Request extends Endpoint {{
  constructor(client: TransportClient, {"parameters" if route["parameters"] else "_parameters"}: {n}Parameters{default}, options: CallOptions = {{}}) {{
    super(client, "{route['method']}", "{route['path']}", {{{record}}}, copyOptions(options));
  }}
  withOptions(options: CallOptions): {n}Request {{
    const parameters = {{{', '.join(f'{var(p)}: this.params["{p}"]!' for p in route['parameters'])}}};
    return new {n}Request(this.client, parameters, copyOptions({{ ...this.options, ...options }}));
  }}
  withQuery(query: Query): {n}Request {{
    return this.withOptions({{ query }});
  }}
  withHeaders(headers: HeadersInit): {n}Request {{
    return this.withOptions({{ headers }});
  }}
  withTimeout(timeoutMs: number): {n}Request {{
    return this.withOptions({{ timeoutMs }});
  }}
  withSignal(signal: AbortSignal): {n}Request {{
    return this.withOptions({{ signal }});
  }}
}}
'''


def python_route(route):
    n = route['name']
    return f'''class {n}Request(Endpoint):
    method = "{route['method']}"
    path = "{route['path']}"

'''


def rust_route(route):
    n = route['name']
    args = ', '.join(f'{snake(var(p))}: impl Into<String>' for p in route['parameters'])
    if args:
        args = ', ' + args
    params = ', '.join(f'("{p}".to_string(), {snake(var(p))}.into())' for p in route['parameters'])
    return f'''pub type {n}Request = Endpoint;
impl Client {{
    pub fn {snake(n)}(&self{args}) -> {n}Request {{
        let parameters = [{params}].into_iter().collect();
        Endpoint::new(self.clone(), "{route['method']}", "{route['path']}", parameters)
    }}
}}
'''


def outputs(routes):
    grouped = defaultdict(list)
    seen = set()
    for route in routes:
        operation = name(route)
        if operation in seen:
            operation += hashlib.sha256((route['method'] + route['path']).encode()).hexdigest()[:8]
        seen.add(operation)
        route = {**route, 'name': operation}
        grouped[group(route)].append(route)
    output = {}
    ts_exports = []
    ts_imports = []
    ts_properties = []
    py_imports = []
    py_mixins = []
    rust_mods = []
    license = '// SPDX-License-Identifier: AGPL-3.0-only\n// Code generated by scripts/sdk/generate.py; DO NOT EDIT.\n'
    for area, entries in sorted(grouped.items()):
        go = license + 'package zakura\nimport ("context"; "net/http"; "net/url"; "time")\n' + '\n'.join(go_route(r) for r in entries)
        output[f'sdks/go/zakura/{area}.gen.go'] = go
        api = pascal(area) + 'API'
        ts = license + 'import { Client as TransportClient, Endpoint, copyOptions } from "../client.js";\nimport type { CallOptions, Query } from "../client.js";\n'
        ts += '\n'.join(ts_route(r) for r in entries)
        ts += f'export class {api} {{\n  constructor(private readonly client: TransportClient) {{}}\n'
        for r in entries:
            n = r['name']
            args = ', '.join(f'{var(p)}: string' for p in r['parameters'])
            fields = ', '.join(var(p) for p in r['parameters'])
            ts += f'  {n[0].lower()+n[1:]}({args}): {n}Request {{\n    return new {n}Request(this.client, {{{fields}}});\n  }}\n'
        ts += '}\n'
        output[f'sdks/typescript/src/operations/{area}.ts'] = ts
        ts_imports.append(f'import {{ {api} }} from "./operations/{area}.js";')
        ts_exports.append(f'export * from "./operations/{area}.js";')
        ts_properties.append(f'  readonly {area} = new {api}(this);')
        py = '# SPDX-License-Identifier: AGPL-3.0-only\n# Code generated by scripts/sdk/generate.py; DO NOT EDIT.\nfrom __future__ import annotations\nfrom ..client import Endpoint\n\n'
        py += '\n'.join(python_route(r) for r in entries)
        py += f'class {api}:\n'
        for r in entries:
            n = r['name']
            args = ', '.join(f'{var(p)}: str' for p in r['parameters'])
            if args:
                args = ', ' + args
            fields = ', '.join(f'"{p}": {var(p)}' for p in r['parameters'])
            py += f'    def {snake(n)}(self{args}) -> {n}Request:\n        return {n}Request(self, {{{fields}}})\n\n'
        output[f'sdks/python/zakura_sdk/operations/{area}.py'] = py
        py_imports.append(f'from .operations.{area} import {api}')
        py_mixins.append(api)
        rust = license + 'use crate::client::{Client, Endpoint};\n'
        rust += '\n'.join(rust_route(r) for r in entries)
        output[f'sdks/rust/src/operations/{area}.rs'] = rust
        rust_mods += [f'pub mod {area};', f'pub use {area}::*;']
    output['sdks/typescript/src/index.ts'] = license + 'import { Client as TransportClient } from "./client.js";\nexport * from "./client.js";\n' + '\n'.join(ts_imports + ts_exports) + '\nexport class Client extends TransportClient {\n' + '\n'.join(ts_properties) + '\n}\n'
    output['sdks/python/zakura_sdk/__init__.py'] = '# SPDX-License-Identifier: AGPL-3.0-only\n# Code generated by scripts/sdk/generate.py; DO NOT EDIT.\nfrom .client import Client as TransportClient, Response, Request, CallOptions, APIError\n' + '\n'.join(py_imports) + '\n\nclass Client(TransportClient, ' + ', '.join(py_mixins) + '):\n    pass\n'
    output['sdks/python/zakura_sdk/operations/__init__.py'] = '# SPDX-License-Identifier: AGPL-3.0-only\n'
    output['sdks/rust/src/operations/mod.rs'] = license + '\n'.join(rust_mods) + '\n'
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--go', default='go')
    args = parser.parse_args()
    if args.routes:
        routes = json.loads(args.routes.read_text())
    else:
        raw = subprocess.check_output([args.go,'run','./cmd/zakura-route-catalog'],cwd=ROOT/'apps/server',text=True)
        routes = json.loads(raw)
    if len({(r['method'],r['path']) for r in routes}) != len(routes):
        raise SystemExit('duplicate registered operation')
    if not routes:
        raise SystemExit('empty registered route catalog')
    generated = outputs(routes)
    source_roots = ('sdks/go/zakura', 'sdks/typescript/src', 'sdks/python/zakura_sdk', 'sdks/rust/src')
    for source_root in source_roots:
        for existing in (ROOT / source_root).rglob('*'):
            if existing.suffix not in ('.go', '.ts', '.py', '.rs'):
                continue
            relative = existing.relative_to(ROOT).as_posix()
            if relative not in generated and 'Code generated by scripts/sdk/generate.py;' in existing.read_text()[:300]:
                if args.check:
                    raise SystemExit(f'obsolete generated SDK source: {relative}')
                existing.unlink()
    # Format Go and Rust through their canonical formatters, not line-count
    # expansion. TypeScript and Python templates already use normal layout.
    for name, raw in generated.items():
        if name.endswith('.go'):
            raw = subprocess.check_output([str(Path(args.go).with_name('gofmt'))],input=raw,text=True)
        elif name.endswith('.rs'):
            raw = subprocess.check_output(['rustfmt','--edition','2021','--emit','stdout'],input=raw,text=True)
        raw = raw.rstrip() + '\n'
        path = ROOT / name
        if args.check:
            if not path.exists() or path.read_text() != raw:
                raise SystemExit(f'generated SDK differs: {name}')
        else:
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(raw)
    print(f"{'Verified' if args.check else 'Generated'} {len(routes)} operations in four SDKs ({len(generated)} source files)")


if __name__ == '__main__':
    main()
