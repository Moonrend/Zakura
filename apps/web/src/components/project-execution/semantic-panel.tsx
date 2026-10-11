"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  friendlyError,
  getArtifactFile,
  type FilePreview,
  type Task,
} from "@/lib/project-execution";
import {
  compareSemantic,
  semanticFile,
  semanticSearch,
  semanticSummary,
  semanticSymbol,
  type SemanticComparison,
  type SemanticFile,
  type SemanticNavigation,
  type SemanticSearch,
  type SemanticSummary,
  type SemanticSymbol,
  type SourceRange,
} from "@/lib/project-workbench";
import { Code, ErrorNotice, Field, NativeSelect, Panel } from "./shared";

function SymbolList({
  symbols,
  onSelect,
}: {
  symbols: SemanticSymbol[];
  onSelect: (symbol: SemanticSymbol) => void;
}) {
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-card">
          <tr>
            <th className="p-2">符号</th>
            <th className="p-2">类型 / 证据</th>
            <th className="p-2">位置</th>
          </tr>
        </thead>
        <tbody>
          {symbols.map((symbol) => (
            <tr key={symbol.id} className="border-t">
              <td className="p-2">
                <button
                  type="button"
                  className="break-all text-left font-medium text-primary underline"
                  onClick={() => onSelect(symbol)}
                >
                  {symbol.receiver ? `${symbol.receiver}.` : ""}
                  {symbol.name}
                </button>
                <p className="mt-1 max-w-lg break-all font-mono text-muted-foreground">
                  {symbol.signature}
                </p>
              </td>
              <td className="p-2">
                {symbol.kind}
                {symbol.exported ? " · 导出" : ""}
                <p className="mt-1 text-muted-foreground">
                  {symbol.confidence}
                </p>
              </td>
              <td className="break-all p-2">
                {symbol.path}:{symbol.selection.start.line}:
                {symbol.selection.start.column}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!symbols.length && (
        <p className="p-2 text-sm text-muted-foreground">
          没有匹配符号；检查索引完整性和语言支持范围。
        </p>
      )}
    </div>
  );
}

function SourceView({
  file,
  selected,
}: {
  file: FilePreview;
  selected: SourceRange | null;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const startLine = selected?.start.line;
  useEffect(() => {
    if (startLine)
      scroll.current
        ?.querySelector(`[data-line="${startLine}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [startLine, file.path]);
  const truncated =
    new TextEncoder().encode(file.content ?? "").length < file.size;
  return (
    <div>
      <p className="mb-2 break-all text-xs text-muted-foreground">
        {file.path} · {file.size.toLocaleString()} 字节
        {truncated ? " · 预览已截断，位置可能超出可见内容" : ""}
      </p>
      {file.base64 ? (
        <p className="text-sm text-muted-foreground">
          二进制内容不支持源代码定位。
        </p>
      ) : (
        <div
          ref={scroll}
          className="max-h-[550px] overflow-auto rounded-lg bg-muted/50 py-2 font-mono text-xs"
        >
          {file.content.split("\n").map((line, i) => {
            const n = i + 1;
            const active =
              selected && n >= selected.start.line && n <= selected.end.line;
            return (
              <div
                key={i}
                data-line={n}
                className={`flex min-w-max ${active ? "bg-amber-200/30" : ""}`}
              >
                <span className="sticky left-0 mr-4 w-12 shrink-0 bg-muted px-2 text-right text-muted-foreground">
                  {n}
                </span>
                <span className="whitespace-pre pr-4">{line || " "}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SemanticPanel({
  projectId,
  tasks,
  baseSnapshot = "",
  initialSnapshot = "",
}: {
  projectId: string;
  tasks: Task[];
  baseSnapshot?: string;
  initialSnapshot?: string;
}) {
  const choices = [
    ...new Set(
      [baseSnapshot, ...tasks.map((task) => task.snapshotId)].filter(Boolean),
    ),
  ];
  const [snapshot, setSnapshot] = useState(
    initialSnapshot || choices.at(-1) || "",
  );
  const [summary, setSummary] = useState<SemanticSummary | null>(null);
  const [search, setSearch] = useState<SemanticSearch | null>(null);
  const [query, setQuery] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [kind, setKind] = useState("");
  const [exported, setExported] = useState(false);
  const [file, setFile] = useState<SemanticFile | null>(null);
  const [navigation, setNavigation] = useState<SemanticNavigation | null>(null);
  const [source, setSource] = useState<FilePreview | null>(null);
  const [selectedRange, setSelectedRange] = useState<SourceRange | null>(null);
  const [before, setBefore] = useState(baseSnapshot);
  const [after, setAfter] = useState(choices.at(-1) ?? "");
  const [comparison, setComparison] = useState<SemanticComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!snapshot && choices.length) setSnapshot(choices.at(-1)!);
  }, [snapshot, choices.join("|")]);
  useEffect(() => {
    generation.current++;
    setSummary(null);
    setSearch(null);
    setFile(null);
    setNavigation(null);
    setSource(null);
    setSelectedRange(null);
  }, [snapshot]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const openFile = async (path: string, range: SourceRange | null = null) => {
    const current = generation.current;
    const [file, source] = await Promise.all([
      semanticFile(projectId, snapshot, path),
      getArtifactFile(projectId, { snapshotId: snapshot }, path),
    ]);
    if (current !== generation.current) return;
    setFile(file);
    setSource(source);
    setSelectedRange(range);
  };
  const selectSymbol = (symbol: SemanticSymbol) =>
    void act(async () => {
      const current = generation.current;
      const navigation = await semanticSymbol(projectId, snapshot, symbol.id);
      if (current !== generation.current) return;
      setNavigation(navigation);
      await openFile(symbol.path, symbol.selection);
    });
  const analyze = async () => {
    const current = generation.current;
    const result = await semanticSummary(projectId, snapshot);
    if (current === generation.current) setSummary(result);
  };
  const filteredFiles = (summary?.files ?? []).filter(
    (file) => !pathFilter || file.path.includes(pathFilter),
  );
  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      <Panel
        title="不可变代码语义"
        description="Go 使用 AST，其他支持语言使用明确标注的词法证据。分析只读取冻结产物，不执行源代码或安装依赖。"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="分析快照">
            <Input
              list="semantic-snapshot-options"
              className="min-w-64"
              value={snapshot}
              onChange={(e) => setSnapshot(e.target.value)}
            />
            <datalist id="semantic-snapshot-options">
              {choices.map((id) => (
                <option key={id} value={id}>
                  {tasks.find((task) => task.snapshotId === id)?.spec.title ||
                    "轮次基线"}
                </option>
              ))}
            </datalist>
          </Field>
          <Button
            disabled={busy || !snapshot}
            onClick={() => void act(analyze)}
          >
            构建只读语义索引
          </Button>
        </div>
        {summary && (
          <div className="mt-4 space-y-2">
            <p className="text-sm">
              {summary.indexedFiles} 个文件 · {summary.symbols} 个符号 ·{" "}
              {summary.references} 个引用 · 跳过 {summary.skippedFiles} 文件
            </p>
            <p
              className={`text-xs ${summary.complete ? "text-muted-foreground" : "text-amber-600"}`}
            >
              {summary.complete
                ? "在当前支持范围和资源限制内索引完整"
                : "索引不完整；缺失结果不能证明文件、引用或 API 不存在"}
            </p>
            {summary.limitations.map((notice, i) => (
              <p className="text-xs text-muted-foreground" key={i}>
                {notice}
              </p>
            ))}
            {summary.cycles.length > 0 && (
              <div className="rounded border border-amber-500/30 p-3 text-xs">
                {summary.cycles.map((cycle, i) => (
                  <p key={i}>依赖循环：{cycle.files.join(" → ")}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </Panel>
      <Panel title="符号查找与引用定位">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="符号名称或查询">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          </Field>
          <Field label="文件路径筛选">
            <Input
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
            />
          </Field>
          <Field label="符号类型">
            <NativeSelect
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">全部类型</option>
              {[
                "function",
                "method",
                "type",
                "variable",
                "constant",
                "class",
                "interface",
              ].map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={exported}
              onChange={(e) => setExported(e.target.checked)}
            />
            仅导出符号
          </label>
          <Button
            variant="outline"
            disabled={busy || !snapshot}
            onClick={() =>
              void act(async () => {
                const current = generation.current;
                const result = await semanticSearch(projectId, snapshot, {
                  q: query,
                  path: pathFilter,
                  kind,
                  exportedOnly: exported,
                });
                if (current === generation.current) setSearch(result);
              })
            }
          >
            搜索冻结产物
          </Button>
        </div>
        {search && (
          <div className="mt-4">
            <p className="mb-2 text-xs text-muted-foreground">
              匹配 {search.total} 项
              {search.truncated
                ? " · 本页达到上限，使用筛选缩小范围或加载下一页"
                : ""}
            </p>
            <SymbolList
              symbols={search.symbols ?? []}
              onSelect={selectSymbol}
            />
            {search.truncated && (
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const next = await semanticSearch(projectId, snapshot, {
                      q: query,
                      path: pathFilter,
                      kind,
                      exportedOnly: exported,
                      offset: search.symbols.length,
                    });
                    setSearch({
                      ...next,
                      symbols: [...search.symbols, ...next.symbols],
                    });
                  })
                }
              >
                加载更多符号
              </Button>
            )}
          </div>
        )}
      </Panel>
      {(summary || file) && (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(220px,0.6fr)_minmax(0,1.7fr)]">
          <Panel title="索引文件">
            <div className="max-h-[650px] space-y-1 overflow-auto">
              {filteredFiles.map((entry) => (
                <button
                  key={entry.path}
                  className={`block w-full break-all rounded border p-2 text-left text-xs ${file?.file.path === entry.path ? "border-primary" : "hover:bg-muted"}`}
                  onClick={() => void act(() => openFile(entry.path))}
                >
                  {entry.path}
                  <p className="mt-1 text-muted-foreground">
                    {entry.language} · {entry.status} · {entry.symbols} 个符号
                    {entry.test ? " · 测试" : ""}
                    {entry.generated ? " · 生成文件" : ""}
                  </p>
                </button>
              ))}
            </div>
          </Panel>
          <div className="space-y-4">
            {source && (
              <Panel
                title="快照源代码"
                description="行号与 Unicode 列号由服务器索引给出；点击引用可定位到同一冻结快照。"
              >
                <SourceView file={source} selected={selectedRange} />
              </Panel>
            )}
            {file && (
              <Panel title="文件符号与依赖">
                {file.truncated && (
                  <p className="mb-3 text-xs text-amber-600">
                    文件详情达到输出上限：共 {file.totalSymbols} 个符号、
                    {file.totalReferences} 个引用、{file.totalImports}{" "}
                    个导入。列表不完整，可使用符号搜索缩小范围。
                  </p>
                )}
                <SymbolList
                  symbols={file.file.symbols ?? []}
                  onSelect={selectSymbol}
                />
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-medium">引用的文件</h3>
                    {file.dependencies.map((edge, i) => (
                      <button
                        key={i}
                        className="mb-1 block break-all text-left text-xs text-primary underline"
                        onClick={() => void act(() => openFile(edge.to))}
                      >
                        {edge.to} · {edge.confidence}
                      </button>
                    ))}
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-medium">依赖此文件</h3>
                    {file.dependents.map((edge, i) => (
                      <button
                        key={i}
                        className="mb-1 block break-all text-left text-xs text-primary underline"
                        onClick={() => void act(() => openFile(edge.from))}
                      >
                        {edge.from} · {edge.confidence}
                      </button>
                    ))}
                  </div>
                </div>
                {file.file.imports.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm">
                      导入与解析范围
                    </summary>
                    {file.file.imports.map((entry, i) => (
                      <p className="mt-2 break-all text-xs" key={i}>
                        {entry.name} {entry.path} · {entry.confidence} ·{" "}
                        {entry.targets.length
                          ? entry.targets.join(", ")
                          : "外部或未解析"}
                      </p>
                    ))}
                  </details>
                )}
                {file.file.diagnostics.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm">
                      解析诊断
                    </summary>
                    <Code value={file.file.diagnostics} />
                  </details>
                )}
              </Panel>
            )}
            {navigation && (
              <Panel
                title={`${navigation.symbol.name} 的引用`}
                description={`匹配 ${navigation.total} 处${navigation.truncated ? "，列表已截断" : ""}；ambiguous 与 lexical 表示有限证据，不代表类型检查结论。`}
              >
                <div className="space-y-2">
                  {navigation.references.map((reference, i) => (
                    <button
                      type="button"
                      key={i}
                      className="block w-full rounded border p-2 text-left text-xs hover:bg-muted"
                      onClick={() =>
                        void act(() =>
                          openFile(reference.path, reference.range),
                        )
                      }
                    >
                      {reference.path}:{reference.range.start.line}:
                      {reference.range.start.column} · {reference.kind} ·{" "}
                      {reference.confidence}
                    </button>
                  ))}
                  {!navigation.references.length && (
                    <p className="text-sm text-muted-foreground">
                      当前索引没有找到引用。
                    </p>
                  )}
                </div>
              </Panel>
            )}
          </div>
        </div>
      )}
      <Panel
        title="API 变化与影响分析"
        description="比较同一项目的两个不可变快照，列出破坏性变化、需审核变化、反向依赖和相关测试建议。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="变化前快照">
            <Input
              list="semantic-snapshot-options"
              value={before}
              onChange={(e) => {
                setBefore(e.target.value);
                setComparison(null);
              }}
            />
          </Field>
          <Field label="变化后快照">
            <Input
              list="semantic-snapshot-options"
              value={after}
              onChange={(e) => {
                setAfter(e.target.value);
                setComparison(null);
              }}
            />
          </Field>
        </div>
        <Button
          className="mt-3"
          variant="outline"
          disabled={busy || !before || !after || before === after}
          onClick={() =>
            void act(async () =>
              setComparison(await compareSemantic(projectId, before, after)),
            )
          }
        >
          比较 API 与依赖影响
        </Button>
        {comparison && (
          <div className="mt-4 space-y-4">
            <p className="text-sm">
              {comparison.changes.length} 个文件变化 ·{" "}
              {comparison.apiChanges.length} 项 API 变化 ·{" "}
              {comparison.impacted.length} 个受影响文件
            </p>
            {comparison.truncated && (
              <p className="text-xs text-amber-600">
                显示已截断；完整计数：文件变化 {comparison.counts.changes}、API
                变化 {comparison.counts.apiChanges}、影响文件{" "}
                {comparison.counts.impacted}、相关测试{" "}
                {comparison.counts.relatedTests}。
              </p>
            )}
            {!comparison.complete && (
              <p className="text-sm text-amber-600">
                比较结果不完整，不应据此断言没有破坏性变化。
              </p>
            )}
            {comparison.limitations.map((text, i) => (
              <p className="text-xs text-muted-foreground" key={i}>
                {text}
              </p>
            ))}
            <div className="space-y-2">
              {comparison.apiChanges.map((change, i) => (
                <div className="rounded border p-3" key={i}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${change.classification === "breaking" ? "bg-destructive/10 text-destructive" : change.classification === "additive" ? "bg-green-500/10 text-green-600" : "bg-amber-500/10 text-amber-600"}`}
                    >
                      {change.classification}
                    </span>
                    <strong className="break-all text-sm">{change.key}</strong>
                    <span className="text-xs text-muted-foreground">
                      {change.confidence}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">{change.reason}</p>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <Code
                      value={
                        change.before
                          .map((symbol) => symbol.signature)
                          .join("\n") || "[无旧 API]"
                      }
                    />
                    <Code
                      value={
                        change.after
                          .map((symbol) => symbol.signature)
                          .join("\n") || "[无新 API]"
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium">依赖影响链</h3>
                {comparison.impacted.map((impact, i) => (
                  <div className="mb-2 rounded border p-2 text-xs" key={i}>
                    <strong className="break-all">{impact.path}</strong>
                    <p className="mt-1">
                      {impact.reason} · {impact.confidence}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      {impact.via.join(" → ")}
                    </p>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">建议检查的测试</h3>
                {comparison.relatedTests.map((test, i) => (
                  <div className="mb-2 rounded border p-2 text-xs" key={i}>
                    <strong className="break-all">{test.path}</strong>
                    <p className="mt-1">
                      {test.reason} · {test.confidence}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      对应 {test.sourcePath}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-sm">
                文件变化与诊断
              </summary>
              <Code
                value={{
                  changes: comparison.changes,
                  diagnostics: comparison.diagnostics,
                }}
              />
            </details>
          </div>
        )}
      </Panel>
    </div>
  );
}
