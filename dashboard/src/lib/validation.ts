import type { ProvisionRequest } from '../api/contracts';

export interface ProvisionInput {
  name: string;
  team: string;
  ttlHours: string;
}

/** Client-side validation mirrors the documented API rules; the API remains authoritative. */
export function validateProvision(input: ProvisionInput): {
  errors: Partial<Record<'name' | 'team' | 'ttlHours', string>>;
  request?: ProvisionRequest;
} {
  const errors: Partial<Record<'name' | 'team' | 'ttlHours', string>> = {};
  const name = input.name.trim();
  const team = input.team.trim();
  const ttl = Number(input.ttlHours);
  if (!name) errors.name = 'Enter a sandbox name.';
  else if (!/^[a-z][a-z0-9-]{2,31}$/.test(name))
    errors.name = 'Use 3–32 lowercase letters, digits or hyphens, starting with a letter.';
  if (!team) errors.team = 'Enter the owning team.';
  else if (team.length > 64) errors.team = 'Team name must be 64 characters or fewer.';
  if (input.ttlHours.trim() === '' || !Number.isInteger(ttl) || ttl < 1 || ttl > 72)
    errors.ttlHours = 'Enter a whole number of hours between 1 and 72.';
  if (Object.keys(errors).length > 0) return { errors };
  return { errors, request: { name, team, ttl_hours: ttl } };
}
