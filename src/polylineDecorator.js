import L from 'leaflet';

/**
 * Functional point distance calculation
 */
function pointDistance(ptA, ptB) {
  const x = ptB.x - ptA.x;
  const y = ptB.y - ptA.y;
  return Math.sqrt(x * x + y * y);
}

function computeSegmentHeading(a, b) {
  return ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90 + 360) % 360;
}

function pointsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

function parseRelativeOrAbsoluteValue(value) {
  if (typeof value === 'string' && value.indexOf('%') !== -1) {
    return {
      value: parseFloat(value) / 100,
      isInPixels: false
    };
  }
  const parsedValue = value ? parseFloat(value) : 0;
  return {
    value: parsedValue,
    isInPixels: parsedValue > 0
  };
}

function asRatioToPathLength(ref, totalPathLength) {
  return ref.isInPixels ? ref.value / totalPathLength : ref.value;
}

function interpolateBetweenPoints(ptA, ptB, ratio) {
  if (ptB.x !== ptA.x) {
    return {
      x: ptA.x + ratio * (ptB.x - ptA.x),
      y: ptA.y + ratio * (ptB.y - ptA.y)
    };
  }
  return {
    x: ptA.x,
    y: ptA.y + (ptB.y - ptA.y) * ratio
  };
}

function pointsToSegments(pts) {
  return pts.reduce((segments, b, idx, points) => {
    if (idx > 0 && !pointsEqual(b, points[idx - 1])) {
      const a = points[idx - 1];
      const distA = segments.length > 0 ? segments[segments.length - 1].distB : 0;
      const distAB = pointDistance(a, b);
      segments.push({
        a,
        b,
        distA,
        distB: distA + distAB,
        heading: computeSegmentHeading(a, b)
      });
    }
    return segments;
  }, []);
}

function projectPatternOnPointPath(pts, pattern) {
  const segments = pointsToSegments(pts);
  const nbSegments = segments.length;
  if (nbSegments === 0) return [];

  const totalPathLength = segments[nbSegments - 1].distB;
  const offset = asRatioToPathLength(pattern.offset, totalPathLength);
  const endOffset = asRatioToPathLength(pattern.endOffset, totalPathLength);
  const repeat = asRatioToPathLength(pattern.repeat, totalPathLength);

  const repeatIntervalPixels = totalPathLength * repeat;
  const startOffsetPixels = offset > 0 ? totalPathLength * offset : 0;
  const endOffsetPixels = endOffset > 0 ? totalPathLength * endOffset : 0;

  const positionOffsets = [];
  let positionOffset = startOffsetPixels;
  do {
    positionOffsets.push(positionOffset);
    positionOffset += repeatIntervalPixels;
  } while (repeatIntervalPixels > 0 && positionOffset < totalPathLength - endOffsetPixels);

  let segmentIndex = 0;
  let segment = segments[0];

  return positionOffsets.map(pos => {
    while (pos > segment.distB && segmentIndex < nbSegments - 1) {
      segmentIndex++;
      segment = segments[segmentIndex];
    }
    const segLen = segment.distB - segment.distA;
    const segmentRatio = segLen > 0 ? (pos - segment.distA) / segLen : 0;
    return {
      pt: interpolateBetweenPoints(segment.a, segment.b, segmentRatio),
      heading: segment.heading
    };
  });
}

/**
 * ArrowHead symbol builder (creates chevron or filled arrow)
 */
class ArrowHeadSymbol {
  constructor(options = {}) {
    this.options = {
      polygon: false,
      pixelSize: 10,
      headAngle: 60,
      pathOptions: {
        stroke: true,
        weight: 2,
        color: '#ffffff'
      },
      ...options
    };
  }

  buildSymbol(dirPoint, latLngs, map) {
    const path = this._buildArrowPath(dirPoint, map);
    return this.options.polygon
      ? L.polygon(path, this.options.pathOptions)
      : L.polyline(path, this.options.pathOptions);
  }

  _buildArrowPath(dirPoint, map) {
    const d2r = Math.PI / 180;
    const tipPoint = map.project(dirPoint.latLng);
    const direction = -(dirPoint.heading - 90) * d2r;
    const radianArrowAngle = (this.options.headAngle / 2) * d2r;

    const headAngle1 = direction + radianArrowAngle;
    const headAngle2 = direction - radianArrowAngle;
    const arrowHead1 = L.point(
      tipPoint.x - this.options.pixelSize * Math.cos(headAngle1),
      tipPoint.y + this.options.pixelSize * Math.sin(headAngle1)
    );
    const arrowHead2 = L.point(
      tipPoint.x - this.options.pixelSize * Math.cos(headAngle2),
      tipPoint.y + this.options.pixelSize * Math.sin(headAngle2)
    );

    return [map.unproject(arrowHead1), dirPoint.latLng, map.unproject(arrowHead2)];
  }
}

/**
 * PolylineDecorator FeatureGroup
 */
export class PolylineDecorator extends L.FeatureGroup {
  constructor(paths, options = {}) {
    super();
    this.options = {
      patterns: [],
      ...options
    };
    this._map = null;
    this._paths = this._initPaths(paths);
    this._patterns = this.options.patterns.map(p => ({
      symbolFactory: p.symbol,
      offset: parseRelativeOrAbsoluteValue(p.offset),
      endOffset: parseRelativeOrAbsoluteValue(p.endOffset),
      repeat: parseRelativeOrAbsoluteValue(p.repeat)
    }));
  }

  _initPaths(input) {
    if (input instanceof L.Polyline) {
      return [input.getLatLngs()];
    }
    if (Array.isArray(input)) {
      if (input.length > 0 && (input[0] instanceof L.LatLng || (Array.isArray(input[0]) && typeof input[0][0] === 'number'))) {
        return [input];
      }
      return input;
    }
    return [];
  }

  onAdd(map) {
    this._map = map;
    this._draw();
    this._map.on('moveend', this.redraw, this);
    super.onAdd(map);
  }

  onRemove(map) {
    if (this._map) {
      this._map.off('moveend', this.redraw, this);
    }
    this._map = null;
    super.onRemove(map);
  }

  redraw() {
    if (!this._map) return;
    this.clearLayers();
    this._draw();
  }

  _draw() {
    if (!this._map) return;
    const mapBounds = this._map.getBounds().pad(0.15);

    this._patterns.forEach(pattern => {
      this._paths.forEach(path => {
        if (!path || path.length < 2) return;
        const pathAsPoints = path.map(ll => this._map.project(ll));
        const directionPoints = projectPatternOnPointPath(pathAsPoints, pattern)
          .map(pt => ({
            latLng: this._map.unproject(L.point(pt.pt)),
            heading: pt.heading
          }))
          .filter(pt => mapBounds.contains(pt.latLng));

        directionPoints.forEach(dirPt => {
          const layer = pattern.symbolFactory.buildSymbol(dirPt, path, this._map);
          this.addLayer(layer);
        });
      });
    });
  }
}

export function createPolylineDecorator(paths, options) {
  return new PolylineDecorator(paths, options);
}

export function createArrowHead(options) {
  return new ArrowHeadSymbol(options);
}
