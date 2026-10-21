// Why a connection to a server failed, in words an operator can act on: what happened, why it usually happens,
// and what to check. Used by Add server, Test connection and the reachability check before Start / Restart /
// Stop All on several servers.
//
// ssh2's own messages say little ("Timed out while waiting for handshake" covers a wrong address, a server that
// is off and a firewall alike), so a plain TCP connection to the SSH port is tried first: it tells those apart.
import net from 'node:net';

export type ProblemKind = 'bad_input' | 'unknown_host' | 'no_route' | 'blocked' | 'no_answer' | 'refused' | 'not_ssh' | 'closed' | 'auth_failed' | 'key_install' | 'other';

export interface ConnectionProblem {
  kind: ProblemKind;
  title: string; // what happened, one line
  why: string; // why that usually happens
  fix: string; // what to check
  technical: string; // the raw message, for whoever looks into it
}

export type TcpResult = 'open' | 'refused' | 'timeout' | 'no_route' | 'blocked' | 'unknown_host' | { other: string };

const TCP_TIMEOUT_MS = 5000;
// "No route to host" means two things on Linux. Nothing at the address: it comes after ~3 s, once the search for
// the machine (ARP) gives up. A firewall rejecting the port (firewalld's default on Rocky / RHEL answers with
// "host prohibited"): it comes at once, because the server itself answered. So a quick one is a blocked port.
const FAST_REJECT_MS = 1000;

export function tcpErrorResult(code: string, message: string, elapsedMs: number): TcpResult {
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'unknown_host';
  if (code === 'EHOSTUNREACH' || code === 'EHOSTDOWN') return elapsedMs < FAST_REJECT_MS ? 'blocked' : 'no_route';
  if (code === 'ENETUNREACH') return 'no_route'; // this machine's own routes: no server involved
  if (code === 'ETIMEDOUT') return 'timeout';
  return { other: `${code || 'error'}: ${message}` };
}

// Can this machine open a connection to host:port at all?
export function probeTcp(host: string, port: number, timeoutMs = TCP_TIMEOUT_MS): Promise<TcpResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (r: TcpResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('error', (err: any) => finish(tcpErrorResult(String(err?.code ?? ''), String(err?.message ?? err), Date.now() - started)));
  });
}

// A character no account name has: almost always a typo (a stray ` or space copied along).
export function usernameProblem(username: string): ConnectionProblem | null {
  const bad = [...new Set([...username].filter((ch) => !/[A-Za-z0-9._@\\$-]/.test(ch)))];
  if (bad.length === 0) return null;
  const shown = bad.map((ch) => (/\s/.test(ch) ? 'a space' : `“${ch}”`)).join(' and ');
  return {
    kind: 'bad_input',
    title: `The user name “${username}” has ${shown} in it`,
    why: `An account name on a Linux server can't contain ${shown}, so this is most likely a typo.`,
    fix: 'Correct the user name (for example svc_user) and try again.',
    technical: `invalid character(s) in user name: ${bad.map((c) => JSON.stringify(c)).join(' ')}`,
  };
}

