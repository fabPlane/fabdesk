import { DisclosureSummary } from "../components/DisclosureSummary";
import { Button, Input, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";

export function ComMarkerMaterialPreset({ disabled, desktop, onCoupon }: { disabled: boolean; desktop: boolean; onCoupon: () => void }) {
  const stock = useUiStore(s => s.commarkerStock);
  const setStock = useUiStore(s => s.setComMarkerStock);
  const foil = Number(stock.foilUm);
  const key = stock.lens && Number.isFinite(foil) && foil > 0 ? `${stock.lens}:${foil}` : "";
  const profile = useUiStore(s => s.commarkerMaterials[key]);
  const setProfile = useUiStore(s => s.setComMarkerMaterial);
  const name = profile?.name ?? "", note = profile?.note ?? "";
  return <div className="space-y-2 text-xs">
    <p className="leading-5 text-muted">
      {name.trim() ? <>In Studio’s Material Library, select <strong className="break-words text-fg">{name.trim()}</strong> for the {stock.lens} mm lens and {foil} µm foil. </> : <>Select your tested 6W copper preset in Studio’s Material Library. </>}
      For new stock, use <strong>Array → Material Test Array</strong>.
    </p>
    {note.trim() && <p className="break-words leading-5 text-muted"><strong>Tested settings</strong> · {note.trim()}</p>}
    <details className="rounded-md border border-border px-2">
      <DisclosureSummary label="Omni X setup" icon="settings" variant="compact"
        badge={key ? <span className="whitespace-nowrap">{stock.lens} mm · {foil} µm</span> : undefined} />
      <fieldset disabled={disabled} className="space-y-2 pb-3">
        <p className="leading-5 text-muted">Connect the Omni X by USB and look for <strong>Connected</strong> in Studio.
          {stock.lens && <> With the {stock.lens} mm lens fitted, select <strong>Field Lens {stock.lens === "150" ? "B" : "A"}</strong>.</>}</p>
        <div className="grid grid-cols-2 gap-2">
          <label>Lens
            <Select aria-label="Lens" className="mt-1 w-full" value={stock.lens} onChange={e => setStock({ ...stock, lens: e.target.value as typeof stock.lens })}>
              <option value="">Choose lens</option><option value="70">70 mm</option><option value="150">150 mm</option>
            </Select></label>
          <label>Foil thickness (µm)
            <Input className="mt-1" type="number" min="0" step="any" value={stock.foilUm}
              onChange={e => setStock({ ...stock, foilUm: e.target.value })} /></label>
        </div>
        <label className="block">Material Library name
          <Input className="mt-1" disabled={!key} maxLength={120} value={name}
            onChange={e => setProfile(key, { name: e.target.value, note })} placeholder="Name saved in Studio" /></label>
        <label className="block">Tested settings note
          <Input className="mt-1" disabled={!key} maxLength={240} value={note}
            onChange={e => setProfile(key, { name, note: e.target.value })} placeholder="Fill interval or other tested settings" /></label>
        <p className="leading-5 text-muted">Saved on this computer for this lens and foil. Apply the settings in Studio.</p>
        <Button size="sm" variant="secondary" onClick={onCoupon}>{desktop ? "Open test coupon" : "Download test coupon"}</Button>
        <p className="leading-5 text-muted">Check the import with two traces on a 20 × 12 mm sample.</p>
      </fieldset>
    </details>
  </div>;
}
