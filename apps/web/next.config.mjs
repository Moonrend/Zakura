/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const api = process.env.ZAKURA_API_URL || "http://127.0.0.1:8787";
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
