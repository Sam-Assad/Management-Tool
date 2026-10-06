import { PERMISSION_GROUPS, PRESETS, roleName, type Permission } from '../auth/permissions';

// Pick a preset (Viewer / Operator / Admin), then fine-tune with the boxes. Viewing is always allowed.
export default function PermissionsEditor({ value, onChange, lockManageUsers }: { value: Permission[]; onChange: (p: Permission[]) => void; lockManageUsers?: boolean }) {
  const role = roleName(value);
  const toggle = (p: Permission, on: boolean) => onChange(on ? [...value, p] : value.filter((x) => x !== p));
  return (
    <div className="perm">
      <div className="perm-presets" role="radiogroup" aria-label="Role">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={role === p.label}
            className={`perm-preset${role === p.label ? ' on' : ''}`}
            onClick={() => onChange(lockManageUsers && !p.permissions.includes('manage_users') ? [...p.permissions, 'manage_users'] : p.permissions)}
          >
            <b>{p.label}</b>
            <span>{p.hint}</span>
          </button>
        ))}
        <span className={`perm-preset perm-custom${role === 'Custom' ? ' on' : ''}`} aria-hidden={role !== 'Custom'}>
          <b>Custom</b>
          <span>Your own selection below.</span>
        </span>
      </div>
      <div className="perm-groups">
        <div className="perm-group">
          <div className="perm-group-title">Always</div>
          <label className="perm-item perm-fixed">
            <input type="checkbox" checked disabled />
            <span>
              <b>View everything</b>
              <small>Servers, statuses, runs, alerts and Artemis readings.</small>
            </span>
          </label>
        </div>
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.title} className="perm-group">
            <div className="perm-group-title">{g.title}</div>
            {g.items.map((i) => {
              const locked = lockManageUsers && i.key === 'manage_users';
              return (
                <label key={i.key} className="perm-item" title={locked ? "You can't remove this from yourself." : undefined}>
                  <input type="checkbox" checked={value.includes(i.key)} disabled={locked} onChange={(e) => toggle(i.key, e.target.checked)} />
                  <span>
                    <b>{i.label}</b>
                    <small>{i.hint}</small>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
