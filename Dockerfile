# Build spec for the Plune MCP server listing on Glama (https://glama.ai/mcp/servers/plune-ai/cli).
# Node 26 is the newest LTS line (nodejs.org/dist/index.json, 26.13.1 "Lithium", 10.11.2026);
# the package needs Node >= 20.
FROM node:26-slim
RUN npm install -g @plune-ai/cli@latest
# Introspection only: the server answers initialize and tools/list without calling Plune.
# A real PLUNE_TOKEN is needed only to call the tools.
ENV PLUNE_TOKEN=glama-introspection-only
ENTRYPOINT ["plune", "mcp", "serve"]
