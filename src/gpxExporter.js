import * as twkb from 'twkb';
import { Capacitor } from '@capacitor/core';

/**
 * Decodes a base64 encoded TWKB geometry string into coordinates array
 * Each coordinate is [longitude, latitude, elevation, time/measure]
 */
export function decodeTwkbBase64(geomBase64) {
  try {
    if (!geomBase64 || typeof geomBase64 !== 'string') {
      throw new Error('Cadena de geometría vacía o inválida');
    }
    // Clean whitespace and convert URL-safe base64
    let cleanB64 = geomBase64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (cleanB64.length % 4 !== 0) {
      cleanB64 += '=';
    }

    const binaryString = atob(cleanB64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const geojson = twkb.toGeoJSON(bytes);
    if (!geojson || !geojson.features || !geojson.features[0]) {
      throw new Error('No se pudo decodificar la geometría TWKB');
    }
    return geojson.features[0].geometry.coordinates;
  } catch (err) {
    console.error('Error decodificando TWKB:', err);
    throw new Error('Fallo al decodificar la polilínea de la ruta: ' + err.message);
  }
}

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a GPX 1.1 compliant XML document string
 */
export function buildGpxXml(trailData, coordinates, options = {}) {
  const {
    includeWaypoints = true,
    includeElevation = true,
    creator = 'Wikiloc GPX Exporter'
  } = options;

  const nowIso = new Date().toISOString();
  const trailName = trailData.name || 'Ruta Wikiloc';
  const prettyUrl = trailData.url || 'https://es.wikiloc.com';

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${escapeXml(creator)}"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(trailName)}</name>
    <desc>${escapeXml(trailData.location ? `Ruta en ${trailData.location}` : '')}</desc>
    <author>
      <name>${escapeXml(trailData.author || 'Wikiloc User')}</name>
    </author>
    <link href="${escapeXml(prettyUrl)}">
      <text>${escapeXml(trailName)}</text>
    </link>
    <time>${nowIso}</time>
  </metadata>
`;

  // 1. Waypoints (POIs)
  if (includeWaypoints && trailData.waypoints && trailData.waypoints.length > 0) {
    trailData.waypoints.forEach(wp => {
      xml += `  <wpt lat="${wp.lat}" lon="${wp.lon}">\n`;
      if (includeElevation && wp.elevation != null) {
        xml += `    <ele>${wp.elevation}</ele>\n`;
      }
      if (wp.name) {
        xml += `    <name>${escapeXml(wp.name)}</name>\n`;
      }
      if (wp.pictogramName) {
        xml += `    <type>${escapeXml(wp.pictogramName)}</type>\n`;
      }
      if (wp.photoUrl) {
        xml += `    <link href="${escapeXml(wp.photoUrl)}">\n`;
        xml += `      <text>Fotografía</text>\n`;
        xml += `    </link>\n`;
      }
      xml += `  </wpt>\n`;
    });
  }

  // 2. Track & Tracksegments
  xml += `  <trk>\n`;
  xml += `    <name>${escapeXml(trailName)}</name>\n`;
  if (trailData.activity) {
    xml += `    <type>${escapeXml(trailData.activity)}</type>\n`;
  }
  xml += `    <trkseg>\n`;

  coordinates.forEach(coord => {
    const lon = coord[0];
    const lat = coord[1];
    const ele = (coord.length > 2 && coord[2] != null) ? coord[2] : null;

    if (includeElevation && ele != null) {
      xml += `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>\n`;
    } else {
      xml += `      <trkpt lat="${lat}" lon="${lon}"/>\n`;
    }
  });

  xml += `    </trkseg>\n`;
  xml += `  </trk>\n`;
  xml += `</gpx>`;

  return xml;
}

/**
 * Triggers a file download on browser via blob URL
 */
export function downloadGpxBlob(filename, gpxString) {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Shares GPX via Web Share API or falls back to download
 */
export async function shareGpxBlob(filename, gpxString) {
  const cleanName = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;
  const blob = new Blob([gpxString], { type: 'application/gpx+xml;charset=utf-8' });
  const file = new File([blob], cleanName, { type: 'application/gpx+xml' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: cleanName,
        text: `Ruta GPX exportada: ${cleanName}`,
        files: [file]
      });
      return { success: true, method: 'share' };
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Error compartiendo archivo, usando descarga:', err);
      } else {
        return { success: false, cancelled: true };
      }
    }
  }

  // Fallback to normal download
  downloadGpxBlob(cleanName, gpxString);
  return { success: true, method: 'download' };
}

/**
 * Primary download function: on Android native app saves directly to Downloads folder.
 * On web browser, downloads via blob URL.
 */
export async function downloadGpx(filename, gpxString) {
  const cleanName = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;

  if (Capacitor.isNativePlatform()) {
    try {
      const { WikilocExtractor } = Capacitor.Plugins;
      if (WikilocExtractor && typeof WikilocExtractor.saveGpxToDownloads === 'function') {
        const res = await WikilocExtractor.saveGpxToDownloads({
          filename: cleanName,
          content: gpxString
        });
        return { success: true, method: 'native', path: res ? res.path : 'Descargas' };
      }
    } catch (err) {
      console.error('Error en guardado nativo:', err);
      throw new Error('Fallo al guardar en Descargas: ' + (err.message || err));
    }
  }

  downloadGpxBlob(cleanName, gpxString);
  return { success: true, method: 'browser' };
}

/**
 * Primary share function: on Android native app triggers native system Share Sheet.
 * On web browser, uses Web Share API or download fallback.
 */
export async function shareGpx(filename, gpxString) {
  const cleanName = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;

  if (Capacitor.isNativePlatform()) {
    try {
      const { WikilocExtractor } = Capacitor.Plugins;
      if (WikilocExtractor && typeof WikilocExtractor.shareGpx === 'function') {
        await WikilocExtractor.shareGpx({
          filename: cleanName,
          content: gpxString
        });
        return { success: true, method: 'native' };
      }
    } catch (err) {
      console.error('Error al compartir nativamente:', err);
      throw new Error('Fallo al compartir: ' + (err.message || err));
    }
  }

  return await shareGpxBlob(cleanName, gpxString);
}
