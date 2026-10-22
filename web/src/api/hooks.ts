import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ArtemisReport } from '../components/ArtemisNoticeModal';

export interface ServerSummary {
  id: number;
  group_id: number; // internal: where the server's software list and jobs live
  name: string;
  host: string;
  port: number;
  ssh_username: string;
  connection_status: string;
  last_connected_at: string | null;
  software: { software_id: number; name: string; state: string; status: string }[];
  summary: { total: number; running: number };
}

export function useServerList() {
  return useQuery({ queryKey: ['servers'], queryFn: () => api.get<ServerSummary[]>('/servers'), refetchInterval: 20000 });
}

export interface RecentJob {
  id: number;
  group_id: number | null;
  kind: string;
  status: string;
  awaiting: string | null;
  error_message: string | null;
  // username of whoever started it (older runs: null)
  started_by: string | null;
  started_at: string;
  finished_at: string | null;
}

export function useRecentJobs(limit = 8) {
  return useQuery({
    queryKey: ['jobs', 'recent', limit],
    queryFn: () => api.get<RecentJob[]>(`/jobs?limit=${limit}`),
    refetchInterval: 10000,
  });
}

export function useServer(serverId: number) {
  return useQuery({ queryKey: ['servers', serverId], queryFn: () => api.get<ServerSummary>(`/servers/${serverId}`) });
}

export function useAddServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => api.post<any>('/servers', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useDeleteServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: number) => api.delete(`/servers/${serverId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (serverId: number) => api.post<any>(`/servers/${serverId}/test-connection`),
  });
}

export function useSoftwareDefinitions() {
  return useQuery({ queryKey: ['software'], queryFn: () => api.get<any[]>('/software-definitions') });
}

export function useCreateSoftwareDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => api.post('/software-definitions', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['software'] }),
  });
}

export function useUpdateSoftwareDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: unknown }) => api.patch(`/software-definitions/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['software'] }),
  });
}

export function useDeleteSoftwareDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/software-definitions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['software'] }),
  });
}

export function useGroupSoftware(groupId: number) {
  return useQuery({
    queryKey: ['groups', groupId, 'software'],
    queryFn: () => api.get<any[]>(`/groups/${groupId}/software`),
  });
}

export function useSetGroupSoftware(groupId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: { software_id: number; sequence_order: number }[]) =>
      api.put(`/groups/${groupId}/software`, { items }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups', groupId, 'software'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useScanGroup(groupId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ jobId: number }>(`/groups/${groupId}/scan`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useAutoDiscover(groupId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ added: string[] }>(`/groups/${groupId}/auto-discover`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups', groupId, 'software'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useStartAll(groupId: number) {
  return useMutation({ mutationFn: () => api.post<{ jobId: number }>(`/groups/${groupId}/start-all`) });
}

export function useStartOne() {
  return useMutation({
    mutationFn: ({ serverId, softwareId }: { serverId: number; softwareId: number }) =>
      api.post<{ jobId: number }>(`/servers/${serverId}/software/${softwareId}/start`),
  });
}

export function useRestartAll(groupId: number) {
  return useMutation({ mutationFn: () => api.post<{ jobId: number }>(`/groups/${groupId}/restart-all`) });
}

export function useStopAll(groupId: number) {
  return useMutation({ mutationFn: () => api.post<{ jobId: number }>(`/groups/${groupId}/stop-all`) });
}

export function useRestartOne() {
  return useMutation({
    mutationFn: ({ serverId, softwareId }: { serverId: number; softwareId: number }) =>
      api.post<{ jobId: number }>(`/servers/${serverId}/software/${softwareId}/restart`),
  });
}

export function useStopOne() {
  return useMutation({
    mutationFn: ({ serverId, softwareId }: { serverId: number; softwareId: number }) =>
      api.post<{ jobId: number }>(`/servers/${serverId}/software/${softwareId}/stop`),
  });
}

export function useSuggestions(groupId: number) {
  return useQuery({
    queryKey: ['groups', groupId, 'suggestions'],
    queryFn: () => api.get<{ software_id: number; name: string }[]>(`/groups/${groupId}/suggestions`),
    refetchInterval: 30000,
  });
}

export function useDismissSuggestion(groupId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (softwareId: number) => api.post(`/groups/${groupId}/suggestions/${softwareId}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups', groupId, 'suggestions'] }),
  });
}

export function useJob(jobId: number | undefined) {
  return useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => api.get<any>(`/jobs/${jobId}`),
    enabled: jobId !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });
}

export function useConditions() {
  return useQuery({ queryKey: ['conditions'], queryFn: () => api.get<any[]>('/conditions') });
}

// Conditions change every group's order, so refresh group data along with them.
function invalidateOrdering(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['conditions'] });
  qc.invalidateQueries({ queryKey: ['groups'] });
}

export function useCreateCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; subject_id: number; target_id: number; note?: string }) =>
      api.post('/conditions', input),
    onSuccess: () => invalidateOrdering(qc),
  });
}

export function useUpdateCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: { enabled?: boolean; note?: string | null } }) =>
      api.patch(`/conditions/${id}`, input),
    onSuccess: () => invalidateOrdering(qc),
  });
}

export function useDeleteCondition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/conditions/${id}`),
    onSuccess: () => invalidateOrdering(qc),
  });
}

