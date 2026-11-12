import { useState, useEffect, useCallback } from "react";
import {
  listPharmacies,
  createPrescription,
  listPrescriptions,
  cancelPrescription,
} from "../pharmacy/patientApi";
import { Tag } from "../components/ui";
import { Pager, usePageCapacity } from "../components/viewport-ui";
import { Plus, Trash2, Pill, CheckCircle2, AlertTriangle } from "lucide-react";

const PRESCRIPTION_STATUS_TONES = {
  active: "low",
  fulfilled: "normal",
  cancelled: "noise",
};

const DEFAULT_ITEM = () => ({
  drug: "",
  strength: "",
  form: "Tablet",
  dose: "1 tablet",
  frequency: "Once daily",
  durationDays: 7,
  quantity: 7,
  refills: 0,
  instructions: "Take after meals",
});

export default function PrescribePanel({ patientId }) {
  const [prescriptions, setPrescriptions] = useState([]);
  const [pharmacies, setPharmacies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Form state
  const [items, setItems] = useState([DEFAULT_ITEM()]);
  const [preferredPharmacyId, setPreferredPharmacyId] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState("");

  const loadData = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError("");
    try {
      const [rxList, pharmList] = await Promise.all([
        listPrescriptions(patientId).catch(() => []),
        listPharmacies().catch(() => []),
      ]);
      setPrescriptions(Array.isArray(rxList) ? rxList : rxList?.items || []);
      setPharmacies(Array.isArray(pharmList) ? pharmList : []);
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to load prescription data");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleItemChange = (index, field, value) => {
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const addItemRow = () => {
    setItems((prev) => [...prev, DEFAULT_ITEM()]);
  };

  const removeItemRow = (index) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePrescribeSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMsg("");

    // Validate
    const validItems = items.filter((it) => it.drug && it.drug.trim());
    if (validItems.length === 0) {
      setError("Please specify at least one medication name.");
      return;
    }

    for (const it of validItems) {
      const qty = Number(it.quantity);
      if (!qty || qty <= 0) {
        setError(`Please enter a valid quantity for ${it.drug}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload = {
        patientId,
        items: validItems.map((it) => ({
          drug: it.drug.trim(),
          strength: it.strength ? it.strength.trim() : it.dose?.trim(),
          form: it.form?.trim() || "Tablet",
          dose: it.dose?.trim() || "1 tablet",
          frequency: it.frequency?.trim() || "Once daily",
          durationDays: Number(it.durationDays) || 7,
          quantity: Number(it.quantity) || 1,
          refills: Number(it.refills) || 0,
          instructions: it.instructions?.trim() || "",
        })),
        notes: notes.trim(),
        pharmacyId: preferredPharmacyId || undefined,
      };

      await createPrescription(payload);
      setSuccessMsg("Prescription written successfully.");
      setItems([DEFAULT_ITEM()]);
      setNotes("");
      setPreferredPharmacyId("");
      await loadData();
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to create prescription");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (prescriptionId) => {
    setCancellingId(prescriptionId);
    setError("");
    try {
      await cancelPrescription(prescriptionId);
      await loadData();
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to cancel prescription");
    } finally {
      setCancellingId("");
    }
  };

  const pharmacyMap = new Map(pharmacies.map((p) => [p._id || p.id, p]));

  return (
    <div className="flex flex-col gap-6 overflow-y-auto flex-1 min-h-0 pr-1">
      {/* Prescribe Medication Form */}
      <section className="record-card shrink-0" style={{ flex: "none" }} aria-label="Prescribe medication">
        <div className="record-card-title flex justify-between items-center mb-3">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Pill size={16} />
            <span>New E-Prescription</span>
          </h2>
          <span className="text-xs text-slate-500 font-mono">Patient: {patientId}</span>
        </div>

        {error && (
          <div role="alert" className="p-3 mb-4 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div role="status" className="p-3 mb-4 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800 flex items-center gap-2">
            <CheckCircle2 size={14} className="shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handlePrescribeSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Medication Items
            </label>

            {items.map((it, idx) => (
              <div
                key={idx}
                className="p-3.5 border border-line rounded bg-surface/50 flex flex-col gap-3 relative group"
              >
                <div className="flex justify-between items-center">
                  <span className="text-xs font-mono font-medium text-slate-600">
                    Item #{idx + 1}
                  </span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItemRow(idx)}
                      className="text-red-600 hover:text-red-800 text-xs flex items-center gap-1"
                      title="Remove this item"
                    >
                      <Trash2 size={13} />
                      <span>Remove</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-600 mb-1">Drug Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Amoxicillin"
                      value={it.drug}
                      onChange={(e) => handleItemChange(idx, "drug", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Dose / Strength</label>
                    <input
                      type="text"
                      placeholder="e.g. 500 mg"
                      value={it.dose}
                      onChange={(e) => handleItemChange(idx, "dose", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Form</label>
                    <select
                      value={it.form}
                      onChange={(e) => handleItemChange(idx, "form", e.target.value)}
                      className="w-full h-8 px-2 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
                    >
                      <option value="Tablet">Tablet</option>
                      <option value="Capsule">Capsule</option>
                      <option value="Syrup">Syrup</option>
                      <option value="Injection">Injection</option>
                      <option value="Ointment">Ointment</option>
                      <option value="Drops">Drops</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Frequency</label>
                    <input
                      type="text"
                      placeholder="e.g. Twice daily"
                      value={it.frequency}
                      onChange={(e) => handleItemChange(idx, "frequency", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-600 mb-1">Duration (days)</label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={it.durationDays}
                      onChange={(e) => handleItemChange(idx, "durationDays", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Total Quantity *</label>
                    <input
                      type="number"
                      required
                      min={1}
                      max={1000}
                      value={it.quantity}
                      onChange={(e) => handleItemChange(idx, "quantity", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Refills Authorized</label>
                    <input
                      type="number"
                      min={0}
                      max={12}
                      value={it.refills}
                      onChange={(e) => handleItemChange(idx, "refills", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 mb-1">Instructions</label>
                    <input
                      type="text"
                      placeholder="e.g. Take with water"
                      value={it.instructions}
                      onChange={(e) => handleItemChange(idx, "instructions", e.target.value)}
                      className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
                    />
                  </div>
                </div>
              </div>
            ))}

            <div>
              <button
                type="button"
                onClick={addItemRow}
                className="inline-flex items-center gap-1.5 text-xs text-ink font-medium hover:underline py-1"
              >
                <Plus size={14} />
                <span>Add another medication</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-2 border-t border-line">
            <div>
              <label className="block text-slate-600 mb-1">
                Preferred Pharmacy (optional)
              </label>
              <select
                value={preferredPharmacyId}
                onChange={(e) => setPreferredPharmacyId(e.target.value)}
                className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
              >
                <option value="">Patient Choice / Any Pharmacy</option>
                {pharmacies.map((ph) => (
                  <option key={ph._id || ph.id} value={ph._id || ph.id}>
                    {ph.name} {ph.address ? `(${ph.address})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-600 mb-1">Doctor Notes (optional)</label>
              <input
                type="text"
                placeholder="Special clinical or dispensing instructions"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full h-8 px-2.5 rounded border border-line-strong bg-paper text-ink focus:outline-none focus:border-ink"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary h-9 px-5 text-xs font-semibold rounded"
            >
              {submitting ? "Writing prescription…" : "Prescribe Medication"}
            </button>
          </div>
        </form>
      </section>

      {/* Existing Prescriptions List */}
      <section className="record-card shrink-0" style={{ flex: "none" }} aria-label="Prescriptions on file">
        <div className="record-card-title flex justify-between items-center mb-3">
          <h2 className="text-[15px] font-semibold text-ink">
            Prescriptions On File <span>({prescriptions.length})</span>
          </h2>
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 py-3">Loading prescriptions…</p>
        ) : prescriptions.length === 0 ? (
          <p className="text-xs text-slate-500 py-3">
            No prescriptions recorded for this patient.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {prescriptions.map((rx) => {
              const rxId = rx._id || rx.id;
              const status = rx.status || "active";
              const tone = PRESCRIPTION_STATUS_TONES[status] || "noise";
              const pharmacy = rx.pharmacyId ? pharmacyMap.get(rx.pharmacyId) : null;
              const itemsList = Array.isArray(rx.items) ? rx.items : [];

              return (
                <div key={rxId} className="py-3 flex flex-col gap-2 text-xs">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold text-ink">
                          {rxId}
                        </span>
                        <Tag tone={tone}>{status}</Tag>
                      </div>
                      <span className="text-[11px] text-slate-500">
                        Prescribed {rx.createdAt ? new Date(rx.createdAt).toLocaleDateString([], { dateStyle: "medium" }) : "recently"}
                        {pharmacy ? ` · Preferred: ${pharmacy.name}` : ""}
                      </span>
                    </div>

                    {status === "active" && (
                      <button
                        type="button"
                        disabled={cancellingId === rxId}
                        onClick={() => handleCancel(rxId)}
                        className="btn-secondary text-[11px] py-1 px-2 text-red-700 hover:bg-red-50 border-red-200"
                      >
                        {cancellingId === rxId ? "Cancelling…" : "Cancel Prescription"}
                      </button>
                    )}
                  </div>

                  {/* Items */}
                  <div className="bg-surface/50 rounded p-2.5 border border-line/60 flex flex-col gap-1.5">
                    {itemsList.map((item, iIdx) => (
                      <div key={iIdx} className="flex justify-between items-baseline text-slate-700">
                        <div>
                          <strong className="text-ink">{item.drug}</strong>{" "}
                          <span className="text-slate-500 font-mono">
                            {item.strength || item.dose} {item.form ? `(${item.form})` : ""}
                          </span>{" "}
                          · {item.frequency} for {item.durationDays || 7} days
                          {item.instructions ? ` · "${item.instructions}"` : ""}
                        </div>
                        <span className="font-mono text-slate-600 font-medium whitespace-nowrap">
                          Qty: {item.quantity} {item.refills ? `(${item.refills} refills)` : ""}
                        </span>
                      </div>
                    ))}
                  </div>

                  {rx.notes && (
                    <div className="text-[11px] text-slate-500 italic">
                      Notes: {rx.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
