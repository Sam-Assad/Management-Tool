// sshd allows only MaxSessions (default 10) channels per connection. Starting several components at once
// means several log tails plus short commands on the same connection, so every channel we open takes a
// slot here first and waits its turn instead of being refused by the server.
const CAPACITY = 8;

interface Gate {
  used: number;
  waiting: Array<() => void>;
}

const gates = new WeakMap<object, Gate>();

export function acquireChannel(client: object): Promise<() => void> {
  let gate = gates.get(client);
  if (!gate) {
    gate = { used: 0, waiting: [] };
    gates.set(client, gate);
  }
  const g = gate;
  const grant = () => {
    g.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      g.used--;
      g.waiting.shift()?.();
    };
  };
  if (g.used < CAPACITY) return Promise.resolve(grant());
  return new Promise((resolve) => g.waiting.push(() => resolve(grant())));
}
