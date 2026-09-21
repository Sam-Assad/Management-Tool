export type SoftwareKind = 'service' | 'jar';
export type DetectMethod = 'systemd' | 'process_fragment' | 'jar_path_fragment';
export type RestartMethod = 'systemd' | 'script' | 'captured';
export type ConnectionStatus = 'unknown' | 'ok' | 'unreachable' | 'auth_failed';
export type JobKind = 'start_all' | 'start_one' | 'restart_all' | 'restart_one' | 'stop_all' | 'stop_one' | 'scan';
export type JobStatus = 'running' | 'succeeded' | 'failed';
export type StepStatus = 'pending' | 'running' | 'healthy' | 'failed' | 'skipped' | 'blocked';
export type StatusSource = 'scan' | 'heartbeat';
export type ComponentStatus = 'up' | 'down';

export interface Group {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Server {
  id: number;
  group_id: number;
  name: string;
  host: string;
  port: number;
  ssh_username: string;
  ssh_key_path: string;
  connection_status: ConnectionStatus;
  last_connected_at: string | null;
  created_at: string;
}

export interface SoftwareDefinition {
  id: number;
  name: string;
  kind: SoftwareKind;
  detect_method: DetectMethod;
  detect_value: string;
  start_cmd: string;
  stop_cmd: string;
  restart_method: RestartMethod;
  start_script_path: string | null;
  stop_script_path: string | null;
  log_path: string | null;
  success_pattern: string | null;
  error_pattern: string | null;
  health_timeout_s: number;
  default_rank: number | null;
  created_at: string;
}

export interface GroupSoftware {
  id: number;
  group_id: number;
  software_id: number;
  sequence_order: number;
  software?: SoftwareDefinition;
}

export interface JobRun {
  id: number;
  group_id: number | null;
  kind: JobKind;
  status: JobStatus;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface JobStep {
  id: number;
  job_run_id: number;
  server_id: number;
  software_id: number;
  action: 'start' | 'stop' | 'rollback' | 'free_port' | 'health_check';
  status: StepStatus;
  log_excerpt: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface HeartbeatLogEntry {
  id: number;
  server_id: number;
  software_id: number;
  source: StatusSource;
  status: ComponentStatus;
  detail: string | null;
  checked_at: string;
}

export interface GroupSummaryItem {
  software_id: number;
  name: string;
  status: ComponentStatus | 'partial' | 'unknown';
}

export type ConditionType = 'start_before' | 'stop_before';

export interface Condition {
  id: number;
  type: ConditionType;
  subject_id: number;
  target_id: number;
  subject_name: string;
  target_name: string;
  note: string | null;
  enabled: number;
  created_at: string;
}
