// Throwaway semantics-probe worker for the W0 step of the Cloudflare write plan
// (docs/cloudflare-write-plan.md). Exposes only a boolean "secret present"
// check; the secret value itself is never returned, logged or persisted.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/probe-secret' && request.method === 'GET') {
      const present = typeof env.PROBE_SECRET === 'string' && env.PROBE_SECRET.length > 0;
      const plain = env.PROBE_PLAIN === 'probe-value';
      return new Response(JSON.stringify({ present, plain }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
};
