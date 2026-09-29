import './style.css';
import { SAMPLE_ROUTE } from './sampleData.js';
import { fetchAndExtractTrail, parseWikilocHtml } from './wikilocExtractor.js';
import { decodeTwkbBase64, buildGpxXml, downloadGpx, shareGpx } from './gpxExporter.js';
import { renderRouteMap, renderElevationProfile } from './mapComponent.js';

// Application State
let currentTrailData = null;
let currentCoordinates = null;

// DOM Elements
const urlForm = document.getElementById('urlForm');
const wikilocUrlInput = document.getElementById('wikilocUrlInput');
const btnClipboardPaste = document.getElementById('btnClipboardPaste');
const btnDemoJanela = document.getElementById('btnDemoJanela');
const btnManualHtml = document.getElementById('btnManualHtml');
const btnOpenPasteModal = document.getElementById('btnOpenPasteModal');

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

const pasteModal = document.getElementById('pasteModal');
const htmlTextarea = document.getElementById('htmlTextarea');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnProcessHtml = document.getElementById('btnProcessHtml');

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

    metricDist.textContent = trailData.distanceKm ? `${trailData.distanceKm.toFixed(2)} km` : `${(currentCoordinates.length * 0.005).toFixed(1)} km`;
    metricGain.textContent = trailData.elevationGainM ? `+${trailData.elevationGainM} m` : '+--';
    metricMaxEle.textContent = trailData.maxElevationM ? `${trailData.maxElevationM} m` : '--';
    metricTime.textContent = trailData.timeString || 'N/A';

    trackpointsCounter.textContent = `${currentCoordinates.length} puntos de track`;
    
    const wpts = trailData.waypoints || [];
    poisCounterBadge.textContent = `${wpts.length} POIs`;
    labelWptsCount.textContent = `Incluir puntos de interés (${wpts.length} POIs)`;

    // 3. Render Leaflet Map & Elevation Profile
    renderRouteMap('routeMap', currentCoordinates, wpts);
    renderElevationProfile('elevationProfileContainer', currentCoordinates);

    // 4. Render POIs Grid (Cards matching the reference design)
    renderPoisCards(wpts);

    // 5. Reveal results
    hideStatus();
    resultsSection.classList.add('visible');

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
    card.title = `Pulsar para centrar en el mapa`;

    const iconType = wp.pictogramName || 'POI';
    const eleText = wp.elevation != null ? `⛰️ ${wp.elevation} m` : '';

    card.innerHTML = `
      <div class="poi-card-img-wrap">
        ${wp.photoUrl
          ? `<img src="${wp.photoUrl}" alt="${wp.name}" class="poi-card-img" loading="lazy" />`
          : `<div class="poi-card-img-placeholder">🏔️</div>`
        }
        <span class="poi-pill-tag">${iconType}</span>
      </div>
      <div class="poi-card-body">
        <h4 class="poi-card-title">${wp.name}</h4>
        <div class="poi-card-footer">
          <span class="poi-card-ele">${eleText}</span>
          <span class="poi-card-action">Ver en mapa →</span>
        </div>
      </div>
    `;

    // Clicking card centers map on this POI
    card.addEventListener('click', () => {
      const mapEl = document.getElementById('routeMap');
      mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    poisCardsGrid.appendChild(card);
  });
}

// Event: Submit URL Form
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = wikilocUrlInput.value.trim();
  if (!url) return;

  try {
    showStatus('Extrayendo ruta de Wikiloc...');
    const trailData = await fetchAndExtractTrail(url, (status) => showStatus(status));
    await displayRoute(trailData);
  } catch (err) {
    hideStatus();
    console.error('Error al extraer ruta:', err);
    if (err.message.includes('CLOUDFLARE_BLOCKED') || err.message.includes('403')) {
      pasteModal.classList.add('open');
      alert('Wikiloc tiene activo el sistema anti-bot de Cloudflare para peticiones web automáticas.\n\nPuedes abrir el enlace en tu navegador y pegar el código HTML en la ventana que se acaba de abrir.');
    } else {
      alert('No se pudo extraer la ruta: ' + err.message + '\n\nPuedes probar con el botón "Janela do Inferno" o el modo manual con código HTML.');
    }
  }
});

// Event: Paste from Clipboard
btnClipboardPaste.addEventListener('click', async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        wikilocUrlInput.value = text;
        wikilocUrlInput.focus();
      }
    } else {
      wikilocUrlInput.focus();
    }
  } catch (e) {
    wikilocUrlInput.focus();
  }
});

// Event: Demo Janela do Inferno button
btnDemoJanela.addEventListener('click', async () => {
  wikilocUrlInput.value = SAMPLE_ROUTE.url;
  await displayRoute(SAMPLE_ROUTE);
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

// Modal Events
function openModal() {
  pasteModal.classList.add('open');
  htmlTextarea.focus();
}

function closeModal() {
  pasteModal.classList.remove('open');
}

btnManualHtml.addEventListener('click', openModal);
btnOpenPasteModal.addEventListener('click', openModal);
btnCloseModal.addEventListener('click', closeModal);
pasteModal.addEventListener('click', (e) => {
  if (e.target === pasteModal) closeModal();
});

btnProcessHtml.addEventListener('click', async () => {
  const html = htmlTextarea.value.trim();
  if (!html) {
    alert('Por favor, pega el código HTML de la ruta.');
    return;
  }

  try {
    showStatus('Analizando código HTML...');
    closeModal();
    const trailData = parseWikilocHtml(html);
    await displayRoute(trailData);
  } catch (err) {
    hideStatus();
    alert('Error al procesar el código HTML: ' + err.message);
  }
});
