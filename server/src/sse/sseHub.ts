import type { Response } from 'express';

const clients = new Map<number, Set<Response>>();

export const sseHub = {
  subscribe(jobId: number, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    let set = clients.get(jobId);
    if (!set) {
      set = new Set();
      clients.set(jobId, set);
    }
    set.add(res);
    res.on('close', () => {
      set?.delete(res);
    });
  },
  publish(jobId: number, event: unknown) {
    const set = clients.get(jobId);
    if (!set) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) res.write(payload);
  },
  close(jobId: number) {
    const set = clients.get(jobId);
    if (!set) return;
    for (const res of set) res.end();
    clients.delete(jobId);
  },
};
