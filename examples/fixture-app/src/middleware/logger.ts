import type { NextFunction, Request, Response } from 'express';

/** Logs `<METHOD> <path> <status> <ms>ms worker=<x-isolate-worker or ->` to stdout once the response is sent. */
export function logRequests(req: Request, res: Response, next: NextFunction): void {
  const started = performance.now();
  const { method, path } = req;
  res.on('finish', () => {
    const ms = Math.round(performance.now() - started);
    const worker = req.get('x-isolate-worker') ?? '-';
    console.log(`${method} ${path} ${res.statusCode} ${ms}ms worker=${worker}`);
  });
  next();
}
