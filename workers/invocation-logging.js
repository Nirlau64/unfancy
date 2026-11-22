const SENSITIVE_QUERY_KEYS = /^(?:token|key|secret|api[_-]?key|authorization|code|state|client[_-]?secret|access[_-]?token|refresh[_-]?token)$/i;

export function redactPath(input) {
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return `${url.pathname}${url.search}`;
}

export async function logInvocation(request, handler) {
  const started = Date.now();
  let status = 500;
  try {
    const response = await handler();
    status = response.status;
    return response;
  } finally {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      method: request.method,
      path: redactPath(request.url),
      status,
      durationMs: Math.max(0, Date.now() - started),
    }));
  }
}
