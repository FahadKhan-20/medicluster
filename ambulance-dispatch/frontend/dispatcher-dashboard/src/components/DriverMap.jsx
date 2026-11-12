import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Box, Typography, Chip } from '@mui/material';

import { STREET_MAP_STYLE } from '../services/mapStyle';
import { getStatusLabel } from '../services/statusLabels';

/* ── DOM Marker Generators ── */
function createDriverMarkerElement(coords) {
  const wrapper = document.createElement('div');
  wrapper.className = 'driver-marker-wrapper driver-live-pin';
  wrapper.setAttribute('data-testid', 'crew-map-pin');
  wrapper.style.cursor = 'pointer';
  if (coords) {
    wrapper.setAttribute('title', `Crew · ${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`);
  }

  const inner = document.createElement('div');
  inner.style.position = 'relative';
  inner.style.width = '42px';
  inner.style.height = '42px';
  inner.style.borderRadius = '50%';
  inner.style.background = '#2563EB';
  inner.style.border = '3px solid #FFFFFF';
  inner.style.boxShadow = '0 4px 16px rgba(37,99,235,0.5)';
  inner.style.display = 'flex';
  inner.style.alignItems = 'center';
  inner.style.justifyContent = 'center';

  inner.innerHTML = `
    <div class="driver-vehicle-rotator" style="width:22px;height:22px;display:flex;align-items:center;justify-content:center;transition:transform 0.2s linear;">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="6" width="14" height="11" rx="2" fill="white"/>
        <path d="M17 9l4 2v6h-4V9z" fill="white"/>
        <circle cx="7.5" cy="17.5" r="2.5" fill="#0F172A"/>
        <circle cx="17.5" cy="17.5" r="2.5" fill="#0F172A"/>
        <path d="M10 8.5v6M7 11.5h6" stroke="#2563EB" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
  `;
  wrapper.appendChild(inner);
  return wrapper;
}

function createIncidentMarkerElement(coords) {
  const wrapper = document.createElement('div');
  wrapper.className = 'incident-marker-wrapper incident-live-pin';
  wrapper.setAttribute('data-testid', 'incident-map-pin');
  if (coords) {
    wrapper.setAttribute('title', `Incident · ${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`);
  }
  wrapper.innerHTML = `
    <div style="width:36px;height:36px;border-radius:50%;background:#EF4444;border:3px solid #FFFFFF;box-shadow:0 4px 14px rgba(239,68,68,0.5);display:flex;align-items:center;justify-content:center;font-size:16px;">
      🚨
    </div>
  `;
  return wrapper;
}

function createHospitalMarkerElement(coords) {
  const wrapper = document.createElement('div');
  wrapper.className = 'hospital-marker-wrapper hospital-live-pin';
  wrapper.setAttribute('data-testid', 'hospital-map-pin');
  if (coords) {
    wrapper.setAttribute('title', `Hospital · ${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`);
  }
  wrapper.innerHTML = `
    <div style="width:34px;height:34px;border-radius:10px;background:#2563EB;border:2.5px solid #FFFFFF;box-shadow:0 4px 12px rgba(37,99,235,0.4);display:flex;align-items:center;justify-content:center;font-size:16px;">
      🏥
    </div>
  `;
  return wrapper;
}

