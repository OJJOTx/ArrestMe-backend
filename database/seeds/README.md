# Database Seeds

Production deployments must **never** run synthetic seeds automatically.

For local development or manual staging verification, register test users via `/api/v1/auth/register` or use automated integration tests in `tests/`.
