if (!process.env.ORES_OTEL_BASE_URL) {
  throw new Error("ORES_OTEL_BASE_URL is required for strict deployed HTTP E2E tests");
}
