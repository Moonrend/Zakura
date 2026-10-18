import { defineCatalog, type ComputedFunction } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const UI_CATALOG_VERSION = 1;
const expression = z.record(z.string(), z.unknown());
const text = z.union([z.string().max(12000), z.number(), expression]);
const number = z.union([z.number().finite(), expression]);
const boolean = z.union([z.boolean(), expression]);
const rows = z.union([z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(200), expression]);

export const uiComponents = {
  Stack: { props: z.object({ direction: z.enum(["vertical", "horizontal"]).optional(), gap: z.enum(["small", "medium", "large"]).optional() }).strict(), slots: ["default"], description: "Responsive layout. Horizontal stacks wrap on narrow screens." },
  Card: { props: z.object({ title: text.optional(), description: text.optional() }).strict(), slots: ["default"], description: "A compact group of related information or controls; avoid nesting cards." },
  Text: { props: z.object({ text, tone: z.enum(["default", "muted", "heading"]).optional() }).strict(), description: "Plain text, heading, or a computed value. No HTML or Markdown." },
  Divider: { props: z.object({}).strict(), description: "Separate distinct sections." },
  Input: { props: z.object({ label: z.string().max(160), value: text.optional(), placeholder: z.string().max(200).optional(), type: z.enum(["text", "number", "date"]).optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional() }).strict(), description: "Labeled field. Bind value with {$bindState:'/key'}; number inputs store numbers." },
  Select: { props: z.object({ label: z.string().max(160), value: text.optional(), options: z.array(z.object({ label: z.string().max(160), value: z.string().max(200) }).strict()).max(60) }).strict(), description: "Labeled choice, value supports $bindState." },
  Checkbox: { props: z.object({ label: z.string().max(160), checked: boolean.optional() }).strict(), description: "Boolean choice; checked supports $bindState." },
  Slider: { props: z.object({ label: z.string().max(160), value: number, min: z.number(), max: z.number(), step: z.number().positive().optional(), unit: z.string().max(30).optional() }).strict(), description: "Numeric range; value supports $bindState. Always supply min and max." },
  Button: { props: z.object({ label: z.string().max(160), variant: z.enum(["default", "outline", "ghost"]).optional() }).strict(), description: "Explicit user action, via on.press. continueConversation sends a message plus all current state; setState updates locally." },
  Table: { props: z.object({ columns: z.array(z.object({ key: z.string().max(100), label: z.string().max(160) }).strict()).min(1).max(12), rows, caption: z.string().max(300).optional() }).strict(), description: "Comparison/data table. Use $computed:filterRows with rows and query for local filtering." },
  BarChart: { props: z.object({ title: z.string().max(200), data: z.array(z.object({ label: z.string().max(160), value: z.number().finite() }).strict()).max(30), unit: z.string().max(30).optional() }).strict(), description: "One numeric measure compared across categories, with hover/focus details and a table view. Use nonnegative values." },
};

export const uiCatalog = defineCatalog({
  ...schema,
  defaultRules: [],
  builtInActions: [],
  promptTemplate: ({ componentNames, formatZodType }) => componentNames.map((name) => {
    const component = uiComponents[name as keyof typeof uiComponents];
    return `- ${name}: ${formatZodType(component.props)} — ${component.description}`;
  }).join("\n"),
}, {
  components: uiComponents,
  actions: {
    continueConversation: { params: z.object({ message: z.string().min(1).max(2000) }).strict(), description: "On Button press only: send this message together with the current form state to the assistant." },
  },
});