export interface CrashFacts {
  disks: { mount: string; sizeKb: number; availKb: number; usedPct: number }[];
  memory: { totalKb: number; availableKb: number } | null;
  oom: string[];
}

export interface BeatAlert {
  // wildfly: can't take traffic / database problem; health: a running service that can't do its job (no connection
  // to the database / Artemis it needs, or it doesn't answer requests); artemis: its own beat found memory too high;
  // crash: a service keeps crashing (crashing), systemd gave up on it (gave_up), or it was stopped from the alert
  // (stopped: only in crash_stopped, for the server page)
  kind: 'wildfly' | 'artemis' | 'crash' | 'health';
  server_id: number;
  server_name: string;
  software_id: number;
  software_name: string;
  state: 'not_ready' | 'datasource_down' | 'unhealthy' | 'memory_high' | 'crashing' | 'gave_up' | 'stopped';
  detail: string | null;
  artemis?: ArtemisReport;
  crash?: {
    count: number;
    first_crash_at: string;
    last_crash_at: string;
    ran_for_s: number | null; // how long it had been running before the crashes began (null = longer than Healthcheck knows)
    after_start: boolean; // it crashes right after a start, rather than after running fine
    started_source: 'boot' | 'terminal' | 'outside' | 'reboot' | null; // who started it then
    started_actor: string | null;
    reason: string | null;
    excerpt: string | null; // the error from its log
    facts: CrashFacts | null; // the server's disks and memory
    stopped_by: string | null; // stopped with the alert's Stop button
    stopped_at: string | null;
  };
  checked_at: string;
}

export interface ArtemisCheck {
  server_id: number;
  software_id: number;
  source: 'beat' | 'start' | 'manual';
  checked_at: string;
  report: ArtemisReport;
}

export interface ArtemisStatus {
  has_artemis: boolean;
  schedule: string;
  danger_percent: number;
  latest: ArtemisCheck | null;
}

// The latest Artemis reading on a server (DLQ / ExpiryQueue / memory) - database-only, cheap to poll.
export function useArtemisStatus(serverId: number) {
  return useQuery({
    queryKey: ['servers', serverId, 'artemis'],
    queryFn: () => api.get<ArtemisStatus>(`/servers/${serverId}/artemis`),
    refetchInterval: 30000,
  });
}

export function useArtemisCheckNow(serverId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ArtemisCheck>(`/servers/${serverId}/artemis-check`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers', serverId, 'artemis'] }),
  });
}

// Clear DLQ (admins): a run that deletes every message in the server's Artemis DLQ.
export function useClearDlq(serverId: number) {
  return useMutation({ mutationFn: () => api.post<{ jobId: number }>(`/servers/${serverId}/artemis/clear-dlq`) });
}

// The background check's interval in words: 120 -> "2 hours", 60 -> "hour", 30 -> "30 minutes".
export function intervalText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}

