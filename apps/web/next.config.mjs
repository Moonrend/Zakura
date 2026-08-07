import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * markstream-react 的 exports 仅声明了 `import` 条件，未提供 `require`/`default`。
 * Next webpack / turbopack 解析包根路径时会报 “Package path . is not exported”。
 * 用精确别名绕过，同时保留 `markstream-react/index.css` 等子路径走官方 exports。
 */
const markstreamDist = path.join(
  __dirname,
  "node_modules/markstream-react/dist",
);
const emptyModule = path.join(__dirname, "src/lib/empty-module.js");
/**
 * 未安装的可选 peer → 空模块，避免 Next 编译失败。
 * 已安装的 peer（如 katex）不要放这里，否则公式/高亮会被静默 stub 掉。
 */
const optionalPeerAliases = {
  "@terrastruct/d2": emptyModule,
  "@antv/infographic": emptyModule,
  mermaid: emptyModule,
  "stream-monaco": emptyModule,
  "stream-markdown": emptyModule,
};
const markstreamAliases = {
  "markstream-react$": path.join(markstreamDist, "index.js"),
  "markstream-react/next$": path.join(markstreamDist, "next.js"),
  "markstream-react/server$": path.join(markstreamDist, "server.js"),
  ...optionalPeerAliases,
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["markstream-react", "katex"],
  turbopack: {
    resolveAlias: {
      "markstream-react": path.join(markstreamDist, "index.js"),
      "markstream-react/next": path.join(markstreamDist, "next.js"),
      "markstream-react/server": path.join(markstreamDist, "server.js"),
      "@terrastruct/d2": "./src/lib/empty-module.js",
      "@antv/infographic": "./src/lib/empty-module.js",
      mermaid: "./src/lib/empty-module.js",
      "stream-monaco": "./src/lib/empty-module.js",
      "stream-markdown": "./src/lib/empty-module.js",
    },
  },
  webpack: (config, { webpack }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...markstreamAliases,
    };
    // 动态 import / 深层子路径有时绕过 resolve.alias，再用替换兜底（仅未安装 peer）
    const optionalPeerPattern =
      /^(?:@terrastruct\/d2|@antv\/infographic|mermaid|stream-monaco|stream-markdown)$/;
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(optionalPeerPattern, emptyModule),
    );
    return config;
  },
  async rewrites() {
    const api = process.env.ZAKURA_API_URL || "http://localhost:8787";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  async redirects() {
    return [
      { source: "/dashboard/connect", destination: "/dashboard/agents", permanent: true },
      { source: "/dashboard/agents/connect", destination: "/dashboard/agents", permanent: true },
      { source: "/dashboard/web-search", destination: "/dashboard/web", permanent: true },
      { source: "/dashboard/web-fetch", destination: "/dashboard/web", permanent: true },
      { source: "/dashboard/import", destination: "/dashboard/mcp/import", permanent: true },
      { source: "/dashboard/mcp-store", destination: "/dashboard/mcp/store", permanent: true },
      {
        source: "/dashboard/agents/:id/workspace",
        destination: "/dashboard/agents/:id/computer",
        permanent: true,
      },
      {
        source: "/dashboard/agents/:id/files",
        destination: "/dashboard/agents/:id/computer",
        permanent: true,
      },
      {
        source: "/dashboard/agents/:id/web-search",
        destination: "/dashboard/agents/:id/web",
        permanent: true,
      },
      {
        source: "/dashboard/agents/:id/web-fetch",
        destination: "/dashboard/agents/:id/web",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
