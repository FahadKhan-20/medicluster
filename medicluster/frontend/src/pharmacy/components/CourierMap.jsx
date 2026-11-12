import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

function toCoord(pt) {
  if (!pt) return null;
  const lat = Number(pt.lat ?? pt.latitude);
  const lng = Number(pt.lng ?? pt.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return [lat, lng];
  }
  return null;
}

export default function CourierMap({
  courierLocation,
  pharmacyLocation,
  patientLocation,
}) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const initial = toCoord(courierLocation) || toCoord(pharmacyLocation) || [12.9716, 77.5946];
    const map = L.map(hostRef.current, { zoomControl: false }).setView(initial, 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(hostRef.current);

    mapRef.current = map;

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const group = L.layerGroup().addTo(map);
    const points = [];

    // Pharmacy pickup pin
    const pharmCoord = toCoord(pharmacyLocation);
    if (pharmCoord) {
      points.push(pharmCoord);
      const pharmEl = document.createElement('div');
      pharmEl.setAttribute('data-testid', 'pharmacy-pin');
      pharmEl.innerHTML = '<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#0284c7;color:#fff;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.2);">Rx</span>';
      L.marker(pharmCoord, {
        icon: L.divIcon({
          className: 'rx-map-pin-pharmacy',
          html: pharmEl.outerHTML,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: pharmacyLocation.name || 'Pharmacy Pickup',
      }).addTo(group);
    }

    // Patient delivery destination pin
    const patCoord = toCoord(patientLocation);
    if (patCoord) {
      points.push(patCoord);
      const patEl = document.createElement('div');
      patEl.setAttribute('data-testid', 'delivery-destination-pin');
      patEl.innerHTML = '<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#15803d;color:#fff;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.2);">⌂</span>';
      L.marker(patCoord, {
        icon: L.divIcon({
          className: 'rx-map-pin-patient',
          html: patEl.outerHTML,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: patientLocation.text || 'Patient Delivery Address',
      }).addTo(group);
    }

    // Courier live location pin
    const courierCoord = toCoord(courierLocation);
    if (courierCoord) {
      points.push(courierCoord);
      const courierEl = document.createElement('div');
      courierEl.setAttribute('data-testid', 'courier-live-pin');
      courierEl.setAttribute('title', `Courier · ${courierCoord[0].toFixed(5)}, ${courierCoord[1].toFixed(5)}`);
      courierEl.innerHTML = '<span style="display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#be123c;color:#fff;font-weight:bold;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);">🛵</span>';
      L.marker(courierCoord, {
        icon: L.divIcon({
          className: 'rx-map-pin-courier',
          html: courierEl.outerHTML,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
        title: `Courier Live · ${courierCoord[0].toFixed(5)}, ${courierCoord[1].toFixed(5)}`,
      }).addTo(group);
    }

    if (points.length > 0) {
      if (points.length === 1) {
        map.setView(points[0], 14);
      } else {
        map.fitBounds(L.latLngBounds(points), { padding: [35, 35], maxZoom: 16 });
      }
    }

    return () => {
      group.remove();
    };
  }, [courierLocation, pharmacyLocation, patientLocation]);

  return (
    <div
      ref={hostRef}
      className="rx-courier-map"
      data-testid="courier-osm-map"
      aria-label="Courier live delivery route map"
    />
  );
}