export interface ServiceEvent {
  at: string;
  kind: 'started' | 'stopped' | 'restarted' | 'crashed' | 'start_failed' | 'crash_loop' | 'reloaded' | 'enabled' | 'disabled' | 'masked' | 'unmasked';
  detail: string | null;
  // healthcheck = a run in Healthcheck (actor = who); terminal = a person's sudo / polkit command (actor = their
  // account on the server); outside = not through sudo, person unknown; systemd = restarted it; itself = ended
  // with nobody asking; reboot / boot = the server restarting / starting up
  source: 'healthcheck' | 'terminal' | 'outside' | 'systemd' | 'itself' | 'reboot' | 'boot';
  actor: string | null;
  job_id: number | null;
  job_kind: string | null;
  origin: 'journal' | 'snapshot' | null;
  command: string | null;
  terminal: string | null;
  // root shells open at the time, when the person isn't known
  sessions: { user: string; how: string; tty: string | null; since: string }[] | null;
  probable: boolean;
  // "kept crashing": how many times, until when
  count: number | null;
  until_at: string | null;
  // a crash nobody asked for: how long it had been running before it (seconds; null = not known)
  ran_for_s: number | null;
}

// "6 days", "3 hours", "25 minutes"
export function durationText(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

export interface ServiceHistoryData {
  days: number;
  interval_minutes: number | null;
  last_read_at: string | null;
  // how this server's history is read: journal = everything and who; snapshot = systemd's timestamps only
  mode: 'journal' | 'snapshot' | null;
  journal_kept: boolean | null; // does the server's journal survive a restart
  ssh_user: string | null;
  events: ServiceEvent[];
}

// A service's starts, stops, restarts and crashes, and who did them (read at each check and after each run).
export function useServiceHistory(serverId: number, softwareId: number) {
  return useQuery({
    queryKey: ['servers', serverId, 'history', softwareId],
    queryFn: () => api.get<ServiceHistoryData>(`/servers/${serverId}/software/${softwareId}/history`),
    refetchInterval: 30000,
  });
}

// What the latest heartbeat found wrong with WildFly anywhere - database-only, cheap to poll.
export function useBeatAlerts() {
  return useQuery({
    queryKey: ['alerts'],
    queryFn: () =>
      api.get<{
        interval_minutes: number | null;
        artemis_schedule: string;
        crash_check_minutes: number | null;
        alerts: BeatAlert[];
        crash_stopped: BeatAlert[];
      }>('/alerts'),
    refetchInterval: 30000,
  });
}

// The services on a server whose database account the logs showed locked / expired / refused, not marked fixed yet
// ("It's fixed" is offered on their rows). `users`: the accounts, empty when the log didn't say which.
export function useDbAccountTroubles(serverId: number) {
  return useQuery({
    queryKey: ['servers', serverId, 'db-account-troubles'],
    queryFn: () => api.get<{ software_id: number; users: string[] }[]>(`/servers/${serverId}/db-account-troubles`),
    refetchInterval: 15000,
  });
}

// "It's fixed": the account's errors so far are left out on every service that signs in with it, and those are
// looked at again (answers once that's done, a few seconds).
export function useDbAccountFixed(serverId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (softwareId: number) => api.post<{ users: string[]; rechecked: number }>(`/servers/${serverId}/software/${softwareId}/db-account-fixed`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// The crash popup's Stop: stops a service that keeps crashing (without the stop order's check).
export function useStopCrashing() {
  return useMutation({
    mutationFn: ({ serverId, softwareId }: { serverId: number; softwareId: number }) =>
      api.post<{ jobId: number }>(`/servers/${serverId}/software/${softwareId}/stop-crashing`),
  });
}

export interface ServerComponentStatus {
  server_id: number;
  server_name: string;
  status: 'up' | 'down' | 'unknown';
  state: string;
  checked_at: string | null;
  detail: string | null;
}

export interface GroupStatus {
  interval_minutes: number | null;
  last_checked_at: string | null;
  items: { software_id: number; name: string; state: string; status: string; servers: ServerComponentStatus[] }[];
}

// Reads what the background heartbeat (and any job/scan) last recorded - cheap, database-only.
// Polled often enough that a new beat shows up within seconds of landing.
export function useGroupStatus(groupId: number) {
  return useQuery({
    queryKey: ['groups', groupId, 'status'],
    queryFn: () => api.get<GroupStatus>(`/groups/${groupId}/heartbeat`),
    refetchInterval: 15000,
  });
}
