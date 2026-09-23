import { readFile } from 'node:fs/promises';

const RATE_FIELDS = ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'];

function validateSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Price schedule must be a JSON object');
  if (typeof value.model !== 'string' || !value.model.trim()) throw new TypeError('Price schedule requires a model name');
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw new TypeError('Price schedule currency must be a three-letter uppercase code');
  if (typeof value.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.effectiveDate) || Number.isNaN(Date.parse(`${value.effectiveDate}T00:00:00Z`))) throw new TypeError('Price schedule effectiveDate must be YYYY-MM-DD');
  for (const key of RATE_FIELDS) if (!Number.isFinite(value[key]) || value[key] < 0) throw new TypeError(`Price schedule ${key} must be a non-negative number`);
  return Object.freeze({ model: value.model, currency: value.currency, effectiveDate: value.effectiveDate, inputPerMillion: value.inputPerMillion, cachedInputPerMillion: value.cachedInputPerMillion, outputPerMillion: value.outputPerMillion });
}

/** Load an optional, explicit price schedule. No default/vendor pricing is assumed. */
export async function loadPriceSchedule(path, { model, asOf = new Date() } = {}) {
  if (!path) return null;
  const schedule = validateSchedule(JSON.parse(await readFile(path, 'utf8')));
  if (model && schedule.model !== model) throw new Error(`Price schedule is for ${schedule.model}, not ${model}`);
  const date = asOf instanceof Date ? asOf.toISOString().slice(0, 10) : String(asOf).slice(0, 10);
  if (schedule.effectiveDate > date) throw new Error(`Price schedule is not effective until ${schedule.effectiveDate}`);
  return schedule;
}

/** Calculate indicative cost using distinct cached and uncached input rates. */
export function priceUsage(usage, schedule) {
  if (!schedule) return null;
  const rates = validateSchedule(schedule);
  const input = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const cached = usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0;
  const output = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  for (const [key, value] of Object.entries({ input, cached, output })) if (!Number.isFinite(value) || value < 0) throw new TypeError(`Usage ${key} must be a non-negative number`);
  if (cached > input) throw new RangeError('Cached input tokens cannot exceed total input tokens');
  const uncachedInput = input - cached;
  const uncachedInputCost = uncachedInput * rates.inputPerMillion / 1_000_000;
  const cachedInputCost = cached * rates.cachedInputPerMillion / 1_000_000;
  const outputCost = output * rates.outputPerMillion / 1_000_000;
  return { model: rates.model, currency: rates.currency, effectiveDate: rates.effectiveDate, inputCost: uncachedInputCost, cachedInputCost, outputCost, total: uncachedInputCost + cachedInputCost + outputCost };
}
