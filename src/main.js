import './style.css';
import { Capacitor } from '@capacitor/core';
import { SAMPLE_ROUTE } from './sampleData.js';
import { fetchAndExtractTrail, computeMetricsFromCoordinates } from './wikilocExtractor.js';
import { decodeTwkbBase64, buildGpxXml, downloadGpx, shareGpx } from './gpxExporter.js';
import {
  renderRouteMap,
  renderElevationProfile,
  fitRouteBounds,
  focusPoi,
  toggleGpsTracking,
  stopGpsTracking,
  toggleMapFullscreen,
  isMapFullscreenActive,
  setFullscreenRouteInfo,
  toggleScreenOrientation,
  initScreenOrientation
} from './mapComponent.js';

// Application State
let currentTrailData = null;
let currentCoordinates = null;

// DOM Elements
const urlForm = document.getElementById('urlForm');
const wikilocUrlInput = document.getElementById('wikilocUrlInput');
const btnClipboardPaste = document.getElementById('btnClipboardPaste');

const statusIndicator = document.getElementById('statusIndicator');
const statusMessage = document.getElementById('statusMessage');

const resultsSection = document.getElementById('resultsSection');
const routeActivityBadge = document.getElementById('routeActivityBadge');
const routeTitle = document.getElementById('routeTitle');
const routeAuthor = document.getElementById('routeAuthor');
const routeLocation = document.getElementById('routeLocation');

const metricDist = document.getElementById('metricDist');
const metricGain = document.getElementById('metricGain');
const metricMaxEle = document.getElementById('metricMaxEle');
const metricTime = document.getElementById('metricTime');
const trackpointsCounter = document.getElementById('trackpointsCounter');
const poisCounterBadge = document.getElementById('poisCounterBadge');
const labelWptsCount = document.getElementById('labelWptsCount');

const btnDownloadGpx = document.getElementById('btnDownloadGpx');
const btnShareGpx = document.getElementById('btnShareGpx');
const chkIncludeWpts = document.getElementById('chkIncludeWpts');
const chkIncludeEle = document.getElementById('chkIncludeEle');

const poisCardsGrid = document.getElementById('poisCardsGrid');


// Helper to show/hide status
function showStatus(msg) {
  statusIndicator.classList.add('active');
  statusMessage.textContent = msg;
}

function hideStatus() {
  statusIndicator.classList.remove('active');
}

/**
 * Loads route data into the UI, decodes TWKB, renders map & POIs
 */
async function displayRoute(trailData) {
  try {
    showStatus('Decodificando trazado 3D de la ruta...');
    currentTrailData = trailData;

    // 1. Decode TWKB geometry into coordinates [lon, lat, ele, time]
    currentCoordinates = decodeTwkbBase64(trailData.geom);

    // 2. Populate Header & Metrics
    routeTitle.textContent = trailData.name;
    routeActivityBadge.textContent = `🌲 ${trailData.activity || 'Senderismo'}${trailData.isLoop ? ' • Circular' : ''}`;
    routeAuthor.textContent = `por ${trailData.author || 'Usuario Wikiloc'}`;
    routeLocation.textContent = trailData.location || 'Localización no especificada';

    // Calculate fallback metrics from coordinates if trailData metrics are missing/zero
    const computed = computeMetricsFromCoordinates(currentCoordinates);
    const dist = (trailData.distanceKm && trailData.distanceKm > 0) ? trailData.distanceKm : computed.distanceKm;
    const gain = (trailData.elevationGainM && trailData.elevationGainM > 0) ? trailData.elevationGainM : computed.elevationGainM;
    const maxEle = (trailData.maxElevationM && trailData.maxElevationM > 0) ? trailData.maxElevationM : computed.maxElevationM;
    const timeStr = (trailData.timeString && trailData.timeString.trim().length > 0 && trailData.timeString !== 'N/A') ? trailData.timeString : computed.timeString;

    metricDist.textContent = dist > 0 ? `${dist.toFixed(2)} km` : '--';
    metricGain.textContent = gain > 0 ? `+${gain} m` : (gain === 0 ? '0 m' : '+--');
    metricMaxEle.textContent = maxEle > 0 ? `${maxEle} m` : '--';
    metricTime.textContent = timeStr || 'N/A';

    trackpointsCounter.textContent = `${currentCoordinates.length} puntos de track`;
    
    const wpts = trailData.waypoints || [];
    poisCounterBadge.textContent = `${wpts.length} POIs`;
    labelWptsCount.textContent = `Incluir puntos de interés (${wpts.length} POIs)`;

    // Reveal results first so container is visible and Leaflet can measure dimensions!
    resultsSection.classList.add('visible');

    // 3. Render Leaflet Map & Elevation Profile
    renderRouteMap('routeMap', currentCoordinates, wpts);
    renderElevationProfile('elevationProfileContainer', currentCoordinates);
    setFullscreenRouteInfo(trailData.name, dist > 0 ? dist.toFixed(2) : null, gain > 0 ? gain : null);

    // 4. Render POIs Grid (Cards matching the reference design)
    renderPoisCards(wpts);

    hideStatus();

    // Trigger fit bounds with cascading timeouts to ensure the full route is completely visible
    fitRouteBounds();
    setTimeout(fitRouteBounds, 120);
    setTimeout(fitRouteBounds, 350);
    setTimeout(fitRouteBounds, 750);

    // Scroll smoothly to results
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideStatus();
    console.error('Error al procesar la ruta:', err);
    alert('Error al procesar la ruta: ' + err.message);
  }
}

