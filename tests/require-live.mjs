function verifyHttpOrigin(key, required) {
  const raw = process.env[key];
  if (!raw) {
    if (required) {
      throw new Error(`${key} is required for strict deployed HTTP E2E tests`);
    }
    return;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${key} must be an http(s) URL without embedded credentials, query or fragment`);
  }
}

verifyHttpOrigin("ORES_OTEL_BASE_URL", true);
verifyHttpOrigin("ORES_OTEL_PEER_URL", false);
