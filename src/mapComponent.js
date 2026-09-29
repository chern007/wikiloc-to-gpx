import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Capacitor } from '@capacitor/core';

// Fix Leaflet default marker icons issue in bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

let currentMap = null;
let currentTrackLayer = null;
let currentMarkersLayer = null;
let cursorMarker = null;

// Map of POI marker instances by index
const poiMarkersMap = new Map();

// GPS tracking state
let userGpsMarker = null;
let userAccuracyCircle = null;
let gpsWatchId = null;
let isTrackingGps = false;
let followUser = true;
let lastKnownLocation = null;
let gpsStatusCallback = null;
let gpsButtonEl = null;

// Compass heading state
let currentHeading = null;
let currentUnwrappedHeading = 0;
let hasHeading = false;
let compassPluginListener = null;
let orientationHandler = null;

function processHeading(targetHeading) {
  if (!hasHeading) {
    hasHeading = true;
    currentUnwrappedHeading = targetHeading;
    return targetHeading;
  }

  // Normalize current rotation into [0, 360) and compute shortest difference (-180 to +180)
  const normCurrent = ((currentUnwrappedHeading % 360) + 360) % 360;
  const diff = ((targetHeading - normCurrent + 540) % 360) - 180;

  // Deadband threshold: filter out micro-tremors from hands (< 0.7 degrees)
  if (Math.abs(diff) < 0.7) {
    return currentUnwrappedHeading;
  }

  // Dynamic low-pass filter: high stability on small movements, snappy on turns
  let alpha;
  if (Math.abs(diff) < 5) {
    alpha = 0.22;
  } else if (Math.abs(diff) < 25) {
    alpha = 0.40;
  } else {
    alpha = 0.65;
  }

  currentUnwrappedHeading += diff * alpha;
  return currentUnwrappedHeading;
}

export function updateUserHeading(heading) {
  if (heading == null || isNaN(heading)) return;
  currentHeading = heading;
  const rot = processHeading(heading);

  if (userGpsMarker) {
    const markerEl = userGpsMarker.getElement();
    if (markerEl) {
      const beamEl = markerEl.querySelector('.user-compass-beam');
      if (beamEl) {
        beamEl.style.display = 'block';
        beamEl.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      }
    }
  }
}

/**
 * Initializes or updates Leaflet map with track and waypoints
 */
