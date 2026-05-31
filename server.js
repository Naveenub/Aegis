// ─── server.js patch — sandbox health reporting ───────────────────────────────
//
// Apply these two changes to server.js:
//
// 1. Add this import alongside the other engine imports (line ~20):
//
//   import { getSandboxCapabilities } from './engine/sandbox.js';
//
// 2. Replace the existing /health handler body with the version below.
//    The only addition is the `sandbox` field in the JSON response.
//

app.get('/health', optionalApiKey, async (req, res) => {
  const caps    = await getVectorCapabilities();
  const sandbox = getSandboxCapabilities();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    vectorMemory: {
      embeddings:  caps.embeddings,
      openai:      caps.openai,
      redisSearch: caps.redisSearch,
      warnings:    caps.warnings,
    },
    sandbox: {
      enabled:  sandbox.enabled,
      docker:   sandbox.docker,
      image:    sandbox.image,
      memory:   sandbox.memory,
      cpus:     sandbox.cpus,
      warnings: sandbox.warnings,
    },
  });
});
