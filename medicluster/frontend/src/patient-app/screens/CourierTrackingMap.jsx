import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const coordinate = (point) => {
  if (!point) return null;
  const lat = point.latitude ?? point.lat;
  const lng = point.longitude ?? point.lng;
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
};

export default function CourierTrackingMap({ courierLocation, deliveryAddress, pharmacyLocation }) {
  const host = useRef(null);
  const map = useRef(null);

  useEffect(() => {
    if (!host.current) return;
    const initialCenter =
      coordinate(courierLocation) ||
      coordinate(deliveryAddress) ||
      coordinate(pharmacyLocation) ||
      [12.9716, 77.5946];

    map.current = L.map(host.current, { zoomControl: false }).setView(initialCenter, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map.current);

    L.control.zoom({ position: "bottomright" }).addTo(map.current);

    const observer = new ResizeObserver(() => map.current?.invalidateSize());
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current) return;
    const group = L.layerGroup().addTo(map.current);
    const points = [];

    // 1. Courier Pin
    const courierCoords = coordinate(courierLocation);
    if (courierCoords) {
      points.push(courierCoords);
      const courierIcon = L.divIcon({
        className: "pt-tracking-pin courier",
        html: '<span style="font-size: 14px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">🛵</span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      L.marker(courierCoords, { icon: courierIcon, title: "Courier location" })
        .bindTooltip("Courier en route")
        .addTo(group);
    }

    // 2. Delivery Destination Pin
    const destCoords = coordinate(deliveryAddress);
    if (destCoords) {
      points.push(destCoords);
      const destIcon = L.divIcon({
        className: "pt-tracking-pin destination",
        html: '<span style="font-size: 14px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">🏠</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker(destCoords, { icon: destIcon, title: "Delivery address" })
        .bindTooltip("Delivery Address")
        .addTo(group);
    }

    // 3. Pharmacy Origin Pin
    const pharmCoords = coordinate(pharmacyLocation);
    if (pharmCoords) {
      points.push(pharmCoords);
      const pharmIcon = L.divIcon({
        className: "pt-tracking-pin pharmacy",
        html: '<span style="font-size: 14px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">🏥</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker(pharmCoords, { icon: pharmIcon, title: "Fulfilling pharmacy" })
        .bindTooltip("Pharmacy")
        .addTo(group);
    }

    if (points.length > 1) {
      map.current.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 16 });
    } else if (points.length === 1) {
      map.current.setView(points[0], 14);
    }

    return () => group.remove();
  }, [courierLocation, deliveryAddress, pharmacyLocation]);

  return (
    <div
      ref={host}
      className="pt-map"
      style={{ height: "220px", width: "100%", borderRadius: "16px" }}
      aria-label="Courier live delivery tracking map"
    />
  );
}
