/**
 * Tunable parameters. A brain declares a `params` spec; the coach control
 * panel renders a slider per param and can re-run the match with new values
 * instantly — no recompile. The KNOBS are agreed with your AI assistant (it
 * codes them); the VALUES are yours to turn.
 */
export interface ParamSpec {
  /** Default value, used when no override is supplied. */
  default: number;
  min: number;
  max: number;
  /** Slider granularity. */
  step: number;
  /** Optional human label for the control panel (falls back to the key). */
  label?: string;
}

export type ParamsSpec = Record<string, ParamSpec>;

/** Resolved param values passed to `decide`. */
export type ParamValues = Record<string, number>;

/** Build the default value map from a spec. */
export function defaultParams(spec?: ParamsSpec): ParamValues {
  const out: ParamValues = {};
  if (!spec) return out;
  for (const key of Object.keys(spec)) out[key] = spec[key]!.default;
  return out;
}

/** Merge overrides over a brain's defaults, clamping to each param's range. */
export function resolveParams(spec: ParamsSpec | undefined, overrides?: ParamValues): ParamValues {
  const out = defaultParams(spec);
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      const v = overrides[key]!;
      const s = spec?.[key];
      out[key] = s ? Math.max(s.min, Math.min(s.max, v)) : v;
    }
  }
  return out;
}
