import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generativeUIPrompt, uiCatalogDocument } from "../apps/web/src/lib/generative-ui-catalog.ts";

const outputs = {
  "../apps/server/internal/runtime/generative_ui_prompt.txt": generativeUIPrompt(),
  "../apps/server/internal/runtime/generative_ui_catalog.json": `${JSON.stringify(uiCatalogDocument(), null, 2)}\n`,
};
for (const [relative, content] of Object.entries(outputs)) {
  const target = fileURLToPath(new URL(relative, import.meta.url));
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== content) throw new Error(`UI catalog differs: regenerate ${relative}`);
  } else {
    writeFileSync(target, content);
  }
}
