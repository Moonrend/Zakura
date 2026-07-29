/**
 * 用 skills.sh 的真实搜索结果批量验证 resolve 链路。
 * 用法：npx tsx test/scratch-store.ts [关键词...]
 */
import { parseSkillSource } from "../src/services/skills/source.js";
import { fetchSkillPackages } from "../src/services/skills/fetch.js";

const terms = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["slop", "pdf", "writing", "react"];

const specs: string[] = [];
for (const term of terms) {
  const res = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(term)}`, {
    headers: { Accept: "application/json", "User-Agent": "Zakura-Skills/1.0" },
  });
  const data = (await res.json()) as { skills?: Array<{ skillId: string; source: string }> };
  for (const hit of (data.skills ?? []).slice(0, 6)) {
    const spec = `${hit.source}@${hit.skillId}`;
    if (!specs.includes(spec)) specs.push(spec);
  }
}

let ok = 0;
let bad = 0;
for (const spec of specs) {
  try {
    const packages = await fetchSkillPackages(parseSkillSource(spec), {
      githubToken: process.env.GITHUB_TOKEN,
      manifestOnly: true,
    });
    ok++;
    console.log(`OK  ${spec} -> ${packages.packages.map((p) => p.name).join(", ")}`);
  } catch (err) {
    bad++;
    console.log(`ERR ${spec}\n    ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${ok} ok / ${bad} failed / ${specs.length} total`);
