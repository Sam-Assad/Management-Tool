import type { Client } from 'ssh2';
import type { SoftwareDefinition } from '@healthcheck/shared';
import { runCommand } from '../ssh/exec.js';

export interface UnitState {
  installed: boolean;
  // systemd ActiveState: active | inactive | failed | activating | deactivating | reloading
  active: string;
  // systemd SubState, e.g. running | start | auto-restart | dead | failed
  sub?: string;
  // main process id (used to notice a service that exited and was restarted)
  pid?: string;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// `systemctl show` exits 0 even for a unit that doesn't exist (LoadState=not-found),
// which is what lets us tell "installed but stopped" apart from "not installed".
export async function probeUnit(client: Client, unit: string): Promise<UnitState> {
  const res = await runCommand(client, `systemctl show ${shQuote(unit)} -p LoadState -p ActiveState -p SubState -p MainPID 2>/dev/null`);
  const props = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) props.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  // No LoadState at all means the query itself failed (not that the unit is missing) - say so
  // instead of reporting "not installed", which would get the component dropped from its group.
  const loadState = props.get('LoadState');
  if (!loadState) {
    throw new Error(`systemctl show ${unit} returned no data${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`);
  }
  return { installed: loadState !== 'not-found', active: props.get('ActiveState') ?? 'inactive', sub: props.get('SubState'), pid: props.get('MainPID') };
}

// A catalog entry may list alternative unit names for the same component, separated by "|"
// (e.g. "wso2am.service|wso2apim.service" - markets name the API Manager unit differently).
export function unitNames(def: SoftwareDefinition): string[] {
  return def.detect_value
    .split(/[|,]/)
    .map((n) => n.trim())
    .filter(Boolean);
}

export interface ComponentUnit extends UnitState {
  // the unit name that actually exists on this server (the first listed one if none does)
  unit: string;
}

// Which of the entry's unit names exists on this server, and what it's doing. If more than one
// exists, the running one wins, then the first listed.
export async function probeComponentUnit(client: Client, def: SoftwareDefinition): Promise<ComponentUnit> {
  const names = unitNames(def);
  const probed: ComponentUnit[] = [];
  for (const unit of names) probed.push({ unit, ...(await probeUnit(client, unit)) });
  const installed = probed.filter((p) => p.installed);
  return installed.find((p) => p.active === 'active') ?? installed[0] ?? probed[0];
}

// Is it running right now?
export async function detectPresence(client: Client, def: SoftwareDefinition): Promise<boolean> {
  switch (def.detect_method) {
    case 'systemd': {
      const state = await probeComponentUnit(client, def);
      return state.installed && state.active === 'active';
    }
    case 'process_fragment': {
      const fragment = def.detect_value.replace(/'/g, `'\\''`);
      const res = await runCommand(client, `pgrep -f '${fragment}'`);
      return res.code === 0 && res.stdout.trim().length > 0;
    }
    case 'jar_path_fragment': {
      const res = await runCommand(client, `ls ${def.detect_value} 2>/dev/null`);
      return res.code === 0 && res.stdout.trim().length > 0;
    }
    default:
      return false;
  }
}

// Is it installed on this server (running or not)? For systemd entries that's "the unit
// exists"; for process/jar detection the only evidence available is it running.
export async function detectInstalled(client: Client, def: SoftwareDefinition): Promise<boolean> {
  if (def.detect_method === 'systemd') {
    return (await probeComponentUnit(client, def)).installed;
  }
  return detectPresence(client, def);
}

// systemctl needs root to start/stop. Run it directly as root; otherwise through
// `sudo -n systemctl ...` (-n = never prompt for a password). The sudoers rule is often limited
// to systemctl itself, so we must NOT probe with some other command (e.g. `sudo -n true` is
// refused by such a rule) - just run the real command and report what sudo says.
export function systemctlCommand(action: 'start' | 'stop', unit: string): string {
  const u = shQuote(unit);
  return (
    `if [ "$(id -u)" = "0" ]; then systemctl ${action} ${u}; ` +
    `elif command -v sudo >/dev/null 2>&1; then sudo -n systemctl ${action} ${u}; ` +
    `else systemctl ${action} ${u}; fi`
  );
}

// What a component is doing right now, in words an operator understands. `up` is true only
// for 'running'; every other state counts as down for sequencing/heartbeat purposes.
export type ComponentState = 'running' | 'stopped' | 'failed' | 'starting' | 'stopping' | 'not_installed' | 'unreachable';

export const COMPONENT_STATES: ComponentState[] = [
  'running',
  'stopped',
  'failed',
  'starting',
  'stopping',
  'not_installed',
  'unreachable',
];

export async function checkComponent(
  client: Client,
  def: SoftwareDefinition
): Promise<{ up: boolean; state: ComponentState }> {
  if (def.detect_method === 'systemd') {
    const unit = await probeComponentUnit(client, def);
    if (!unit.installed) return { up: false, state: 'not_installed' };
    switch (unit.active) {
      case 'active':
        return { up: true, state: 'running' };
      case 'failed':
        return { up: false, state: 'failed' };
      case 'activating':
      case 'reloading':
        return { up: false, state: 'starting' };
      case 'deactivating':
        return { up: false, state: 'stopping' };
      default:
        return { up: false, state: 'stopped' };
    }
  }
  const up = await detectPresence(client, def);
  return { up, state: up ? 'running' : 'stopped' };
}
