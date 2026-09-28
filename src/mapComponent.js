import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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

    L.control.zoom({ position: 'bottomright' }).addTo(currentMap);
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

    // Default to topo or OSM
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
    currentTrackLayer.clearLayers();
    currentMarkersLayer.clearLayers();
    if (cursorMarker) {
      cursorMarker.remove();
      cursorMarker = null;
    }
  }

  // 1. Draw track polyline
  // coordinates is [lon, lat, ele] -> Leaflet expects [lat, lon]
  const latLngs = coordinates.map(c => [c[1], c[0]]);

  // Forest green with subtle outline
  const bgPolyline = L.polyline(latLngs, {
    color: '#ffffff',
    weight: 7,
    opacity: 0.8
  }).addTo(currentTrackLayer);

  const mainPolyline = L.polyline(latLngs, {
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

    // If not a pure loop, add distinct finish pin
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

    let popupContent = `
      <div class="poi-popup-card">
        ${wp.photoUrl ? `<div class="poi-popup-img"><img src="${wp.photoUrl}" alt="${wp.name}"/></div>` : ''}
        <div class="poi-popup-body">
          <span class="poi-popup-tag">${wp.pictogramName || 'POI'}</span>
          <h4 class="poi-popup-title">${wp.name}</h4>
          ${wp.elevation != null ? `<div class="poi-popup-ele">⛰️ Altitud: <strong>${wp.elevation} m</strong></div>` : ''}
        </div>
      </div>
    `;

    L.marker([wp.lat, wp.lon], { icon: poiIcon })
      .bindPopup(popupContent, { maxWidth: 260, className: 'nature-leaflet-popup' })
      .addTo(currentMarkersLayer);
  });

  // Fit bounds with comfortable padding
  const bounds = currentTrackLayer.getBounds();
  if (bounds.isValid()) {
    currentMap.fitBounds(bounds, { padding: [30, 30] });
  }

  // Invalidate size after DOM layout stabilizes
  setTimeout(() => {
    if (currentMap) currentMap.invalidateSize();
  }, 200);

  return currentMap;
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