/**
 * Renders POI cards grid
 */
function renderPoisCards(waypoints) {
  poisCardsGrid.innerHTML = '';
  if (!waypoints || waypoints.length === 0) {
    poisCardsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-muted); background: white; border-radius: var(--radius-card);">
        Esta ruta no tiene puntos de interés (POIs) específicos registrados.
      </div>
    `;
    return;
  }

  waypoints.forEach((wp, index) => {
    const card = document.createElement('div');
    card.className = 'poi-card';
    card.title = `Pulsar para centrar y ver en el mapa`;

    const iconType = wp.pictogramName || 'POI';
    const eleText = wp.elevation != null ? `⛰️ ${wp.elevation} m` : '';

    card.innerHTML = `
      <div class="poi-card-img-wrap" data-poi-idx="${index}">
        ${wp.photoUrl
          ? `<img src="${wp.photoUrl}" alt="${wp.name}" class="poi-card-img" loading="lazy" />`
          : `<div class="poi-card-img-placeholder">🏔️</div>`
        }
        <span class="poi-pill-tag">${iconType}</span>
        <span class="poi-zoom-badge">🔍 Zoom mapa</span>
      </div>
      <div class="poi-card-body">
        <h4 class="poi-card-title">${wp.name}</h4>
        <div class="poi-card-footer">
          <span class="poi-card-ele">${eleText}</span>
          <span class="poi-card-action">Ver en mapa 📍</span>
        </div>
      </div>
    `;

    // Clicking card or photo triggers map zoom & center on this POI!
    card.addEventListener('click', () => {
      focusPoi(index);
    });

    poisCardsGrid.appendChild(card);
  });
}

/**
 * Extracts clean Wikiloc URL from shared or pasted text,
 * resolving shortened loc.wiki links to canonical Wikiloc URLs.
 */
export function extractWikilocUrl(text) {
  if (!text) return '';

  // 1. Check loc.wiki short URL: https://loc.wiki/t/4071494?h=...
  const locWikiMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*loc\.wiki\/t\/(\d+)(\?[^"'\s]*)?/i);
  if (locWikiMatch) {
    const id = locWikiMatch[1];
    const query = locWikiMatch[2] ? locWikiMatch[2].replace(/^\?/, '') : '';
    if (query) {
      return `https://www.wikiloc.com/wikiloc/open-trail-link.do?id=${id}&${query}`;
    }
    return `https://es.wikiloc.com/wikiloc/view.do?id=${id}`;
  }

  // 2. Standard wikiloc.com or loc.wiki matching
  const match = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:wikiloc\.com|loc\.wiki)\/[^\s"'<>]+/i);
  if (match) {
    return match[0].replace(/[.,;:!?()\]>]+$/, '');
  }

  // 3. Numeric ID
  const idMatch = text.match(/\b\d{6,11}\b/);
  if (idMatch && !text.includes('http')) {
    return `https://es.wikiloc.com/wikiloc/view.do?id=${idMatch[0]}`;
  }

  // 4. Any generic URL
  const genMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (genMatch) {
    return genMatch[0].replace(/[.,;:!?()\]>]+$/, '');
  }

  return text.trim();
}

/**
 * Loads and displays a route from a Wikiloc URL.
 * Populates the address bar input and extracts the track.
 */
export async function processRouteUrl(url) {
  if (!url) return;
  const cleanUrl = extractWikilocUrl(url) || url.trim();
  if (!cleanUrl) return;

  wikilocUrlInput.value = cleanUrl;
  wikilocUrlInput.dispatchEvent(new Event('input', { bubbles: true }));

  try {
    showStatus('Extrayendo ruta de Wikiloc...');
    const trailData = await fetchAndExtractTrail(cleanUrl, (status) => showStatus(status));
    await displayRoute(trailData);
  } catch (err) {
    hideStatus();
    console.error('Error al extraer ruta:', err);
    alert('No se pudo extraer la ruta: ' + err.message);
  }
}

// Event: Submit URL Form
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = wikilocUrlInput.value.trim();
  if (!url) return;
  await processRouteUrl(url);
});

/**
 * Reads clipboard text safely via native Android plugin or Web Clipboard API
 */
async function readClipboardText() {
  if (Capacitor && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.WikilocExtractor) {
    try {
      const res = await Capacitor.Plugins.WikilocExtractor.readClipboard();
      if (res && res.value && typeof res.value === 'string' && res.value.trim().length > 0) {
        return res.value.trim();
      }
    } catch (e) {
      console.warn('Fallo leyendo portapapeles nativo:', e);
    }
  }

  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    } catch (e) {
      console.warn('Fallo leyendo navigator.clipboard:', e);
    }
  }

  return '';
}