export default function DriverMap({ driverPos, incident, missionStatus, hospital, height = '100%' }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const driverMarkerRef = useRef(null);
  const incidentMarkerRef = useRef(null);
  const hospitalMarkerRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [heading, setHeading] = useState(0);
  const [hasWebGL, setHasWebGL] = useState(true);
  const prevPosRef = useRef(null);

  const curLat = driverPos?.lat ?? driverPos?.latitude;
  const curLng = driverPos?.lng ?? driverPos?.longitude;

  /* ── Init MapLibre Map ── */
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const initialLngLat = [curLng || 77.5946, curLat || 12.9716];

    let map = null;
    try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: STREET_MAP_STYLE,
        center: initialLngLat,
        zoom: 15,
        pitch: 35,
        bearing: 0,
        attributionControl: { compact: false },
      });

      map.on('load', () => {
        setMapReady(true);
        map.resize();

        // Add driver marker
        const el = createDriverMarkerElement({ lat: curLat || 12.9716, lng: curLng || 77.5946 });
        driverMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(initialLngLat)
          .addTo(map);
      });

      mapInstanceRef.current = map;
    } catch (err) {
      console.warn('[DriverMap] MapLibre WebGL unavailable, falling back:', err);
      setHasWebGL(false);
      setMapReady(true);
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (mapInstanceRef.current) mapInstanceRef.current.resize();
    });
    resizeObserver.observe(mapContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  /* ── Update Driver Position & Heading Rotation ── */
  useEffect(() => {
    if (!curLat || !curLng) return;
    const currentLngLat = [curLng, curLat];

    if (mapInstanceRef.current && driverMarkerRef.current) {
      driverMarkerRef.current.setLngLat(currentLngLat);
      const el = driverMarkerRef.current.getElement();
      if (el) {
        el.setAttribute('title', `Crew · ${Number(curLat).toFixed(5)}, ${Number(curLng).toFixed(5)}`);
      }
    } else if (mapInstanceRef.current && mapReady && !driverMarkerRef.current) {
      const el = createDriverMarkerElement({ lat: curLat, lng: curLng });
      driverMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(currentLngLat)
        .addTo(mapInstanceRef.current);
    }

    if (prevPosRef.current) {
      const dLat = curLat - prevPosRef.current.lat;
      const dLng = curLng - prevPosRef.current.lng;
      if (Math.abs(dLat) > 0.00001 || Math.abs(dLng) > 0.00001) {
        const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
        setHeading(deg);

        if (driverMarkerRef.current) {
          const el = driverMarkerRef.current.getElement();
          if (el) {
            const rotator = el.querySelector('.driver-vehicle-rotator');
            if (rotator) rotator.style.transform = `rotate(${deg}deg)`;
          }
        }
      }
    }
    prevPosRef.current = { lat: curLat, lng: curLng };

    if (mapInstanceRef.current && ['EN_ROUTE', 'EN_ROUTE_TO_SCENE', 'TRANSPORTING', 'TRANSPORTING_TO_HOSPITAL'].includes(missionStatus)) {
      mapInstanceRef.current.easeTo({
        center: currentLngLat,
        bearing: 0,
        pitch: 0,
        duration: 800,
        easing: (t) => t,
      });
    }
  }, [curLat, curLng, heading, missionStatus, mapReady]);

  /* ── Render Navigation Route & Incident/Hospital Markers ── */
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReady) return;
    const map = mapInstanceRef.current;

    const incLat = incident?.location_lat ?? incident?.lat;
    const incLng = incident?.location_lng ?? incident?.lng;
    const hospLat = hospital?.latitude ?? hospital?.lat;
    const hospLng = hospital?.longitude ?? hospital?.lng;

    // Manage incident marker
    if (incLat && incLng) {
      const incLngLat = [incLng, incLat];
      if (!incidentMarkerRef.current) {
        incidentMarkerRef.current = new maplibregl.Marker({ element: createIncidentMarkerElement({ lat: incLat, lng: incLng }), anchor: 'center' })
          .setLngLat(incLngLat)
          .addTo(map);
      } else {
        incidentMarkerRef.current.setLngLat(incLngLat);
      }
    } else if (incidentMarkerRef.current) {
      incidentMarkerRef.current.remove();
      incidentMarkerRef.current = null;
    }

    // Manage hospital marker
    if (hospLat && hospLng) {
      const hospLngLat = [hospLng, hospLat];
      if (!hospitalMarkerRef.current) {
        hospitalMarkerRef.current = new maplibregl.Marker({ element: createHospitalMarkerElement({ lat: hospLat, lng: hospLng }), anchor: 'center' })
          .setLngLat(hospLngLat)
          .addTo(map);
      } else {
        hospitalMarkerRef.current.setLngLat(hospLngLat);
      }
    } else if (hospitalMarkerRef.current) {
      hospitalMarkerRef.current.remove();
      hospitalMarkerRef.current = null;
    }

    // Fetch and draw road route
    if (curLat && curLng && incLat && incLng) {
      const from = [curLng, curLat];
      const isHospitalTarget = ['TRANSPORTING', 'TRANSPORTING_TO_HOSPITAL', 'ARRIVED_AT_HOSPITAL', 'AT_HOSPITAL'].includes(missionStatus) && hospLat && hospLng;
      const target = isHospitalTarget ? [hospLng, hospLat] : [incLng, incLat];

      const applyRoute = (geojson) => {
        if (!mapInstanceRef.current) return;
        if (map.getSource('driver-route-source')) {
          map.getSource('driver-route-source').setData(geojson);
        } else {
          map.addSource('driver-route-source', { type: 'geojson', data: geojson });
          map.addLayer({
            id: 'driver-route-casing',
            type: 'line',
            source: 'driver-route-source',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#1E40AF', 'line-width': 8, 'line-opacity': 0.6 },
          });
          map.addLayer({
            id: 'driver-route-line',
            type: 'line',
            source: 'driver-route-source',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#2563EB', 'line-width': 5, 'line-opacity': 1.0 },
          });
        }
      };

      const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${target[0]},${target[1]}?overview=full&geometries=geojson`;

      fetch(url)
        .then(res => res.json())
        .then(data => {
          if (data?.routes?.[0]?.geometry) {
            applyRoute({
              type: 'Feature',
              geometry: data.routes[0].geometry,
            });
          } else {
            // Direct straight-line fallback
            applyRoute({
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [from, target],
              },
            });
          }
        })
        .catch(() => {
          // Direct straight-line fallback on network error
          applyRoute({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [from, target],
            },
          });
        });
    } else if (map.getSource('driver-route-source')) {
      // Clear route when not active
      map.getSource('driver-route-source').setData({
        type: 'FeatureCollection',
        features: [],
      });
    }
  }, [incident, hospital, missionStatus, mapReady, curLat, curLng]);

  const activeLabel = getStatusLabel(missionStatus) || 'Standby';

  return (
    <Box data-testid="driver-map" sx={{ position: 'relative', width: '100%', height, minHeight: 180 }}>
      <div ref={mapContainerRef} className="driver-map-canvas" style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }} />

      {!hasWebGL && (
        <Box sx={{
          position: 'absolute', inset: 0, bgcolor: 'var(--sf2, #F1F5F9)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 1, p: 2,
        }}>
          <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--tx, #0F172A)' }}>
            Map (OSM Street) · GPS: {curLat?.toFixed(4)}, {curLng?.toFixed(4)}
          </Typography>
          <div className="driver-marker-wrapper driver-live-pin" data-testid="crew-map-pin" title={`Crew · ${curLat?.toFixed(5)}, ${curLng?.toFixed(5)}`}>
            📍 Crew Position
          </div>
          {incident && (
            <div className="incident-marker-wrapper incident-live-pin" data-testid="incident-map-pin">
              🚨 Incident: {incident.incident_type || 'Active Emergency'}
            </div>
          )}
          {hospital && (
            <div className="hospital-marker-wrapper hospital-live-pin" data-testid="hospital-map-pin">
              🏥 Hospital: {hospital.name || 'Receiving Hospital'}
            </div>
          )}
        </Box>
      )}

      {/* Speed overlay */}
      <Box sx={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 10,
        bgcolor: 'rgba(15,23,42,0.85)', borderRadius: 2, px: 1.5, py: 0.8,
        border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)',
      }}>
        <Typography variant="h6" sx={{ color: 'white', fontWeight: 900, lineHeight: 1, fontFamily: 'monospace' }}>
          {['EN_ROUTE', 'EN_ROUTE_TO_SCENE', 'TRANSPORTING', 'TRANSPORTING_TO_HOSPITAL'].includes(missionStatus) ? '42' : '0'}
        </Typography>
        <Typography variant="caption" sx={{ color: '#94A3B8', fontSize: '0.65rem' }}>km/h</Typography>
      </Box>

      {/* Status badge */}
      <Box sx={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <Chip
          label={activeLabel.toUpperCase()}
          sx={{
            bgcolor: ['EN_ROUTE', 'EN_ROUTE_TO_SCENE'].includes(missionStatus) ? '#EF4444' : ['TRANSPORTING', 'TRANSPORTING_TO_HOSPITAL'].includes(missionStatus) ? '#2563EB' : missionStatus === 'ON_SCENE' ? '#F97316' : '#10B981',
            color: 'white', fontWeight: 800, fontSize: '0.75rem',
            boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          }}
        />
      </Box>

      {/* GPS live indicator */}
      <Box sx={{
        position: 'absolute', top: 12, right: 12, zIndex: 10,
        bgcolor: 'rgba(15,23,42,0.85)', borderRadius: 1.5, px: 1, py: 0.5,
        display: 'flex', alignItems: 'center', gap: 0.5,
        border: '1px solid rgba(16,185,129,0.3)',
      }}>
        <Box sx={{
          width: 7, height: 7, borderRadius: '50%', bgcolor: '#10B981',
          animation: 'gps-blink 1.5s infinite',
          '@keyframes gps-blink': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.2 } },
        }} />
        <Typography variant="caption" sx={{ color: '#10B981', fontSize: '0.65rem', fontWeight: 800 }}>GPS LIVE</Typography>
      </Box>
    </Box>
  );
}
