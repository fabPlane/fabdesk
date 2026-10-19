import { Input, Select } from "../components/ui";
import {
  DEFAULT_LASER_STENCIL_PRESET,
  LASER_STENCIL_PRESET_IDS,
  LASER_STENCIL_UI_PRESETS,
  laserStencilFormDefaults,
  parseLaserNumber,
  type LaserStencilPresetId,
  type LaserStencilUiPreset,
} from "@fabdesk/client-core";

export type LaserStencilFormState = {
  preset: LaserStencilPresetId;
  apertureOffsetMm: string;
  kerfMm: string;
  powerPct: string;
  speedMmPerS: string;
  frequencyKhz: string;
  pulseNs: string;
  passes: string;
  alignmentHoleMm: string;
  includeFiducials: boolean;
};

export function laserStencilFormFromPreset(id: LaserStencilPresetId): LaserStencilFormState {
  const p = laserStencilFormDefaults(id);
  return {
    preset: id,
    apertureOffsetMm: String(p.apertureOffsetMm),
    kerfMm: String(p.kerfMm),
    powerPct: String(p.powerPct),
    speedMmPerS: String(p.speedMmPerS),
    frequencyKhz: String(p.frequencyKhz),
    pulseNs: String(p.pulseNs),
    passes: String(p.passes),
    alignmentHoleMm: String(p.alignmentHoleMm),
    includeFiducials: p.includeFiducials,
  };
}

export const DEFAULT_LASER_STENCIL_FORM = laserStencilFormFromPreset(DEFAULT_LASER_STENCIL_PRESET);

export function laserStencilToolArgs(form: LaserStencilFormState): Record<string, unknown> {
  const apertureOffsetMm = parseLaserNumber(form.apertureOffsetMm);
  const kerfMm = parseLaserNumber(form.kerfMm);
  const powerPct = parseLaserNumber(form.powerPct);
  const speedMmPerS = parseLaserNumber(form.speedMmPerS);
  const frequencyKhz = parseLaserNumber(form.frequencyKhz);
  const pulseNs = parseLaserNumber(form.pulseNs);
  const passes = parseLaserNumber(form.passes);
  const alignmentHoleMm = parseLaserNumber(form.alignmentHoleMm);
  return {
    preset: form.preset,
    includeFiducials: form.includeFiducials,
    ...(apertureOffsetMm != null ? { apertureOffsetMm } : {}),
    ...(kerfMm != null ? { kerfMm } : {}),
    ...(powerPct != null ? { powerPct } : {}),
    ...(speedMmPerS != null ? { speedMmPerS } : {}),
    ...(frequencyKhz != null ? { frequencyKhz } : {}),
    ...(pulseNs != null ? { pulseNs } : {}),
    ...(passes != null ? { passes: Math.round(passes) } : {}),
    ...(alignmentHoleMm != null ? { alignmentHoleMm } : {}),
  };
}

function Field({
  label,
  value,
  onChange,
  step,
  min,
  max,
  unit,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step: string;
  min?: string;
  max?: string;
  unit: string;
  name: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-fg">
      {label}
      <span className="flex items-center gap-1">
        <Input
          name={name}
          className="h-8 px-2 text-xs"
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <span className="shrink-0 text-[10px] font-normal text-muted">{unit}</span>
      </span>
    </label>
  );
}

export function LaserStencilPresetPanel({
  form,
  onChange,
}: {
  form: LaserStencilFormState;
  onChange: (next: LaserStencilFormState) => void;
}) {
  const preset: LaserStencilUiPreset = LASER_STENCIL_UI_PRESETS[form.preset];
  const shrink = parseLaserNumber(form.apertureOffsetMm);
  const kerf = parseLaserNumber(form.kerfMm);
  const combined = shrink != null && kerf != null ? shrink + kerf : null;
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-bg/40 p-3" data-testid="laser-stencil-preset">
      <label className="flex flex-col gap-1 text-xs font-medium">
        Material preset
        <Select
          aria-label="Laser stencil material preset"
          value={form.preset}
          onChange={(e) => onChange(laserStencilFormFromPreset(e.target.value as LaserStencilPresetId))}
        >
          {LASER_STENCIL_PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {LASER_STENCIL_UI_PRESETS[id].label}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-xs leading-5 text-muted">
        {preset.thicknessMm.toFixed(3)} mm · {preset.material}
      </p>
      <div>
        <p className="text-xs font-medium">Kerf / aperture shrink</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field
            label="Paste-release shrink"
            name="apertureOffsetMm"
            value={form.apertureOffsetMm}
            onChange={(apertureOffsetMm) => onChange({ ...form, apertureOffsetMm })}
            step="0.005"
            min="-1"
            max="2"
            unit="mm/side"
          />
          <Field
            label="Kerf compensation"
            name="kerfMm"
            value={form.kerfMm}
            onChange={(kerfMm) => onChange({ ...form, kerfMm })}
            step="0.005"
            min="0"
            max="1"
            unit="mm/side"
          />
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-muted">
          Combined inward offset{combined != null ? `: ${combined.toFixed(3)} mm/side` : ""}. Both values are starting
          points — measure a coupon and edit.
        </p>
      </div>
      <div>
        <p className="text-xs font-medium">Starting-point laser settings</p>
        <p className="mt-0.5 text-[11px] leading-5 text-muted">
          Editable starting points for a ComMarker Omni X 355 nm UV, not certified recipes. Written into the LightBurn
          .lbrn2 job.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field
            label="Power"
            name="powerPct"
            value={form.powerPct}
            onChange={(powerPct) => onChange({ ...form, powerPct })}
            step="1"
            min="0"
            max="100"
            unit="%"
          />
          <Field
            label="Speed"
            name="speedMmPerS"
            value={form.speedMmPerS}
            onChange={(speedMmPerS) => onChange({ ...form, speedMmPerS })}
            step="10"
            min="1"
            unit="mm/s"
          />
          <Field
            label="Frequency"
            name="frequencyKhz"
            value={form.frequencyKhz}
            onChange={(frequencyKhz) => onChange({ ...form, frequencyKhz })}
            step="1"
            min="1"
            unit="kHz"
          />
          <Field
            label="Passes"
            name="passes"
            value={form.passes}
            onChange={(passes) => onChange({ ...form, passes })}
            step="1"
            min="1"
            unit="passes"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          Pulse {form.pulseNs} ns · 150 mm lens table. Confirm pulse width in LightBurn device settings after a coupon.
        </p>
      </div>
      <div>
        <p className="text-xs font-medium">Fiducials / registration</p>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-[var(--fd-accent)]"
            checked={form.includeFiducials}
            onChange={(e) => onChange({ ...form, includeFiducials: e.target.checked })}
          />
          Frame-corner holes plus board NPTH
        </label>
        <div className="mt-2 max-w-[12rem]">
          <Field
            label="Hole diameter"
            name="alignmentHoleMm"
            value={form.alignmentHoleMm}
            onChange={(alignmentHoleMm) => onChange({ ...form, alignmentHoleMm })}
            step="0.1"
            min="0.5"
            unit="mm"
          />
        </div>
      </div>
      <p className="text-[11px] leading-5 text-muted">
        Export writes a LightBurn .lbrn2 job (layers + starting-point cut settings) and layered SVG/DXF for EZCAD /
        ComMarker Studio.
      </p>
    </div>
  );
}