export function renderRouteMap(containerId, coordinates, waypoints = []) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!currentMap) {
    currentMap = L.map(containerId, {
      zoomControl: false,
      attributionControl: false
    });

    // Custom native Leaflet Control for Fit Route & GPS
    const MapActionsControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function() {
        const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-custom-tools');

        // 1. Fit Bounds (Zoom Extensión) button
        const fitBtn = L.DomUtil.create('a', 'leaflet-tool-btn btn-fit-bounds', bar);
        fitBtn.href = '#';
        fitBtn.title = 'Ver ruta completa (Zoom Extensión)';
        fitBtn.setAttribute('role', 'button');
        fitBtn.setAttribute('aria-label', 'Ver ruta completa');
        fitBtn.innerHTML = `
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          </svg>
        `;

        // 2. GPS Location button
        const gpsBtn = L.DomUtil.create('a', 'leaflet-tool-btn btn-gps-location', bar);
        gpsBtn.href = '#';
        gpsBtn.title = 'Mi ubicación GPS / Seguir ruta';
        gpsBtn.setAttribute('role', 'button');
        gpsBtn.setAttribute('aria-label', 'Mi ubicación GPS');
        gpsBtn.innerHTML = `
          <svg class="gps-svg-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <line x1="12" y1="2" x2="12" y2="6"/>
            <line x1="12" y1="18" x2="12" y2="22"/>
            <line x1="2" y1="12" x2="6" y2="12"/>
            <line x1="18" y1="12" x2="22" y2="12"/>
          </svg>
        `;

        gpsButtonEl = gpsBtn;

        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.disableScrollPropagation(bar);

        L.DomEvent.on(fitBtn, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          fitRouteBounds();
        });

        L.DomEvent.on(gpsBtn, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          toggleGpsTracking();
        });

        return bar;
      }
    });

    L.control.zoom({ position: 'bottomright' }).addTo(currentMap);
    new MapActionsControl().addTo(currentMap);
    L.control.attribution({ position: 'bottomleft', prefix: false })
      .addAttribution('&copy; <a href="https://openstreetmap.org">OSM</a> | OpenTopoMap')
      .addTo(currentMap);

    // Tile Layers
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    });

    const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18
    });

    osmLayer.addTo(currentMap);

    const baseMaps = {
      "Mapa Senderos": osmLayer,
      "Topográfico": topoLayer,
      "Satélite": satelliteLayer
    };

    L.control.layers(baseMaps, null, { position: 'topright' }).addTo(currentMap);

    currentTrackLayer = L.featureGroup().addTo(currentMap);
    currentMarkersLayer = L.featureGroup().addTo(currentMap);
  } else {
    if (!currentTrackLayer) {
      currentTrackLayer = L.featureGroup().addTo(currentMap);
    } else {
      currentTrackLayer.clearLayers();
    }
    if (!currentMarkersLayer) {
      currentMarkersLayer = L.featureGroup().addTo(currentMap);
    } else {
      currentMarkersLayer.clearLayers();
    }
    poiMarkersMap.clear();
    if (cursorMarker) {
      cursorMarker.remove();
      cursorMarker = null;
    }
  }

  // 1. Draw track polyline
  const latLngs = coordinates.map(c => [c[1], c[0]]);

  // Outline for high contrast on satellite/topo
  L.polyline(latLngs, {
    color: '#ffffff',
    weight: 7,
    opacity: 0.85
  }).addTo(currentTrackLayer);

  L.polyline(latLngs, {
    color: '#274D2E', // Forest green
    weight: 4.5,
    opacity: 0.95,
    smoothFactor: 1
  }).addTo(currentTrackLayer);

  // Start & Finish Markers
  if (latLngs.length > 0) {
    const startPoint = latLngs[0];
    const endPoint = latLngs[latLngs.length - 1];

    const startIcon = L.divIcon({
      className: 'custom-map-pin start-pin',
      html: `<div class="pin-inner start-inner"><span>S</span></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const endIcon = L.divIcon({
      className: 'custom-map-pin end-pin',
      html: `<div class="pin-inner end-inner"><span>F</span></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    L.marker(startPoint, { icon: startIcon, title: 'Inicio de ruta' })
      .bindPopup('<b>Inicio de la Ruta</b>')
      .addTo(currentMarkersLayer);

    const distMeters = currentMap.distance(startPoint, endPoint);
    if (distMeters > 50) {
      L.marker(endPoint, { icon: endIcon, title: 'Fin de ruta' })
        .bindPopup('<b>Fin de la Ruta</b>')
        .addTo(currentMarkersLayer);
    }
  }

  // 2. Waypoints / POIs
  waypoints.forEach((wp, idx) => {
    if (!wp.lat || !wp.lon) return;

    let iconSymbol = '📍';
    const typeLower = (wp.pictogramName || '').toLowerCase();
    if (typeLower.includes('panorám') || typeLower.includes('mirador')) iconSymbol = '👁️';
    else if (typeLower.includes('cascada') || typeLower.includes('agua') || typeLower.includes('río')) iconSymbol = '💧';
    else if (typeLower.includes('túnel') || typeLower.includes('cueva')) iconSymbol = '🔦';
    else if (typeLower.includes('puente')) iconSymbol = '🌉';
    else if (typeLower.includes('bosque')) iconSymbol = '🌲';

    const poiIcon = L.divIcon({
      className: 'custom-map-pin poi-pin',
      html: `<div class="pin-inner poi-inner" title="${wp.name}"><span>${iconSymbol}</span></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const popupContent = `
      <div class="poi-popup-card">
        ${wp.photoUrl ? `<div class="poi-popup-img"><img src="${wp.photoUrl}" alt="${wp.name}"/></div>` : ''}
        <div class="poi-popup-body">
          <span class="poi-popup-tag">${wp.pictogramName || 'Punto de Interés'}</span>
          <h4 class="poi-popup-title">${wp.name}</h4>
          ${wp.elevation != null ? `<div class="poi-popup-ele">⛰️ Altitud: <strong>${wp.elevation} m</strong></div>` : ''}
        </div>
      </div>
    `;

    const marker = L.marker([wp.lat, wp.lon], { icon: poiIcon })
      .bindPopup(popupContent, { maxWidth: 260, className: 'nature-leaflet-popup' })
      .addTo(currentMarkersLayer);

    poiMarkersMap.set(idx, marker);
  });

  // Fit bounds immediately and with cascading delays to guarantee complete track visibility
  fitRouteBounds();
  setTimeout(fitRouteBounds, 120);
  setTimeout(fitRouteBounds, 350);
  setTimeout(fitRouteBounds, 750);

  return currentMap;
}

/**
 * Fits the map view to the entire route bounds (Zoom Extensión)
 */
export function fitRouteBounds() {
  if (!currentMap || !currentTrackLayer) return;
  currentMap.invalidateSize();
  const bounds = currentTrackLayer.getBounds();
  if (bounds.isValid()) {
    currentMap.fitBounds(bounds, {
      padding: [40, 40],
      maxZoom: 16
    });
  }
}

/**
 * Centers and zooms into a specific POI marker and opens its popup
 */
export function focusPoi(idx) {
  if (!currentMap) return;
  const marker = poiMarkersMap.get(idx);
  if (marker) {
    currentMap.invalidateSize();
    const latLng = marker.getLatLng();
    currentMap.setView(latLng, 16, { animate: true });
    marker.openPopup();

    const mapEl = document.getElementById('routeMap');
    if (mapEl) {
      mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

/**
 * Toggles GPS location tracking on the map
 */
export async function toggleGpsTracking(onStatusChange) {
  if (onStatusChange) gpsStatusCallback = onStatusChange;

  if (isTrackingGps) {
    if (!followUser && lastKnownLocation) {
      // Re-center on user and resume follow mode
      followUser = true;
      currentMap.setView([lastKnownLocation.lat, lastKnownLocation.lon], 16, { animate: true });
      notifyGpsStatus({ active: true, following: true, ...lastKnownLocation });
      return;
    }
    // Turn off
    stopGpsTracking();
    return;
  }

  await startGpsTracking(onStatusChange);
}

/**
 * Starts continuous GPS tracking
 */
export async function startGpsTracking(onStatusChange) {
  if (onStatusChange) gpsStatusCallback = onStatusChange;

  if (!navigator.geolocation) {
    alert('Tu dispositivo no dispone de sensor GPS o geolocalización.');
    notifyGpsStatus({ active: false, following: false, error: 'GPS no soportado' });
    return;
  }

  // If Capacitor native, request permission via plugin
  if (Capacitor.isNativePlatform()) {
    try {
      const { WikilocExtractor } = Capacitor.Plugins;
      if (WikilocExtractor && typeof WikilocExtractor.requestLocationPermission === 'function') {
        await WikilocExtractor.requestLocationPermission();
      }
    } catch (e) {
      console.warn('Permiso location nativo:', e);
    }
  }

  // 1. Start native Android compass if available (exclusive source)
  let nativeCompassActive = false;
  if (Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.WikilocExtractor) {
    try {
      if (typeof Capacitor.Plugins.WikilocExtractor.startCompass === 'function') {
        await Capacitor.Plugins.WikilocExtractor.startCompass();
      }
      compassPluginListener = await Capacitor.Plugins.WikilocExtractor.addListener('compassUpdate', (data) => {
        if (data && data.heading != null) {
          updateUserHeading(data.heading);
        }
      });
      nativeCompassActive = true;
    } catch (e) {
      console.warn('Fallo al iniciar brújula nativa:', e);
    }
  }

  // 2. Browser orientation listener (ONLY as fallback when native compass is NOT active)
  if (!nativeCompassActive) {
    orientationHandler = (e) => {
      let heading = null;
      if (e.webkitCompassHeading != null) {
        heading = e.webkitCompassHeading;
      } else if (e.alpha != null && (e.absolute === true || !window.chrome)) {
        heading = (360 - e.alpha) % 360;
      }
      if (heading != null && !isNaN(heading)) {
        updateUserHeading(heading);
      }
    };

    if (window.DeviceOrientationEvent) {
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', orientationHandler, true);
      } else {
        window.addEventListener('deviceorientation', orientationHandler, true);
      }
    }
  }

  notifyGpsStatus({ active: true, following: true, loading: true });
  isTrackingGps = true;
  followUser = true;

  if (currentMap) {
    currentMap.on('dragstart', handleUserMapDrag);
  }

  let isFirstFix = true;

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      const accuracy = position.coords.accuracy || 12;
      const alt = position.coords.altitude;
      const heading = position.coords.heading;

      if (heading != null && !isNaN(heading) && (position.coords.speed || 0) > 0.6) {
        updateUserHeading(heading);
      }

      lastKnownLocation = { lat, lon, accuracy, alt };

      updateUserLocationMarker(lat, lon, accuracy);

      if (isFirstFix || followUser) {
        if (currentMap) {
          const currentZoom = currentMap.getZoom();
          const targetZoom = Math.max(currentZoom, 16);
          if (isFirstFix) {
            currentMap.setView([lat, lon], targetZoom, { animate: true });
            isFirstFix = false;
          } else {
            currentMap.panTo([lat, lon], { animate: true });
          }
        }
      }

      notifyGpsStatus({
        active: true,
        following: followUser,
        loading: false,
        lat,
        lon,
        accuracy: Math.round(accuracy)
      });
    },
    (err) => {
      console.error('Error de geolocalización GPS:', err);
      let errMsg = 'No se pudo obtener la señal GPS.';
      if (err.code === 1) errMsg = 'Permiso de ubicación denegado. Activa el GPS en Ajustes.';
      else if (err.code === 2) errMsg = 'Buscando señal GPS...';
      else if (err.code === 3) errMsg = 'Tiempo de espera de GPS agotado.';

      if (err.code === 1) {
        stopGpsTracking();
        alert(errMsg);
      }
      notifyGpsStatus({ active: isTrackingGps, following: followUser, error: errMsg });
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1500,
      timeout: 15000
    }
  );
}

/**
 * Stops GPS tracking and clears user marker
 */
export function stopGpsTracking() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  // Remove compass listeners
  if (compassPluginListener) {
    try {
      compassPluginListener.remove();
    } catch (e) {}
    compassPluginListener = null;
  }
  if (Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.WikilocExtractor) {
    try {
      if (typeof Capacitor.Plugins.WikilocExtractor.stopCompass === 'function') {
        Capacitor.Plugins.WikilocExtractor.stopCompass();
      }
    } catch (e) {}
  }
  if (orientationHandler) {
    window.removeEventListener('deviceorientationabsolute', orientationHandler, true);
    window.removeEventListener('deviceorientation', orientationHandler, true);
    orientationHandler = null;
  }
  currentHeading = null;
  hasHeading = false;

  isTrackingGps = false;
  followUser = false;

  if (currentMap) {
    currentMap.off('dragstart', handleUserMapDrag);
  }

  if (userGpsMarker) {
    userGpsMarker.remove();
    userGpsMarker = null;
  }
  if (userAccuracyCircle) {
    userAccuracyCircle.remove();
    userAccuracyCircle = null;
  }

  notifyGpsStatus({ active: false, following: false });
}

function handleUserMapDrag() {
  if (isTrackingGps && followUser) {
    followUser = false;
    notifyGpsStatus({ active: true, following: false, ...lastKnownLocation });
  }
}

function notifyGpsStatus(status) {
  if (gpsButtonEl) {
    if (status.active) {
      gpsButtonEl.classList.add('active');
      if (status.following) {
        gpsButtonEl.classList.add('following');
        gpsButtonEl.title = 'Siguiendo ruta en tiempo real (Toca para pausar)';
      } else {
        gpsButtonEl.classList.remove('following');
        gpsButtonEl.title = 'Centrar en mi ubicación';
      }
    } else {
      gpsButtonEl.classList.remove('active');
      gpsButtonEl.classList.remove('following');
      gpsButtonEl.title = 'Mi ubicación GPS / Seguir ruta';
    }
  }

  if (typeof gpsStatusCallback === 'function') {
    gpsStatusCallback(status);
  }
}

export function updateUserLocationMarker(lat, lon, accuracy) {
  if (!currentMap) return;
  const latLng = [lat, lon];

  // 1. Accuracy Circle
  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(latLng, {
      radius: accuracy,
      color: '#0284c7',
      weight: 1.5,
      opacity: 0.7,
      fillColor: '#38bdf8',
      fillOpacity: 0.15
    }).addTo(currentMap);
  } else {
    userAccuracyCircle.setLatLng(latLng);
    userAccuracyCircle.setRadius(accuracy);
  }

  // 2. Pulse Dot Marker with Compass Directional Beam
  if (!userGpsMarker) {
    const isBeamVisible = (currentHeading != null);
    const icon = L.divIcon({
      className: 'user-gps-container',
      html: `
        <div class="user-gps-wrapper">
          <div class="user-compass-beam" style="${isBeamVisible ? `transform: rotate(${currentUnwrappedHeading.toFixed(1)}deg); display: block;` : 'display: none;'}">
            <svg class="compass-beam-svg" width="64" height="64" viewBox="0 0 64 64">
              <defs>
                <radialGradient id="compassBeamGrad" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
                  <stop offset="0%" stop-color="#0284c7" stop-opacity="0.55"/>
                  <stop offset="60%" stop-color="#38bdf8" stop-opacity="0.22"/>
                  <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0"/>
                </radialGradient>
              </defs>
              <path d="M 32 32 L 14 5 A 32 32 0 0 1 50 5 Z" fill="url(#compassBeamGrad)" />
              <polygon points="32,10 38,24 32,20 26,24" fill="#0284c7" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="user-gps-marker">
            <div class="user-gps-pulse"></div>
          </div>
        </div>
      `,
      iconSize: [64, 64],
      iconAnchor: [32, 32],
      popupAnchor: [0, -18]
    });

    userGpsMarker = L.marker(latLng, {
      icon,
      zIndexOffset: 1000
    })
      .bindPopup('<b>📍 Tu Ubicación Actual</b><br><small>Precisión: ±' + Math.round(accuracy) + ' m</small>')
      .addTo(currentMap);
  } else {
    userGpsMarker.setLatLng(latLng);
    if (userGpsMarker.getPopup()) {
      userGpsMarker.getPopup().setContent('<b>📍 Tu Ubicación Actual</b><br><small>Precisión: ±' + Math.round(accuracy) + ' m</small>');
    }
  }
}

/**
 * Renders an SVG elevation profile synced with coordinates
 */
export function renderElevationProfile(containerId, coordinates) {
  const container = document.getElementById(containerId);
  if (!container || !coordinates || coordinates.length === 0) return;

  const pointsWithEle = coordinates.filter(c => c.length > 2 && c[2] != null);
  if (pointsWithEle.length < 5) {
    container.innerHTML = '<div class="no-ele-msg">Perfil de elevación no disponible para esta ruta.</div>';
    return;
  }

  // Calculate cumulative distance and elevations
  let totalDistance = 0;
  const data = [];

  function haversineDist(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  for (let i = 0; i < pointsWithEle.length; i++) {
    if (i > 0) {
      const prev = pointsWithEle[i-1];
      const curr = pointsWithEle[i];
      totalDistance += haversineDist(prev[1], prev[0], curr[1], curr[0]);
    }
    data.push({
      dist: totalDistance,
      ele: pointsWithEle[i][2],
      lat: pointsWithEle[i][1],
      lon: pointsWithEle[i][0]
    });
  }

  const minEle = Math.min(...data.map(d => d.ele));
  const maxEle = Math.max(...data.map(d => d.ele));
  const eleSpan = Math.max(20, maxEle - minEle);
  const maxDist = totalDistance;

  const width = 800;
  const height = 180;
  const padLeft = 45;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // Build SVG Path
  const pointsString = data.map(d => {
    const x = padLeft + (d.dist / maxDist) * plotW;
    const y = padTop + plotH - ((d.ele - minEle) / eleSpan) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const areaPath = `M ${padLeft},${padTop + plotH} L ${pointsString} L ${padLeft + plotW},${padTop + plotH} Z`;
  const linePath = `M ${pointsString}`;

  container.innerHTML = `
    <div class="elevation-chart-wrapper">
      <div class="elevation-chart-header">
        <span class="ele-stat-pill">Cota Mín: <strong>${Math.round(minEle)} m</strong></span>
        <span class="ele-stat-pill">Cota Máx: <strong>${Math.round(maxEle)} m</strong></span>
        <span class="ele-stat-pill">Distancia: <strong>${maxDist.toFixed(2)} km</strong></span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="elevation-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="natureEleGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#386641" stop-opacity="0.45"/>
            <stop offset="70%" stop-color="#A3C69D" stop-opacity="0.15"/>
            <stop offset="100%" stop-color="#EBF2E7" stop-opacity="0.0"/>
          </linearGradient>
        </defs>

        <!-- Grid lines -->
        <line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" stroke="#E0E8DC" stroke-width="1" stroke-dasharray="4"/>
        <line x1="${padLeft}" y1="${padTop + plotH/2}" x2="${width - padRight}" y2="${padTop + plotH/2}" stroke="#E0E8DC" stroke-width="1" stroke-dasharray="4"/>
        <line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="#CBD9C6" stroke-width="1.5"/>

        <!-- Y Axis Labels -->
        <text x="${padLeft - 8}" y="${padTop + 4}" font-size="11" fill="#5C6E5E" text-anchor="end">${Math.round(maxEle)}m</text>
        <text x="${padLeft - 8}" y="${padTop + plotH/2 + 4}" font-size="11" fill="#5C6E5E" text-anchor="end">${Math.round((maxEle + minEle)/2)}m</text>
        <text x="${padLeft - 8}" y="${padTop + plotH + 4}" font-size="11" fill="#5C6E5E" text-anchor="end">${Math.round(minEle)}m</text>

        <!-- X Axis Labels -->
        <text x="${padLeft}" y="${height - 8}" font-size="11" fill="#5C6E5E" text-anchor="start">0 km</text>
        <text x="${padLeft + plotW/2}" y="${height - 8}" font-size="11" fill="#5C6E5E" text-anchor="middle">${(maxDist/2).toFixed(1)} km</text>
        <text x="${padLeft + plotW}" y="${height - 8}" font-size="11" fill="#5C6E5E" text-anchor="end">${maxDist.toFixed(1)} km</text>

        <!-- Area & Line -->
        <path d="${areaPath}" fill="url(#natureEleGrad)"/>
        <path d="${linePath}" fill="none" stroke="#274D2E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  `;
}