// Event: Paste from Clipboard
btnClipboardPaste.addEventListener('click', async () => {
  try {
    const rawText = await readClipboardText();
    if (rawText) {
      const cleanUrl = extractWikilocUrl(rawText);
      wikilocUrlInput.value = cleanUrl || rawText;
      wikilocUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
      wikilocUrlInput.focus();
    } else {
      wikilocUrlInput.focus();
    }
  } catch (e) {
    wikilocUrlInput.focus();
  }
});

// Event: Download GPX button
btnDownloadGpx.addEventListener('click', async () => {
  if (!currentTrailData || !currentCoordinates) {
    alert('Primero debes extraer una ruta.');
    return;
  }

  try {
    const options = {
      includeWaypoints: chkIncludeWpts.checked,
      includeElevation: chkIncludeEle.checked
    };

    const xml = buildGpxXml(currentTrailData, currentCoordinates, options);
    const safeFilename = `${(currentTrailData.name || 'ruta_wikiloc').replace(/[^a-zA-Z0-9_\-áéíóúÁÉÍÓÚñÑ ]/g, '')}.gpx`;

    showStatus('Guardando archivo GPX en Descargas...');
    const result = await downloadGpx(safeFilename, xml);
    hideStatus();

    if (result && result.method === 'native') {
      showStatus('✅ GPX guardado con éxito en Descargas');
      setTimeout(hideStatus, 3500);
    }
  } catch (err) {
    hideStatus();
    console.error('Error al descargar GPX:', err);
    alert('No se pudo guardar el archivo GPX: ' + err.message);
  }
});

// Event: Share GPX button
btnShareGpx.addEventListener('click', async () => {
  if (!currentTrailData || !currentCoordinates) {
    alert('Primero debes extraer una ruta.');
    return;
  }

  try {
    const options = {
      includeWaypoints: chkIncludeWpts.checked,
      includeElevation: chkIncludeEle.checked
    };

    const xml = buildGpxXml(currentTrailData, currentCoordinates, options);
    const safeFilename = `${(currentTrailData.name || 'ruta_wikiloc').replace(/[^a-zA-Z0-9_\-áéíóúÁÉÍÓÚñÑ ]/g, '')}.gpx`;

    showStatus('Preparando archivo para compartir...');
    await shareGpx(safeFilename, xml);
    hideStatus();
  } catch (err) {
    hideStatus();
    console.error('Error al compartir GPX:', err);
    alert('No se pudo compartir el archivo GPX: ' + err.message);
  }
});


// Screen Orientation & Fullscreen Top Bar Events
const btnHeaderOrientation = document.getElementById('btnHeaderOrientation');
if (btnHeaderOrientation) {
  btnHeaderOrientation.addEventListener('click', toggleScreenOrientation);
}

const btnFullscreenOrientation = document.getElementById('btnFullscreenOrientation');
if (btnFullscreenOrientation) {
  btnFullscreenOrientation.addEventListener('click', toggleScreenOrientation);
}

const btnExitFullscreenTop = document.getElementById('btnExitFullscreenTop');
if (btnExitFullscreenTop) {
  btnExitFullscreenTop.addEventListener('click', () => {
    if (isMapFullscreenActive()) toggleMapFullscreen();
  });
}

// Initialize orientation preference on app start
initScreenOrientation();

/**
 * Handles incoming shared URLs from official Wikiloc app or Android system share sheet
 */
async function initSharedIntentListener() {
  // 1. Check URL parameters (useful for Web Share Target or browser testing)
  try {
    const params = new URLSearchParams(window.location.search);
    const sharedParam = params.get('url') || params.get('text');
    if (sharedParam) {
      console.log('Ruta recibida por parámetro URL:', sharedParam);
      await processRouteUrl(sharedParam);
    }
  } catch (e) {}

  // 2. Native Capacitor WikilocExtractor Plugin
  if (Capacitor && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.WikilocExtractor) {
    const plugin = Capacitor.Plugins.WikilocExtractor;

    // A. Dynamic listener if app was already running when user shared from Wikiloc
    if (typeof plugin.addListener === 'function') {
      try {
        await plugin.addListener('sharedUrlReceived', async (data) => {
          if (data && data.url) {
            console.log('Intent recibido en caliente desde Wikiloc:', data.url);
            await processRouteUrl(data.url);
          }
        });
      } catch (e) {
        console.warn('No se pudo registrar listener sharedUrlReceived:', e);
      }
    }

    // B. Check if app was cold-started by sharing from Wikiloc
    try {
      if (typeof plugin.getSharedUrl === 'function') {
        const res = await plugin.getSharedUrl();
        if (res && res.hasUrl && res.url) {
          console.log('Intent recibido al iniciar app desde Wikiloc:', res.url);
          await processRouteUrl(res.url);
        }
      }
    } catch (e) {
      console.warn('Error al verificar getSharedUrl:', e);
    }
  }
}

initSharedIntentListener();

// Expose for testing & dev inspection
window.processRouteUrl = processRouteUrl;
window.displayRoute = displayRoute;
window.SAMPLE_ROUTE = SAMPLE_ROUTE;
