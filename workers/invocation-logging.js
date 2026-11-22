
export function redactPath(input) {
  const url = new URL(input);
  // Query names and values are caller-controlled; a sensitive-key allowlist
  // cannot anticipate every credential convention.
  return url.pathname;
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