export function hostProblem(host: string): ConnectionProblem | null {
  if (!/\s/.test(host) && !/^[a-z]+:\/\//i.test(host)) return null;
  return {
    kind: 'bad_input',
    title: `“${host}” isn't a server address`,
    why: /\s/.test(host) ? 'It contains a space.' : 'It starts like a web address (http://…).',
    fix: 'Enter just the host name or IP address, for example 192.168.122.5.',
    technical: 'invalid host',
  };
}

// The TCP check failed: nothing to sign in to.
export function explainTcp(r: Exclude<TcpResult, 'open'>, host: string, port: number): ConnectionProblem {
  const seconds = TCP_TIMEOUT_MS / 1000;
  if (r === 'unknown_host')
    return {
      kind: 'unknown_host',
      title: `There's no server called “${host}”`,
      why: "This machine can't turn that name into an address: it's misspelt, or the name isn't known on this network.",
      fix: "Check the spelling, or enter the server's IP address instead.",
      technical: `${host}: name not found`,
    };
  if (r === 'no_route')
    return {
      kind: 'no_route',
      title: `${host} can't be reached from this machine`,
      why: 'Nothing answers at that address: the server is switched off, the address is wrong, or it is on another network.',
      fix: 'Check the IP address, that the server is running, and that this machine is connected to the same network or VPN as the server.',
      technical: `${host}:${port}: no route to host`,
    };
  if (r === 'blocked')
    return {
      kind: 'blocked',
      title: `${host} blocks connections on port ${port}`,
      why: `The server is there, but its firewall (or one in front of it) turned the connection down at once, so the user name and password weren't tried. Usually SSH is on a different port on this server, or the firewall doesn't let this machine in on port ${port}.`,
      fix: `Check the server's SSH port with its administrator, and that its firewall lets this machine connect on that port.`,
      technical: `${host}:${port}: no route to host, answered at once (a firewall rejecting the port)`,
    };
  if (r === 'refused')
    return {
      kind: 'refused',
      title: `${host} refused the connection on port ${port}`,
      why: 'The server is on, but nothing accepts SSH connections on that port.',
      fix: `Check the port (SSH is usually 22), and that the SSH service (sshd) is running on the server.`,
      technical: `${host}:${port}: connection refused`,
    };
  if (r === 'timeout')
    return {
      kind: 'no_answer',
      title: `${host} doesn't answer on port ${port}`,
      why: `Nothing replied within ${seconds} seconds. Usually the address is wrong, the server is switched off, or a firewall drops connections from this machine.`,
      fix: `Check the IP address and the port, that the server is running, and that its firewall lets this machine connect on port ${port}.`,
      technical: `${host}:${port}: no answer within ${seconds} s`,
    };
  return {
    kind: 'other',
    title: `Couldn't open a connection to ${host}`,
    why: 'The network reported an error.',
    fix: 'Check the address and port, and that the server is on and reachable from this machine.',
    technical: r.other,
  };
}

// The SSH step failed (the port did answer).
export function explainSsh(raw: string, host: string, port: number, username: string, usedPassword: boolean): ConnectionProblem {
  const technical = raw;
  if (/authentication methods failed|authentication failed|permission denied/i.test(raw)) {
    return {
      kind: 'auth_failed',
      title: usedPassword ? 'The server refused that user name or password' : `The server refused Healthcheck's key for ${username}`,
      why: usedPassword
        ? `“${username}” couldn't sign in with the password given.`
        : `Healthcheck's SSH key isn't (or is no longer) accepted for “${username}”: it was removed from ~/.ssh/authorized_keys, or the account changed.`,
      fix: usedPassword
        ? 'Check the user name and password (both are case-sensitive). If they are right, the account may not be allowed to sign in with a password or over SSH (PasswordAuthentication / AllowUsers in the server\'s sshd settings).'
        : 'Add the server again with the account\'s password: Healthcheck reinstalls its key.',
      technical,
    };
  }
  if (/timed out while waiting for handshake/i.test(raw)) {
    return {
      kind: 'not_ssh',
      title: `${host} answers on port ${port}, but not like an SSH server`,
      why: "Something accepted the connection, but the SSH sign-in didn't get under way within 10 seconds.",
      fix: `Check that ${port} is the server's SSH port. The SSH service may be overloaded, or something in between (a proxy, a firewall) may be holding the connection.`,
      technical,
    };
  }
  if (/ECONNRESET|connection lost|closed|kex_exchange|no matching/i.test(raw)) {
    return {
      kind: 'closed',
      title: `${host} hung up before Healthcheck could sign in`,
      why: /no matching|kex/i.test(raw)
        ? "The server and Healthcheck don't share a way to encrypt the connection (the server's SSH is very old or locked down)."
        : 'The SSH service closed the connection straight away.',
      fix: 'The server may block this machine (fail2ban, hosts.deny, AllowUsers), have too many connections opening at once, or need its SSH settings checked by its administrator.',
      technical,
    };
  }
  return {
    kind: 'other',
    title: `Couldn't sign in to ${host}`,
    why: 'The SSH connection failed.',
    fix: 'Check the address, port, user name and password. The technical detail below says more.',
    technical,
  };
}

export function keyInstallProblem(stderr: string, username: string): ConnectionProblem {
  return {
    kind: 'key_install',
    title: "Signed in, but Healthcheck's key couldn't be saved on the server",
    why: `Healthcheck adds its key to ~/.ssh/authorized_keys of “${username}”, and that didn't work.`,
    fix: 'Check that the account has a home folder it owns and can write to (and that the disk isn\'t full).',
    technical: stderr || 'writing ~/.ssh/authorized_keys failed',
  };
}

// One line for places that show plain text (logs, old callers).
export const problemText = (p: ConnectionProblem) => `${p.title}. ${p.why} ${p.fix}`;
