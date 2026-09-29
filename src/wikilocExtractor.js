import { SAMPLE_ROUTE } from './sampleData.js';
import { Capacitor } from '@capacitor/core';

/**
 * Extracts route metadata, geometry, and POIs from Wikiloc page HTML
 */
export function parseWikilocHtml(html, originalUrl = '') {
  // 1. Look for var mapData = { ... };
  const mapDataMatch = html.match(/var\s+mapData\s*=\s*(\{[\s\S]*?\});/);
  if (!mapDataMatch) {
    // Check if Cloudflare blocked
    if (html.includes('Just a moment...') || html.includes('cf_clearance')) {
      throw new Error('CLOUDFLARE_BLOCKED');
    }
    throw new Error('No se encontró información de mapa (mapData) en la página.');
  }

  let parsed;
  try {
    parsed = JSON.parse(mapDataMatch[1]);
  } catch (err) {
    throw new Error('Error al parsear los datos de mapa: ' + err.message);
  }

  const rawTrail = parsed.mapData && parsed.mapData[0];
  if (!rawTrail || !rawTrail.geom) {
    throw new Error('La ruta no contiene polilínea geométrica.');
  }

  // 2. Extract title
  let name = rawTrail.nom;
  if (!name) {
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    name = titleMatch ? titleMatch[1].replace(/^Wikiloc\s*\|\s*/i, '').replace(/\|\s*Wikiloc$/i, '').trim() : 'Ruta Wikiloc';
  }

  // 3. Extract metadata from measures JSON or HTML
  let distanceKm = null;
  let elevationGainM = null;
  let elevationLossM = null;
  let maxElevationM = null;
  let minElevationM = null;
  let timeString = null;
  let activity = 'Senderismo';
  let author = '';
  let location = '';

  const measuresMatch = html.match(/spaMeasures:\s*(\{[\s\S]*?\}),/);
  if (measuresMatch) {
    try {
      const measures = JSON.parse(measuresMatch[1]);
      if (measures.distance) distanceKm = parseFloat(measures.distance);
      if (measures.uphill != null) elevationGainM = Math.round(measures.uphill);
      if (measures.downhill != null) elevationLossM = Math.round(measures.downhill);
      if (measures.elevationMax != null) maxElevationM = Math.round(measures.elevationMax);
      if (measures.elevationMin != null) minElevationM = Math.round(measures.elevationMin);
      if (measures.time) timeString = measures.time.trim();
    } catch (e) {
      console.warn('Error parseando spaMeasures:', e);
    }
  }

  // Author and Activity
  const authorMatch = html.match(/trailByAuthor":\s*"por&nbsp;([^"]+)"/);
  if (authorMatch) author = authorMatch[1].trim();

  const activityMatch = html.match(/trailPictogramText":\s*"([^"]+)"/);
  if (activityMatch) activity = activityMatch[1].trim();

  const locationMatch = html.match(/class="trail-near"[^>]*>[\s\S]*?<p>cerca de&nbsp;([^<]+)<\/p>/i);
  if (locationMatch) location = locationMatch[1].trim();

  // 4. Parse waypoints (POIs)
  const rawWaypoints = parsed.waypoints || [];
  const waypoints = rawWaypoints.map(wp => {
    let photoUrl = null;
    if (wp.photos && wp.photos.length > 0) {
      photoUrl = wp.photos[0].url || null;
    }
    return {
      id: wp.id,
      name: wp.name || 'Punto de interés',
      lat: wp.lat,
      lon: wp.lon,
      elevation: wp.elevation != null ? Math.round(wp.elevation) : null,
      pictogramName: wp.pictogramName || 'Punto de interés',
      photoUrl
    };
  });

  return {
    id: String(rawTrail.spaId || ''),
    url: originalUrl || (rawTrail.prettyURL ? `https://es.wikiloc.com${rawTrail.prettyURL}` : ''),
    name,
    activity,
    author: author || 'Autor Wikiloc',
    location: location || 'Desconocido',
    distanceKm: distanceKm || 0,
    elevationGainM: elevationGainM || 0,
    elevationLossM: elevationLossM || 0,
    maxElevationM: maxElevationM || 0,
    minElevationM: minElevationM || 0,
    timeString: timeString || '',
    isLoop: !!rawTrail.loop,
    geom: rawTrail.geom,
    waypoints
  };
}

/**
 * Validates and extracts trail ID or normalized URL from input
 */
export function normalizeWikilocUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  
  // If user pasted a clean ID
  if (/^\d{6,11}$/.test(trimmed)) {
    return `https://es.wikiloc.com/wikiloc/view.do?id=${trimmed}`;
  }

  // URL matching
  const urlMatch = trimmed.match(/https?:\/\/(?:[a-z]{2}\.)?wikiloc\.com\/[^\s]+/i);
  if (urlMatch) {
    return urlMatch[0];
  }

  return null;
}

/**
 * Calculates elevation gain, max/min elevation, distance, and estimated hiking time from 3D coordinates [lon, lat, ele, time]
 */
export function computeMetricsFromCoordinates(coordinates) {
  if (!coordinates || coordinates.length === 0) {
    return {
      distanceKm: 0,
      elevationGainM: 0,
      elevationLossM: 0,
      maxElevationM: 0,
      minElevationM: 0,
      timeString: '--'
    };
  }

  let totalDistanceKm = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;
  let minElevationM = Infinity;
  let maxElevationM = -Infinity;
  let hasElevations = false;
  let prevEle = null;

  function haversineDist(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  for (let i = 0; i < coordinates.length; i++) {
    const pt = coordinates[i]; // [lon, lat, ele, time]
    const lon = pt[0];
    const lat = pt[1];
    const ele = pt.length > 2 && pt[2] != null ? pt[2] : null;

    if (i > 0) {
      const prev = coordinates[i - 1];
      totalDistanceKm += haversineDist(prev[1], prev[0], lat, lon);
    }

    if (ele != null && !isNaN(ele)) {
      hasElevations = true;
      if (ele < minElevationM) minElevationM = ele;
      if (ele > maxElevationM) maxElevationM = ele;

      if (prevEle != null) {
        const diff = ele - prevEle;
        // 0.8m threshold filters out GPS altitude jitter
        if (diff > 0.8) elevationGainM += diff;
        else if (diff < -0.8) elevationLossM += Math.abs(diff);
      }
      prevEle = ele;
    }
  }

  // Calculate estimated hiking time (Naismith's rule: 4 km/h + 1h per 400m elevation gain)
  let timeString = '--';
  if (totalDistanceKm > 0) {
    const hours = (totalDistanceKm / 4.0) + ((hasElevations ? elevationGainM : 0) / 400.0);
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    timeString = h > 0 ? `${h}h ${m}min` : `${m}min`;
  }

  return {
    distanceKm: parseFloat(totalDistanceKm.toFixed(2)),
    elevationGainM: hasElevations ? Math.round(elevationGainM) : 0,
    elevationLossM: hasElevations ? Math.round(elevationLossM) : 0,
    maxElevationM: hasElevations ? Math.round(maxElevationM) : 0,
    minElevationM: hasElevations ? Math.round(minElevationM) : 0,
    timeString
  };
}

/**
 * Parses raw mapData JSON object (obtained directly from Android WebView or HTML)
 */
export function parseMapDataObject(parsed, originalUrl = '') {
  const mapDataList = Array.isArray(parsed.mapData)
    ? parsed.mapData
    : (parsed.mapData ? [parsed.mapData] : (Array.isArray(parsed) ? parsed : [parsed]));
  const rawTrail = mapDataList[0] || {};
  if (!rawTrail || !rawTrail.geom) {
    throw new Error('La ruta no contiene polilínea geométrica.');
  }

  const rawWaypoints = parsed.waypoints || [];
  const waypoints = rawWaypoints.map(wp => ({
    id: wp.id,
    name: wp.name || 'Punto de interés',
    lat: wp.lat,
    lon: wp.lon,
    elevation: wp.elevation != null ? Math.round(wp.elevation) : null,
    pictogramName: wp.pictogramName || 'Punto de interés',
    photoUrl: (wp.photos && wp.photos[0] && wp.photos[0].url) ? wp.photos[0].url : null
  }));

  const measures = parsed.measures || parsed.spaMeasures || {};
  let distanceKm = measures.distance ? parseFloat(measures.distance) : null;
  let elevationGainM = measures.uphill != null ? Math.round(measures.uphill) : null;
  let elevationLossM = measures.downhill != null ? Math.round(measures.downhill) : null;
  let maxElevationM = measures.elevationMax != null ? Math.round(measures.elevationMax) : null;
  let minElevationM = measures.elevationMin != null ? Math.round(measures.elevationMin) : null;
  let timeString = measures.time ? measures.time.trim() : '';

  if (distanceKm == null && rawTrail.bsd) distanceKm = parseFloat((rawTrail.bsd / 1000).toFixed(2));
  if (elevationGainM == null && rawTrail.bsu != null) elevationGainM = Math.round(rawTrail.bsu);
  if (elevationLossM == null && rawTrail.bsd_down != null) elevationLossM = Math.round(rawTrail.bsd_down);

  return {
    id: String(rawTrail.spaId || ''),
    url: originalUrl || (rawTrail.prettyURL ? `https://es.wikiloc.com${rawTrail.prettyURL}` : ''),
    name: rawTrail.nom || parsed.title || 'Ruta Wikiloc',
    activity: parsed.activity || 'Senderismo',
    author: parsed.author || 'Autor Wikiloc',
    location: parsed.location || 'Localización de ruta',
    distanceKm: distanceKm || 0,
    elevationGainM: elevationGainM || 0,
    elevationLossM: elevationLossM || 0,
    maxElevationM: maxElevationM || 0,
    minElevationM: minElevationM || 0,
    timeString: timeString || '',
    isLoop: !!rawTrail.loop,
    geom: rawTrail.geom,
    waypoints
  };
}

/**
 * Attempts to fetch and extract Wikiloc trail data from URL
 */
export async function fetchAndExtractTrail(url, onStatusUpdate = () => {}) {
  const normUrl = normalizeWikilocUrl(url);
  if (!normUrl) {
    throw new Error('Por favor, introduce una URL válida de una ruta de Wikiloc.');
  }

  // If user passed the Janela do Inferno sample URL or ID
  if (normUrl.includes('238235570')) {
    onStatusUpdate('Cargando ruta de demostración (Janela do Inferno)...');
    await new Promise(r => setTimeout(r, 400));
    return SAMPLE_ROUTE;
  }

  // 1. If running natively inside Android APK (Capacitor)
  if (Capacitor && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.WikilocExtractor) {
    onStatusUpdate('Iniciando navegador interno Android...');
    try {
      const res = await Capacitor.Plugins.WikilocExtractor.extract({ url: normUrl });
      if (res && res.data) {
        onStatusUpdate('Ruta obtenida con éxito en Android.');
        const parsed = JSON.parse(res.data);
        return parseMapDataObject(parsed, normUrl);
      }
    } catch (nativeErr) {
      console.error('Error en extracción nativa:', nativeErr);
      throw new Error('Error al extraer en Android: ' + (nativeErr.message || nativeErr));
    }
  }

  // 2. Web browser fallback: try proxies
  onStatusUpdate('Conectando con Wikiloc...');

  const proxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`
  ];

  let lastError = null;

  for (const proxyFn of proxies) {
    try {
      const fetchUrl = proxyFn(normUrl);
      onStatusUpdate('Extrayendo datos de la ruta...');
      const response = await fetch(fetchUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml'
        }
      });

      if (!response.ok) {
        throw new Error(`Servidor devolvió estado ${response.status}`);
      }

      const html = await response.text();
      return parseWikilocHtml(html, normUrl);
    } catch (err) {
      console.warn('Proxy falló:', err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('No se pudo conectar con Wikiloc.');
}
