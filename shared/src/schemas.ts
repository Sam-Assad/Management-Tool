import { z } from 'zod';

export const CreateGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
});

export const CreateServerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  ssh_username: z.string().min(1),
  password: z.string().min(1),
});

export const UpdateServerSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ssh_username: z.string().min(1).optional(),
});

export const CreateSoftwareDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['service', 'jar']),
  detect_method: z.enum(['systemd', 'process_fragment', 'jar_path_fragment']),
  detect_value: z.string().min(1),
  start_cmd: z.string().optional().default(''),
  stop_cmd: z.string().optional().default(''),
  restart_method: z.enum(['systemd', 'script', 'captured']).default('captured'),
  start_script_path: z.string().optional().nullable(),
  stop_script_path: z.string().optional().nullable(),
  log_path: z.string().optional().nullable(),
  success_pattern: z.string().optional().nullable(),
  error_pattern: z.string().optional().nullable(),
  health_timeout_s: z.number().int().min(1).default(120),
});

export const SetGroupSoftwareSchema = z.object({
  items: z.array(
    z.object({
      software_id: z.number().int(),
      sequence_order: z.number().int(),
    })
  ),
});

export type CreateGroupInput = z.infer<typeof CreateGroupSchema>;
export type CreateServerInput = z.infer<typeof CreateServerSchema>;
export type UpdateServerInput = z.infer<typeof UpdateServerSchema>;
export type CreateSoftwareDefinitionInput = z.infer<typeof CreateSoftwareDefinitionSchema>;
export type SetGroupSoftwareInput = z.infer<typeof SetGroupSoftwareSchema>;

// Ordering conditions: 'start_before' shapes the start order, 'stop_before' the stop order; `type` is here so other kinds of
// condition can be added without reshaping the table or the API.
export const ConditionTypeSchema = z.enum(['start_before', 'stop_before']);

export const CreateConditionSchema = z.object({
  type: ConditionTypeSchema.default('start_before'),
  subject_id: z.number().int(),
  target_id: z.number().int(),
  note: z.string().optional().nullable(),
});

export const UpdateConditionSchema = z.object({
  enabled: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export type CreateConditionInput = z.infer<typeof CreateConditionSchema>;
export type UpdateConditionInput = z.infer<typeof UpdateConditionSchema>;

// What the operator answers when a Start/Restart/Stop All run pauses on a component that won't come up:
// retry it, skip it, stop the run, roll back (stop what this run started), or free a port that blocks it.
export const JobDecisionSchema = z.object({
  choice: z.enum(['retry', 'skip', 'halt', 'rollback', 'free_port']),
});
export type JobDecisionInput = z.infer<typeof JobDecisionSchema>;
