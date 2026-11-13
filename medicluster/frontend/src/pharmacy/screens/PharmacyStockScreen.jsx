import React, { useEffect, useState, useCallback } from 'react';
import {
  Boxes,
  Plus,
  Search,
  AlertTriangle,
  Calendar,
  Barcode,
  CheckCircle,
  RefreshCw,
  AlertCircle,
  Edit,
} from 'lucide-react';
import {
  getPharmacyStock,
  addPharmacyStock,
  updatePharmacyStock,
} from '../api.js';

function isNearExpiry(expiryDateStr) {
  if (!expiryDateStr) return false;
  const exp = new Date(expiryDateStr).getTime();
  const diffDays = (exp - Date.now()) / (1000 * 60 * 60 * 24);
  return diffDays > 0 && diffDays <= 30;
}

function isExpired(expiryDateStr) {
  if (!expiryDateStr) return false;
  return new Date(expiryDateStr).getTime() < Date.now();
}

export default function PharmacyStockScreen({ pharmacyName }) {
  const [stockList, setStockList] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successNote, setSuccessNote] = useState('');

  // Add stock modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newDrug, setNewDrug] = useState('');
  const [newStrength, setNewStrength] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [newQuantity, setNewQuantity] = useState(100);
  const [newBatch, setNewBatch] = useState('BAT-2026A');
  const [newExpiry, setNewExpiry] = useState('2027-12-31');
  const [newThreshold, setNewThreshold] = useState(20);
  const [saving, setSaving] = useState(false);

  const loadStock = useCallback(async () => {
    try {
      const data = await getPharmacyStock();
      setStockList(Array.isArray(data) ? data : data?.items || []);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load pharmacy stock inventory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStock();
  }, [loadStock]);

  const handleAdjustQuantity = async (stockItem, delta) => {
    const updatedQty = Math.max(0, (stockItem.quantity || 0) + delta);
    try {
      await updatePharmacyStock({ id: stockItem.id, quantity: updatedQty });
      setStockList((prev) =>
        prev.map((item) => (item.id === stockItem.id ? { ...item, quantity: updatedQty } : item))
      );
      setSuccessNote(`Updated ${stockItem.drug} quantity to ${updatedQty}.`);
      setTimeout(() => setSuccessNote(''), 3000);
    } catch (err) {
      setError(err.message || 'Failed to update stock quantity.');
    }
  };

  const handleAddStock = async (e) => {
    e.preventDefault();
    if (!newDrug) return;
    setSaving(true);
    setError('');
    try {
      const item = {
        drug: newDrug,
        strength: newStrength,
        barcode: newBarcode,
        quantity: Number(newQuantity),
        batch: newBatch,
        expiry: newExpiry,
        lowStockThreshold: Number(newThreshold),
      };
      const created = await addPharmacyStock(item);
      setStockList((prev) => [created || item, ...prev]);
      setAddModalOpen(false);
      setSuccessNote(`Added ${newDrug} ${newStrength} to inventory.`);
      setTimeout(() => setSuccessNote(''), 3000);
      // Reset form
      setNewDrug('');
      setNewStrength('');
      setNewBarcode('');
    } catch (err) {
      setError(err.message || 'Failed to add medication to stock.');
    } finally {
      setSaving(false);
    }
  };

  const filteredStock = stockList.filter((item) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const drug = (item.drug || '').toLowerCase();
    const barcode = (item.barcode || '').toLowerCase();
    return drug.includes(q) || barcode.includes(q);
  });

  return (
    <div className="rx-content" data-testid="pharmacy-stock-screen">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#17251d' }}>
            Inventory & Stock
          </h2>
          <p className="rx-card-meta" style={{ marginTop: 2 }}>
            {pharmacyName ? `Stock at ${pharmacyName}` : 'Formulary tracking'}
          </p>
        </div>
        <button
          type="button"
          className="rx-btn"
          onClick={() => setAddModalOpen(true)}
          style={{ padding: '7px 14px', fontSize: 13 }}
          data-testid="add-stock-btn"
        >
          <Plus size={15} /> Add Drug
        </button>
      </div>

      {error && (
        <div className="rx-alert rx-alert-error" role="alert">
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}

      {successNote && (
        <div className="rx-alert rx-alert-success" role="alert">
          <CheckCircle size={18} style={{ flexShrink: 0 }} />
          <div>{successNote}</div>
        </div>
      )}

      {/* Search */}
      <div style={{ position: 'relative' }}>
        <Search
          size={16}
          style={{ position: 'absolute', left: 12, top: 12, color: '#7a8774', pointerEvents: 'none' }}
        />
        <input
          type="text"
          className="rx-input"
          placeholder="Search by drug name or barcode scan…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ paddingLeft: 36 }}
        />
      </div>

      {/* Stock list */}
      {loading ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '36px 16px' }}>
          <RefreshCw size={24} style={{ margin: '0 auto 8px auto', color: '#55664f' }} className="spin" />
          <div style={{ fontWeight: 600 }}>Loading inventory…</div>
        </div>
      ) : filteredStock.length === 0 ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '40px 16px', color: '#55664f' }}>
          <Boxes size={32} style={{ margin: '0 auto 10px auto', opacity: 0.6 }} />
          <div style={{ fontWeight: 600, fontSize: 15, color: '#17251d' }}>No stock items found</div>
          <div className="rx-card-meta" style={{ marginTop: 4 }}>
            Click "Add Drug" to record initial inventory.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredStock.map((item) => {
            const isLow = (item.quantity ?? 0) <= (item.lowStockThreshold ?? 15);
            const nearExp = isNearExpiry(item.expiry);
            const expired = isExpired(item.expiry);

            return (
              <div
                key={item.id || `${item.drug}-${item.batch}`}
                className="rx-card"
                data-testid={`stock-row-${item.id || item.drug}`}
              >
                <div className="rx-card-header">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 15, color: '#17251d' }}>
                        {item.drug}
                      </strong>
                      <span style={{ fontSize: 13, color: '#55664f' }}>
                        {item.strength}
                      </span>
                      {isLow && (
                        <span className="rx-badge rx-badge-rose" data-testid="low-stock-badge">
                          <AlertTriangle size={11} /> Low Stock ({item.quantity})
                        </span>
                      )}
                      {nearExp && !expired && (
                        <span className="rx-badge rx-badge-amber">
                          Expires Soon
                        </span>
                      )}
                      {expired && (
                        <span className="rx-badge rx-badge-rose">
                          Expired
                        </span>
                      )}
                    </div>

                    <div className="rx-card-meta" style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {item.barcode && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Barcode size={13} /> {item.barcode}
                        </span>
                      )}
                      {item.batch && <span>Batch: {item.batch}</span>}
                      {item.expiry && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Calendar size={13} /> Exp: {item.expiry}
                        </span>
                      )}
                      <span>Threshold: {item.lowStockThreshold || 15}</span>
                    </div>
                  </div>

                  {/* Quantity controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="rx-btn rx-btn-secondary"
                      style={{ width: 32, height: 32, padding: 0, fontSize: 16 }}
                      onClick={() => handleAdjustQuantity(item, -10)}
                      title="Decrease by 10"
                    >
                      -
                    </button>
                    <div
                      style={{
                        minWidth: 48,
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: 15,
                        color: isLow ? '#be123c' : '#17251d',
                      }}
                      data-testid={`stock-qty-${item.id || item.drug}`}
                    >
                      {item.quantity ?? 0}
                    </div>
                    <button
                      type="button"
                      className="rx-btn rx-btn-secondary"
                      style={{ width: 32, height: 32, padding: 0, fontSize: 16 }}
                      onClick={() => handleAdjustQuantity(item, +10)}
                      title="Increase by 10"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Stock Modal */}
      {addModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Add Medication to Stock</h3>
            <form onSubmit={handleAddStock} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="rx-field">
                <label htmlFor="new-drug-name">Drug Name</label>
                <input
                  id="new-drug-name"
                  type="text"
                  className="rx-input"
                  placeholder="e.g. Amoxicillin, Metformin"
                  value={newDrug}
                  onChange={(e) => setNewDrug(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="rx-field">
                  <label htmlFor="new-strength">Strength</label>
                  <input
                    id="new-strength"
                    type="text"
                    className="rx-input"
                    placeholder="e.g. 500mg, 10ml"
                    value={newStrength}
                    onChange={(e) => setNewStrength(e.target.value)}
                    required
                  />
                </div>
                <div className="rx-field">
                  <label htmlFor="new-barcode">Barcode</label>
                  <input
                    id="new-barcode"
                    type="text"
                    className="rx-input"
                    placeholder="e.g. 8901234567890"
                    value={newBarcode}
                    onChange={(e) => setNewBarcode(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="rx-field">
                  <label htmlFor="new-qty">Initial Quantity</label>
                  <input
                    id="new-qty"
                    type="number"
                    min="0"
                    className="rx-input"
                    value={newQuantity}
                    onChange={(e) => setNewQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="rx-field">
                  <label htmlFor="new-threshold">Low Threshold</label>
                  <input
                    id="new-threshold"
                    type="number"
                    min="1"
                    className="rx-input"
                    value={newThreshold}
                    onChange={(e) => setNewThreshold(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="rx-field">
                  <label htmlFor="new-batch">Batch Number</label>
                  <input
                    id="new-batch"
                    type="text"
                    className="rx-input"
                    value={newBatch}
                    onChange={(e) => setNewBatch(e.target.value)}
                  />
                </div>
                <div className="rx-field">
                  <label htmlFor="new-expiry">Expiry Date</label>
                  <input
                    id="new-expiry"
                    type="date"
                    className="rx-input"
                    value={newExpiry}
                    onChange={(e) => setNewExpiry(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
                <button
                  type="button"
                  className="rx-btn rx-btn-secondary"
                  onClick={() => setAddModalOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rx-btn"
                  disabled={saving || !newDrug}
                  data-testid="submit-add-stock-btn"
                >
                  {saving ? 'Saving…' : 'Add Medication'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
