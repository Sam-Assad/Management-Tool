import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  if (err instanceof ZodError) {
    const message = err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return res.status(400).json({ error: message });
  }
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? 'Internal server error' });
};