function finite(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export const uiFunctions: Record<string, ComputedFunction> = {
  calculate: ({ operation, values }) => {
    const list = Array.isArray(values) ? values.slice(0, 64).map(finite) : [];
    let result = 0;
    switch (operation) {
      case "sum": result = list.reduce((a, b) => a + b, 0); break;
      case "product": result = list.reduce((a, b) => a * b, 1); break;
      case "difference": result = (list[0] ?? 0) - (list[1] ?? 0); break;
      case "divide": result = list[1] ? (list[0] ?? 0) / list[1] : 0; break;
      case "power": result = Math.pow(list[0] ?? 0, Math.max(-100, Math.min(100, list[1] ?? 1))); break;
    }
    if (!Number.isFinite(result)) return 0;
    return Math.abs(result) < 1e300 ? Math.round(result * 1e8) / 1e8 : result;
  },
  formatNumber: ({ value, digits, unit }) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: Math.max(0, Math.min(8, finite(digits ?? 2))) }).format(finite(value))}${typeof unit === "string" ? unit.slice(0, 30) : ""}`,
  filterRows: ({ rows, query }) => {
    if (!Array.isArray(rows)) return [];
    const needle = String(query ?? "").slice(0, 200).toLocaleLowerCase();
    return rows.slice(0, 200).filter((row) => row && typeof row === "object" && Object.values(row).some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)));
  },
};

export function uiCatalogDocument() {
  return { version: UI_CATALOG_VERSION, components: Object.fromEntries(Object.entries(uiComponents).map(([name, definition]) => [name, z.toJSONSchema(definition.props)])) };
}

export function generativeUIPrompt(): string {
  return `# Interactive answers (Zakura UI catalog v${UI_CATALOG_VERSION})
Use an interactive UI when it helps compare, explore, calculate, or collect input. Answer simple questions in plain text. Never replace real user approval with a generated button.
Embed UI in an assistant message as a fenced block with language json-render. Text before and after is ordinary Markdown. Inside the block, output one JSON Patch operation per line (SpecStream), using only add/replace/remove and object-property paths. Assign arrays as whole values, never patch array indices. A complete JSON spec is also accepted.
First add /catalogVersion = ${UI_CATALOG_VERSION}, /state = an object of at most 64 flat string/number/boolean/null defaults, /elements = {}, and /root = the root ID. Add whole elements early so the UI appears progressively. Every element has type, props, children (an array, possibly empty); buttons can additionally have on.press.
State paths are one level only (/key). All bound fields MUST have an initial state default of the right type. Do not use HTML, JavaScript, URLs, arbitrary CSS, repeat, slots, watchers, validation hooks, automatic actions, or network requests. No actions on mount or input change. on.press is only allowed on Button, for continueConversation or setState. setState params: {statePath:'/key',value:<value>}. continueConversation params: {message:'User-facing request'}; the host automatically attaches all form state. Do not ask users to enter passwords or secrets in generated forms.
Expressions: {$state:'/key'}, {$bindState:'/key'} (only editable value/checked props), {$computed:'calculate',args:{operation:'sum|product|difference|divide|power',values:[...values/expressions]}}, {$computed:'formatNumber',args:{value:<value/expression>,digits:2,unit:'元'}}, {$computed:'filterRows',args:{rows:[...rows],query:{$state:'/query'}}}. Computations are local and reactive. visible accepts a boolean or {$state:'/booleanKey'}.
${uiCatalog.prompt()}
Registered computed functions: calculate, formatNumber, filterRows.
Example (wrap the following JSONL in a json-render fence):
{"op":"add","path":"/catalogVersion","value":1}
{"op":"add","path":"/state","value":{"quantity":2,"price":10}}
{"op":"add","path":"/elements","value":{}}
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"费用计算"},"children":["quantity","total","send"]}}
{"op":"add","path":"/elements/quantity","value":{"type":"Slider","props":{"label":"数量","value":{"$bindState":"/quantity"},"min":1,"max":20,"step":1},"children":[]}}
{"op":"add","path":"/elements/total","value":{"type":"Text","props":{"text":{"$computed":"calculate","args":{"operation":"product","values":[{"$state":"/quantity"},{"$state":"/price"}]}}},"children":[]}}
{"op":"add","path":"/elements/send","value":{"type":"Button","props":{"label":"按此方案继续"},"children":[],"on":{"press":{"action":"continueConversation","params":{"message":"按我选择的数量继续"}}}}}
`;
}
