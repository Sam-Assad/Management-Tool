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

export interface BeatAlert {
  // wildfly: can't take traffic / database problem; artemis: its own beat found memory too high
  kind: 'wildfly' | 'artemis';
  server_id: number;
  server_name: string;
  software_id: number;
  software_name: string;
  state: 'not_ready' | 'datasource_down' | 'memory_high';
  detail: string | null;
  artemis?: ArtemisReport;
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

// What the latest heartbeat found wrong with WildFly anywhere - database-only, cheap to poll.
export function useBeatAlerts() {
  return useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.get<{ interval_minutes: number | null; artemis_schedule: string; alerts: BeatAlert[] }>('/alerts'),
    refetchInterval: 30000,
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
