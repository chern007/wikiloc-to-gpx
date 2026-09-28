# 🌿 Wikiloc to GPX Pro (Android & Web)

Aplicación para Android (híbrida con Capacitor) y Web para descargar cualquier ruta de senderismo, ciclismo o montaña desde **Wikiloc a formato GPX 1.1 estándar**, incluyendo el **trazado completo en 3D (con altitudes)** y todos los **puntos de interés (POIs / Waypoints)** con sus fotografías y descripciones.

---

## ✨ Características Principales

- 🏔️ **Extracción Completa 3D**: Decodifica la geometría nativa TWKB (*Tiny Well-Known Binary*) obteniendo todos los puntos de track con sus altitudes exactas en metros.
- 📍 **POIs y Waypoints**: Extrae los puntos de paso registrados (cascadas, miradores, cuevas, puentes, etc.) con sus coordenadas, cotas y enlaces a fotos en tags estándar `<wpt>`.
- 🛡️ **Resolución Nativa de Cloudflare**: En Android, la app utiliza un motor Chromium interno (`WikilocExtractorPlugin`) con cookies reales. Si aparece un reto humano, se muestra en la pantalla del móvil para tocar la casilla con el dedo y la app captura automáticamente los datos sin necesidad de abrir inspectores ni código fuente.
- 🗺️ **Previsualización Interactiva**:
  - Mapa con Leaflet (capas de senderos OSM, Topográfico con curvas de nivel y Satélite).
  - Perfil de elevación vectorial SVG interactivo.
  - Tarjetas de puntos de interés inspiradas en la estética natural y orgánica.
- 📲 **Exportación Directa**:
  - Guardar archivo `.gpx` en la carpeta de Descargas.
  - Compartir ruta directamente con **Garmin Connect, Strava, OsmAnd, Komoot, WhatsApp o Google Drive**.
  - Recibir rutas compartidas desde el navegador o la app oficial de Wikiloc mediante Android Share Intent.

---

## 🚀 Compilación y Descarga del APK mediante GitHub Actions

El repositorio incluye un workflow automatizado en `.github/workflows/build-apk.yml` que compila el APK en la nube con el Android SDK oficial:

### Pasos para obtener tu APK:
1. Sube este repositorio a tu cuenta de GitHub (`chern007`):
   ```bash
   git remote add origin https://github.com/chern007/wikiloc-to-gpx.git
   git push -u origin main
   ```
2. Entra en tu repositorio en GitHub y haz clic en la pestaña **Actions**.
3. Verás la ejecución en curso **"Build Android APK"** (tarda unos 2-3 minutos).
4. Al finalizar, haz clic en la ejecución y en la sección inferior **Artifacts** encontrarás el archivo **`wikiloc-to-gpx-apk`**.
5. Descárgalo e instálalo directamente en tu teléfono Android.

---

## 💻 Desarrollo Local

```bash
# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
npm run dev

# Compilar para producción y sincronizar con Android
npm run build
npx cap sync android
```
