/* Hong Kong streaming map.
 * Imagery: Lands Department Imagery Map API (CSDI), no key, CORS-enabled.
 *   Terms require the Lands Department logo and "Aerial Photograph from Lands Department".
 *   https://portal.csdi.gov.hk/csdi-webpage/apidoc/ImageryMapAPI
 * Terrain: AWS Terrain Tiles (Mapzen Terrarium), no key, CORS-enabled.
 *   Hong Kong tiles in this dataset are SRTM / GMTED (~30 m), courtesy of the USGS.
 *   https://registry.opendata.aws/terrain-tiles/
 * The bundled Cheung Chau 5 m DTM and LandsD photos remain as an offline fallback.
 */
'use strict';
const HK = (() => {
  function hkEntries(entries) { const result = {}; for (const pair of entries) result[pair[0]] = pair[1]; return result; }
  const ORIGIN_LAT = 22.2087121; // Cheung Chau Ferry Pier (OSM node 1611297860)
  const ORIGIN_LON = 114.0283656;
  const M_PER_DEG_LON = 103000;
  const M_PER_DEG_LAT = 111000;
  const WEST = 113.834, EAST = 114.441, SOUTH = 22.137, NORTH = 22.562;
  const margin = 3000;
  const bounds = {
    minX: (WEST - ORIGIN_LON) * M_PER_DEG_LON - margin,
    maxX: (EAST - ORIGIN_LON) * M_PER_DEG_LON + margin,
    minZ: (SOUTH - ORIGIN_LAT) * M_PER_DEG_LAT - margin,
    maxZ: (NORTH - ORIGIN_LAT) * M_PER_DEG_LAT + margin
  };

  const places = [
    { id: 'cheung-chau', name: '長洲碼頭', lat: ORIGIN_LAT, lon: ORIGIN_LON, yaw: -1.2, mission: true },
    { id: 'central', name: '中環海濱', lat: 22.2836, lon: 114.1598, yaw: 0.15 },
    { id: 'tst', name: '尖沙咀鐘樓', lat: 22.2937, lon: 114.1694, yaw: 0.2 },
    { id: 'peak', name: '太平山頂', lat: 22.2712, lon: 114.1489, yaw: 1.0 },
    { id: 'mongkok', name: '旺角', lat: 22.3193, lon: 114.1694, yaw: 0 },
    { id: 'airport', name: '香港國際機場', lat: 22.3080, lon: 113.9185, yaw: 1.2 },
    { id: 'tungchung', name: '東涌', lat: 22.2894, lon: 113.9416, yaw: 0.8 },
    { id: 'lantau-peak', name: '鳳凰山', lat: 22.2666, lon: 113.9528, yaw: 0.5 },
    { id: 'taimoshan', name: '大帽山', lat: 22.4094, lon: 114.1236, yaw: 3.2 },
    { id: 'sha-tin', name: '沙田', lat: 22.3825, lon: 114.1900, yaw: 0 },
    { id: 'sai-kung', name: '西貢', lat: 22.3815, lon: 114.2710, yaw: -0.4 },
    { id: 'stanley', name: '赤柱', lat: 22.2183, lon: 114.2098, yaw: 2.2 },
    { id: 'lamma', name: '南丫島榕樹灣', lat: 22.2235, lon: 114.1094, yaw: -0.6 },
    { id: 'po-toi', name: '蒲台島', lat: 22.1640, lon: 114.2630, yaw: 1.5 }
  ];

  const IMAGERY_TMPL = 'https://mapapi.hkmapservice.gov.hk/gs/api/v1.0.0/xyz/imagery/WGS84/{z}/{x}/{y}.png';
  const TERRAIN_TMPL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const LANDSD_LOGO = 'https://www.landsd.gov.hk/images/landsd_logo.svg';
  const BASE_Z = 12;
  const TERRAIN_Z = 13;
  const IMAGE_Z = 15; // unchanged elsewhere in Hong Kong
  const DETAIL_Z = 17, CLOSE_Z = 18;
  // Only Cheung Chau and its immediate coast receive additional photo LODs.
  const CHEUNG_CHAU = { west: 114.014, east: 114.039, south: 22.195, north: 22.225 };
  const PHOTO_CACHE_LIMITS = { 15: 49, 17: 32, 18: 16 };
  function inCheungChau(lat, lon) {
    return lon >= CHEUNG_CHAU.west && lon <= CHEUNG_CHAU.east && lat >= CHEUNG_CHAU.south && lat <= CHEUNG_CHAU.north;
  }
  function touchesCheungChau(z, x, y) {
    return tile2lon(x + 1, z) >= CHEUNG_CHAU.west && tile2lon(x, z) <= CHEUNG_CHAU.east
      && tile2lat(y + 1, z) <= CHEUNG_CHAU.north && tile2lat(y, z) >= CHEUNG_CHAU.south;
  }
  const GRID = 33;
  const LOAD_RADIUS = 2;
  const KEEP_RADIUS = 3;
  const MAX_CONCURRENT = 4;
  const MAX_ALTITUDE = 2500;
  const MIN_AGL = 200;

  const toXZ = (lat, lon) => ({
    x: (lon - ORIGIN_LON) * M_PER_DEG_LON,
    z: (lat - ORIGIN_LAT) * M_PER_DEG_LAT
  });
  const toLonLat = (x, z) => ({
    lon: ORIGIN_LON + x / M_PER_DEG_LON,
    lat: ORIGIN_LAT + z / M_PER_DEG_LAT
  });

  function lon2tile(lon, z) { return (lon + 180) / 360 * (1 << z); }
  function lat2tile(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z);
  }
  function tile2lon(x, z) { return x / (1 << z) * 360 - 180; }
  function tile2lat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / (1 << z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function tileKey(kind, z, x, y) { return kind + '/' + z + '/' + x + '/' + y; }

  function tileBoundsXZ(z, x, y) {
    const nw = toXZ(tile2lat(y, z), tile2lon(x, z));
    const se = toXZ(tile2lat(y + 1, z), tile2lon(x + 1, z));
    return { minX: nw.x, maxX: se.x, minZ: se.z, maxZ: nw.z };
  }

  function tilesCovering(minLon, minLat, maxLon, maxLat, z) {
    const x0 = Math.floor(lon2tile(minLon, z));
    const x1 = Math.floor(lon2tile(maxLon, z));
    const y0 = Math.floor(lat2tile(maxLat, z));
    const y1 = Math.floor(lat2tile(minLat, z));
    const list = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) list.push({ z, x, y });
    }
    return list;
  }

  // Every horizontal point belongs to exactly ONE surface. A polygon offset
  // cannot make intersecting DEM meshes into a valid LOD system.
  function planSurfaceTiles(available, mode = 'partition') {
    const bases = available.filter(t => t.z === BASE_Z);
    const fine = available.filter(t => t.z === IMAGE_Z);
    if (mode === 'base') return bases.map(t => ({ ...t, photo: t }));
    if (mode === 'fine') return fine.map(t => ({ ...t, photo: t }));
    if (mode === 'legacy') return available.map(t => ({ ...t, photo: t }));
    const key = (z, x, y) => `${z}/${x}/${y}`;
    const photos = new Map(available.map(t => [key(t.z, t.x, t.y), t]));
    const ancestors = new Set();
    for (const t of available) for (let z = BASE_Z; z < t.z; z++) {
      const scale = 2 ** (t.z - z);
      ancestors.add(key(z, Math.floor(t.x / scale), Math.floor(t.y / scale)));
    }
    const result = [];
    function visit(z, x, y, inherited) {
      const k = key(z, x, y), photo = photos.get(k) || inherited;
      if (ancestors.has(k)) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
          visit(z + 1, x * 2 + dx, y * 2 + dy, photo);
      } else if (photo) result.push({ z, x, y, photo });
    }
    // Start only at photos with no loaded ancestor: also works while the
    // overview has not arrived, or a parent request fails. Never overlap roots.
    for (const t of available) {
      let hasParent = false;
      for (let z = t.z - 1; z >= BASE_Z; z--) {
        const scale = 2 ** (t.z - z);
        if (photos.has(key(z, Math.floor(t.x / scale), Math.floor(t.y / scale)))) { hasParent = true; break; }
      }
      if (!hasParent) visit(t.z, t.x, t.y, null);
    }
    return result;
  }

  function fillTemplate(tmpl, z, x, y) {
    return tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  function decodeTerrarium(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pix = ctx.getImageData(0, 0, image.width, image.height).data;
    const heights = new Float32Array(image.width * image.height);
    for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
      heights[i] = pix[p] * 256 + pix[p + 1] + pix[p + 2] / 256 - 32768;
    }
    return { width: image.width, height: image.height, heights };
  }

  function loadImage(url) {
    const image = new Image();
    let rejectLoad;
    const promise = new Promise((resolve, reject) => {
      rejectLoad = reject;
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load ' + url));
      image.src = url;
    });
    promise.cancel = () => {
      image.onload = image.onerror = null;
      image.src = '';
      const error = new Error('User retried pending map request');
      error.cancelled = true;
      rejectLoad(error);
    };
    return promise;
  }

  function shader(gl, type, source) {
    const result = gl.createShader(type);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(result));
    return result;
  }

  function createProgram(gl, vary) {
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, `
      attribute vec3 position;
      attribute vec2 uv;
      uniform vec3 eye, rightAxis, upAxis, forwardAxis;
      uniform vec2 lens;
      varying ${vary} vec2 vUv;
      varying ${vary} float depth;
      void main() {
        vec3 delta = position - eye;
        depth = dot(delta, forwardAxis);
        gl_Position = vec4(dot(delta,rightAxis)*lens.x, dot(delta,upAxis)*lens.y,
                           depth*1.00005-0.4, depth);
        vUv = uv;
      }`));
    gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying ${vary} vec2 vUv;
      varying ${vary} float depth;
      uniform sampler2D photo;
      uniform float hasPhoto;
      uniform vec4 photoTransform;
      uniform vec3 fallbackColour;
      void main() {
        vec3 colour = hasPhoto > 0.5 ? texture2D(photo, vUv * photoTransform.xy + photoTransform.zw).rgb : fallbackColour;
        float haze = min(0.55, 1.0-exp(-max(0.0,depth)*0.00008));
        gl_FragColor = vec4(mix(colour, vec3(0.69,0.84,0.81), haze), 1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    return program;
  }

  function createTileManager(gl, elevationFn) {
    const lowPower = typeof window !== 'undefined' && !!window.GAME_LOW_POWER;
    const maxConcurrent = lowPower ? 2 : MAX_CONCURRENT;
    const photoLimits = lowPower ? { 15: 16, 17: 12, 18: 0 } : PHOTO_CACHE_LIMITS;
    const maxTerrainTiles = lowPower ? 24 : 96;
    const meshBuildBudget = lowPower ? 2 : 8;
    let builtThisFrame = 0;
    const vary = (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT) || {}).precision
      ? 'highp' : 'mediump';
    const program = createProgram(gl, vary);
    const uniforms = hkEntries(
      ['eye', 'rightAxis', 'upAxis', 'forwardAxis', 'lens', 'photo', 'hasPhoto', 'fallbackColour', 'photoTransform']
        .map(name => [name, gl.getUniformLocation(program, name)])
    );
    const aPos = gl.getAttribLocation(program, 'position');
    const aUv = gl.getAttribLocation(program, 'uv');
    const images = new Map();
    const terrains = new Map();
    const textures = new Map();
    const meshes = new Map();
    const queue = [];
    const queued = new Set();
    const activeRequests = new Map();
    const query = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const layerMode = ['base', 'fine', 'legacy'].includes(query.get('mapLayers')) ? query.get('mapLayers') : 'partition';
    const flatDebug = query.get('mapHeight') === 'flat';
    const hideSkirts = query.get('hideSkirts') === '1';
    const detailEnabled = query.get('detail') !== 'off';
    let localDetailActive = false;
    let craftPosition = { x: 0, z: 0 };
    const photoCentres = new Map();
    const retryAfter = new Map();
    let lastDrawStats = { patches: 0, topTriangles: 0, skirtTriangles: 0, missingPhotos: 0 };
    let surfacePlan = [], planDirty = true, terrainRevision = 0;
    let inflight = 0, failed = 0, loadedImages = 0, loadedTerrain = 0, lastBase = false;
    const status = { mode: 'loading', message: '正在載入全港地圖…', failed: 0 };
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      status.mode = 'offline';
      status.message = '目前以 file:// 開啟，瀏覽器通常無法載入全港圖磚。已用長洲離線地圖。請改用啟動遊戲.bat（http://127.0.0.1:8770/）。';
    }

    function rememberImage(key, image) {
      images.set(key, image);
      planDirty = true;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      textures.set(key, texture);
    }

    function sampleTerrarium(lat, lon) {
      const tx = lon2tile(lon, TERRAIN_Z), ty = lat2tile(lat, TERRAIN_Z);
      const ix = Math.floor(tx), iy = Math.floor(ty);
      const grid = terrains.get(tileKey('ter', TERRAIN_Z, ix, iy));
      if (!grid) return null;
      // Terrarium samples are pixel centres, not vertices spanning [0,1].
      // Interpolate in one global pixel lattice and read adjacent DEM tiles.
      const px = tx * grid.width - 0.5, py = ty * grid.height - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      function pixel(x, y) {
        const gx = Math.floor(x / grid.width), gy = Math.floor(y / grid.height);
        const neighbor = terrains.get(tileKey('ter', TERRAIN_Z, gx, gy));
        if (neighbor) return neighbor.heights[(y - gy * grid.height) * neighbor.width + x - gx * grid.width];
        const cx = Math.max(0, Math.min(grid.width - 1, x - ix * grid.width));
        const cy = Math.max(0, Math.min(grid.height - 1, y - iy * grid.height));
        return grid.heights[cy * grid.width + cx];
      }
      return Math.max(0, (pixel(x0, y0) * (1-fx) + pixel(x0+1, y0) * fx) * (1-fy)
        + (pixel(x0, y0+1) * (1-fx) + pixel(x0+1, y0+1) * fx) * fy);
    }

    function heightMode() {
      return (HK.heightDebug && HK.heightDebug.mode) || 'auto';
    }

    function heightAt(lat, lon, x, z) {
      if (flatDebug) return 0;
      if (heightMode() === 'baked') {
        const local = elevationFn && elevationFn(x, z);
        return local == null ? 0 : Math.max(0, local);
      }
      // Online surfaces NEVER combine the old atlas/local DTM with Terrarium.
      // Missing DEM is provisional 0 for every LOD, invalidated on every arrival.
      return sampleTerrarium(lat, lon) || 0;
    }

    function buildMesh(z, x, y) {
      const grid = z >= DETAIL_Z ? 9 : z > IMAGE_Z ? 17 : GRID;
      const positions = [], uvs = [], indices = [];
      for (let r = 0; r < grid; r++) {
        const vt = r / (grid - 1);
        for (let c = 0; c < grid; c++) {
          const ut = c / (grid - 1);
          const lon = tile2lon(x + ut, z);
          const lat = tile2lat(y + vt, z);
          const p = toXZ(lat, lon);
          // vt=0 is the north edge (tile row y), vt=1 is south (y+1).
          // With UNPACK_FLIP_Y_WEBGL=0, v=0 samples the top row of the PNG,
          // which is north in XYZ / Web Mercator tiles. Using 1-vt flipped
          // every tile, breaking coastlines and leaving rectangular seams.
          positions.push(p.x, heightAt(lat, lon, p.x, p.z), p.z);
          uvs.push(ut, vt);
        }
      }
      for (let r = 0; r < grid - 1; r++) {
        for (let c = 0; c < grid - 1; c++) {
          const i = r * grid + c;
          indices.push(i, i + 1, i + grid, i + 1, i + grid + 1, i + grid);
        }
      }
      const topCount = indices.length;
      // Vertical edge skirts cover T-junction cracks where two non-overlapping
      // patches have different tessellation. They have zero horizontal area;
      // unlike the old coarse layer they cannot cover a town/hill interior.
      if (layerMode !== 'legacy') {
        const edges = [[], [], [], []];
        for (let i = 0; i < grid; i++) {
          edges[0].push(i); edges[1].push(i * grid + grid - 1);
          edges[2].push((grid - 1) * grid + i); edges[3].push(i * grid);
        }
        for (const edge of edges) for (let j = 0; j < edge.length - 1; j++) {
          const a = edge[j], b = edge[j+1], lo = positions.length / 3;
          for (const i of [a, b]) {
            positions.push(positions[i*3], positions[i*3+1] - 150, positions[i*3+2]);
            uvs.push(uvs[i*2], uvs[i*2+1]);
          }
          indices.push(a, b, lo, b, lo+1, lo);
        }
      }
      const buffer = gl.createBuffer();
      const packed = new Float32Array(indices.length * 5);
      let w = 0;
      for (const i of indices) {
        packed[w++] = positions[i * 3];
        packed[w++] = positions[i * 3 + 1];
        packed[w++] = positions[i * 3 + 2];
        packed[w++] = uvs[i * 2];
        packed[w++] = uvs[i * 2 + 1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);
      return { buffer, count: indices.length, topCount, byteLength: packed.byteLength, revision: terrainRevision };
    }

    function surfaceTiles() {
      if (!planDirty) return surfacePlan;
      const available = [...images.keys()].filter(k => k.startsWith('img/')).map(k => {
        const [, z, x, y] = k.split('/').map(Number);
        return { z, x, y };
      });
      surfacePlan = planSurfaceTiles(available, layerMode);
      const wanted = new Set(surfacePlan.map(t => tileKey('mesh', t.z, t.x, t.y)));
      for (const [key, mesh] of meshes) if (!wanted.has(key)) {
        gl.deleteBuffer(mesh.buffer); meshes.delete(key);
      }
      planDirty = false;
      return surfacePlan;
    }

    function rebuildAllMeshes() {
      terrainRevision++;
      for (const mesh of meshes.values()) gl.deleteBuffer(mesh.buffer);
      meshes.clear();
    }

    function enqueue(job) {
      if (queued.has(job.key) || images.has(job.key) || terrains.has(job.key) || (retryAfter.get(job.key) || 0) > Date.now()) return;
      queued.add(job.key);
      queue.push(job);
    }

    function pump() {
      while (inflight < maxConcurrent && queue.length) {
        const job = queue.shift();
        inflight++;
        const url = fillTemplate(job.kind === 'terrain' ? TERRAIN_TMPL : IMAGERY_TMPL, job.z, job.x, job.y);
        const request = loadImage(url);
        activeRequests.set(job.key, request);
        request.then(image => {
          if (job.kind === 'image' && !retainPhoto(job.z, job.x, job.y)) return;
          if (job.kind === 'terrain') {
            terrains.set(job.key, decodeTerrarium(image));
            loadedTerrain++;
            // All LODs depend on the same DEM. In r8 only z15 was rebuilt,
            // leaving z12 permanently on pre-download/local elevations.
            rebuildAllMeshes();
          } else {
            rememberImage(job.key, image);
            loadedImages++;
            const own = toLonLat(craftPosition.x, craftPosition.z);
            evict(Math.floor(lon2tile(own.lon, TERRAIN_Z)), Math.floor(lat2tile(own.lat, TERRAIN_Z)));

          }
          status.failed = failed;
          if (loadedImages > 0) {
            status.mode = 'online';
            status.message = '全港地圖（需網絡）';
          }
        }).catch((error) => {
          if (error.cancelled) return;
          failed++;
          retryAfter.set(job.key, Date.now() + 30000);
          if (retryAfter.size > 256) retryAfter.delete(retryAfter.keys().next().value);
          status.failed = failed;
          if (loadedImages + loadedTerrain === 0 && (failed >= 3 || status.mode === 'offline')) {
            status.mode = 'offline';
            if (typeof location !== 'undefined' && location.protocol === 'file:') {
              status.message = '目前以 file:// 開啟，瀏覽器通常無法載入全港圖磚。已用長洲離線地圖。請改用啟動遊戲.bat（http://127.0.0.1:8770/）。';
            } else {
              status.message = '未能載入全港圖磚，已改用長洲離線地圖' + (error && error.message ? '（' + error.message + '）' : '');
            }
          }
        }).finally(() => {
          inflight--;
          activeRequests.delete(job.key);
          queued.delete(job.key);
          pump();
        });
      }
    }

    function retainPhoto(z, x, y) {
      if (z === BASE_Z && !lowPower) return true;
      if (z === CLOSE_Z && lowPower) return false;
      const centre = photoCentres.get(z);
      if (!centre || (z >= DETAIL_Z && !localDetailActive)) return false;
      const keep = lowPower ? 2 : z === CLOSE_Z ? 2 : KEEP_RADIUS;
      return Math.abs(x - centre.x) <= keep && Math.abs(y - centre.y) <= keep;
    }

    function removePhoto(key) {
      gl.deleteTexture(textures.get(key));
      textures.delete(key); images.delete(key); planDirty = true;
    }

    function evict(tcx, tcy) {
      for (const key of [...textures.keys()]) {
        const [, z, x, y] = key.split('/').map(Number);
        if (!retainPhoto(z, x, y)) removePhoto(key);
      }
      const limits = lowPower ? { ...photoLimits, 12: 25 } : photoLimits;
      for (const [zoom, limit] of Object.entries(limits)) {
        const z = +zoom, centre = photoCentres.get(z);
        if (!centre) continue;
        const keys = [...textures.keys()].filter(k => +k.split('/')[1] === z);
        keys.sort((a,b) => {
          const [, , ax, ay] = a.split('/').map(Number), [, , bx, by] = b.split('/').map(Number);
          return Math.hypot(bx-centre.x,by-centre.y) - Math.hypot(ax-centre.x,ay-centre.y);
        });
        while (keys.length > limit) removePhoto(keys.shift());
      }
      // Keep a wider DEM halo than photos; never change the height underneath
      // still-visible coarse patches merely because the drone crossed a tile.
      // Bounded cache for long exploratory sessions (96 * 256² * 4 = 24 MiB).
      if (terrains.size > maxTerrainTiles) {
        for (const key of [...terrains.keys()]) {
          const parts = key.split('/');
          if (Math.abs(+parts[2] - tcx) > KEEP_RADIUS + 2 || Math.abs(+parts[3] - tcy) > KEEP_RADIUS + 2)
            terrains.delete(key);
          if (terrains.size <= maxTerrainTiles) break;
        }
        rebuildAllMeshes();
      }
    }

    function requestAround(x, z, camera) {
      craftPosition = { x, z };
      const { lat, lon } = toLonLat(x, z);
      localDetailActive = detailEnabled && inCheungChau(lat, lon);
      const tcx = Math.floor(lon2tile(lon, TERRAIN_Z)), tcy = Math.floor(lat2tile(lat, TERRAIN_Z));
      photoCentres.set(BASE_Z, { x: Math.floor(lon2tile(lon, BASE_Z)), y: Math.floor(lat2tile(lat, BASE_Z)) });
      photoCentres.set(IMAGE_Z, { x: Math.floor(lon2tile(lon, IMAGE_Z)), y: Math.floor(lat2tile(lat, IMAGE_Z)) });
      // Place the sharp patch ahead of the drone, where a 200 m oblique camera
      // sees the ground, instead of spending all detail behind/below the camera.
      const look = camera && camera.forward;
      const focus = toLonLat(x + (look ? look[0] * 350 : 0), z + (look ? look[2] * 350 : 0));
      for (const zoom of [DETAIL_Z, CLOSE_Z]) photoCentres.set(zoom, {
        x: Math.floor(lon2tile(focus.lon, zoom)), y: Math.floor(lat2tile(focus.lat, zoom))
      });
      // Drop queued requests from places the player has already left. At most
      // MAX_CONCURRENT old requests can finish, and their photos are discarded.
      for (let i = queue.length - 1; i >= 0; i--) {
        const job = queue[i];
        const needed = job.kind === 'terrain'
          ? Math.abs(job.x-tcx) <= 1 && Math.abs(job.y-tcy) <= 1
          : retainPhoto(job.z, job.x, job.y);
        if (!needed) { queued.delete(job.key); queue.splice(i,1); }
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) enqueue({
        kind: 'terrain', key: tileKey('ter', TERRAIN_Z, tcx + dx, tcy + dy),
        z: TERRAIN_Z, x: tcx + dx, y: tcy + dy, distance: Math.hypot(dx,dy)
      });
      const levels = [{ z: IMAGE_Z, radius: lowPower || localDetailActive ? 1 : LOAD_RADIUS }];
      if (localDetailActive) {
        levels.push({ z: DETAIL_Z, radius: lowPower ? 1 : 2 });
        if (!lowPower) levels.push({ z: CLOSE_Z, radius: 1 });
      }
      for (const level of levels) {
        const centre = photoCentres.get(level.z);
        for (let dy = -level.radius; dy <= level.radius; dy++) for (let dx = -level.radius; dx <= level.radius; dx++) {
          const px = centre.x + dx, py = centre.y + dy;
          if (level.z >= DETAIL_Z && !touchesCheungChau(level.z, px, py)) continue;
          enqueue({ kind: 'image', key: tileKey('img', level.z, px, py), z: level.z, x: px, y: py, distance: Math.hypot(dx,dy) });
        }
      }
      if (!lastBase || lowPower) {
        const baseCentre = photoCentres.get(BASE_Z);
        tilesCovering(WEST, SOUTH, EAST, NORTH, BASE_Z).filter(t => !lowPower ||
          (Math.abs(t.x-baseCentre.x) <= 1 && Math.abs(t.y-baseCentre.y) <= 1)).forEach(t => enqueue({ kind: 'image', key: tileKey('img', t.z, t.x, t.y), ...t }));
        lastBase = true;
      }
      queue.sort((a,b) => {
        // First two phone requests: centre DEM + centre overview photo, not
        // NINE sequential DEM downloads before the first photo can even start.
        const priority = t => t.kind === 'terrain' && t.distance === 0 ? 0
          : t.z === BASE_Z && t.x === photoCentres.get(BASE_Z).x && t.y === photoCentres.get(BASE_Z).y ? 1
          : t.kind === 'image' && t.z === IMAGE_Z && t.distance === 0 ? 2
          : t.kind === 'terrain' ? 3 : t.z === IMAGE_Z ? 4 : t.z === BASE_Z ? 5 : t.z === DETAIL_Z ? 6 : 7;
        return priority(a)-priority(b) || (a.distance || 0)-(b.distance || 0);
      });
      evict(tcx, tcy);
      pump();
    }

    function draw(camera) {
      gl.useProgram(program);
      gl.uniform3fv(uniforms.eye, camera.eye);
      gl.uniform3fv(uniforms.rightAxis, camera.right);
      gl.uniform3fv(uniforms.upAxis, camera.up);
      gl.uniform3fv(uniforms.forwardAxis, camera.forward);
      gl.uniform2f(uniforms.lens, camera.fx, camera.fy);
      gl.uniform1i(uniforms.photo, 0);
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aUv);
      const plan = surfaceTiles();
      const pending = plan.filter(t => !meshes.has(tileKey('mesh', t.z, t.x, t.y))).sort((a,b) => {
        const distance = t => { const box = tileBoundsXZ(t.z,t.x,t.y); return Math.hypot((box.minX+box.maxX)/2-camera.eye[0],(box.minZ+box.maxZ)/2-camera.eye[2]); };
        return distance(a)-distance(b);
      });
      builtThisFrame = 0;
      for (const t of pending.slice(0, meshBuildBudget)) {
        meshes.set(tileKey('mesh', t.z, t.x, t.y), buildMesh(t.z,t.x,t.y));
        builtThisFrame++;
      }
      lastDrawStats = { patches: plan.length, topTriangles: 0, skirtTriangles: 0, missingPhotos: 0 };
      for (const t of plan) {
        const { z, x, y, photo } = t;
        const key = tileKey('mesh', z, x, y);
        if (!meshes.has(key)) continue;
        const mesh = meshes.get(key);
        const texKey = tileKey('img', photo.z, photo.x, photo.y);
        const scale = 2 ** (photo.z - z);
        gl.uniform4f(uniforms.photoTransform, scale, scale, x * scale - photo.x, y * scale - photo.y);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 20, 12);
        gl.activeTexture(gl.TEXTURE0);
        if (textures.has(texKey)) {
          gl.bindTexture(gl.TEXTURE_2D, textures.get(texKey));
          gl.uniform1f(uniforms.hasPhoto, 1);
        } else {
          lastDrawStats.missingPhotos++;
          gl.uniform1f(uniforms.hasPhoto, 0);
          gl.uniform3f(uniforms.fallbackColour, 0.35, 0.48, 0.36);
        }
        // No polygon offset / overlapping coarse underlay. The partition
        // already excludes each fine tile's footprint from its parent.
        lastDrawStats.topTriangles += mesh.topCount / 3;
        lastDrawStats.skirtTriangles += hideSkirts ? 0 : (mesh.count - mesh.topCount) / 3;
        gl.drawArrays(gl.TRIANGLES, 0, hideSkirts ? mesh.topCount : mesh.count);
      }
    }

    function terrainElevation(x, z) {
      const { lat, lon } = toLonLat(x, z);
      if (status.mode === 'offline' && heightMode() !== 'tiles' && elevationFn) {
        const local = elevationFn(x, z);
        return local == null ? 0 : Math.max(0, local);
      }
      return heightAt(lat, lon, x, z);
    }

    function setHeightMode(mode) {
      if (mode !== 'auto' && mode !== 'tiles' && mode !== 'baked') return;
      HK.heightDebug.mode = mode;
      rebuildAllMeshes();
    }
    function getHeightMode() { return heightMode(); }

    function paintMinimap(ctx, craft) {
      const width = ctx.canvas.width, height = ctx.canvas.height;
      ctx.fillStyle = '#204d5d';
      ctx.fillRect(0, 0, width, height);
      const scale = 90;
      const worldToPix = (x, zz) => [
        width / 2 + (x - craft.x) / scale,
        height / 2 - (zz - craft.z) / scale
      ];
      const layers = [...images.entries()].map(([key, image]) => {
        const parts = key.split('/');
        return { image, kind: parts[0], z: +parts[1], x: +parts[2], y: +parts[3] };
      }).filter(t => t.kind === 'img' && t.z >= BASE_Z)
        .sort((a, b) => a.z - b.z);
      for (const t of layers) {
        const b = tileBoundsXZ(t.z, t.x, t.y);
        const a = worldToPix(b.minX, b.maxZ);
        const c = worldToPix(b.maxX, b.minZ);
        if (c[0] < -2 || a[0] > width + 2 || c[1] < -2 || a[1] > height + 2) continue;
        try { ctx.drawImage(t.image, a[0], a[1], c[0] - a[0], c[1] - a[1]); } catch (e) {}
      }
      return worldToPix;
    }

    function debugSnapshot() {
      return {
        layerMode, flatDebug, hideSkirts, detailEnabled, localDetailActive,
        lowPower, maxConcurrent, meshBuildBudget, builtThisFrame, maxTerrainTiles,
        pendingMeshCount: surfaceTiles().length - meshes.size,
        cacheByZoom: hkEntries([BASE_Z, IMAGE_Z, DETAIL_Z, CLOSE_Z].map(z => [z, [...textures.keys()].filter(k => +k.split('/')[1] === z).length])),
        estimatedPhotoBytes: textures.size * 256 * 256 * 8,
        geometryBytes: [...meshes.values()].reduce((sum, m) => sum + m.byteLength, 0),
        cacheLimits: { ...photoLimits },
        lastDrawStats: { ...lastDrawStats },
        terrainRevision, loadedImages, loadedTerrain,
        pending: queue.length, inflight, failed, meshCount: meshes.size,
        surface: surfaceTiles().map(t => ({ ...t, photo: { ...t.photo } })),
        meshRevisions: [...meshes.values()].map(m => m.revision)
      };
    }
    function retry() {
      retryAfter.clear();
      failed = 0;
      status.failed = 0;
      status.mode = loadedImages ? 'online' : 'loading';
      status.message = '正在重試全港圖磚；已完成圖磚會保留';
      // Explicit user retry can restart a stalled request. Abort its Image
      // before releasing ownership; finally() frees the same concurrency slot.
      for (const request of activeRequests.values()) request.cancel();
      planDirty = true;
      pump();
    }
    function progressSnapshot() {
      return { loadedImages, loadedTerrain, inflight, pending: queue.length,
        draw: { ...lastDrawStats }, mode: status.mode };
    }
    return { retry, progressSnapshot, requestAround, draw, terrainElevation, paintMinimap, status, bounds, setHeightMode, getHeightMode, rebuildAllMeshes, debugSnapshot };
  }

  const heightDebug = { mode: 'auto' };
  if (typeof location !== 'undefined' && location.search) {
    const q = new URLSearchParams(location.search);
    if (q.get('tilesOnly') === '1' || q.get('height') === 'tiles') heightDebug.mode = 'tiles';
    else if (q.get('height') === 'baked') heightDebug.mode = 'baked';
  }

  return {
    ORIGIN_LAT, ORIGIN_LON, bounds, places, MAX_ALTITUDE, MIN_AGL,
    LANDSD_LOGO, IMAGERY_TMPL, TERRAIN_TMPL, heightDebug,
    toXZ, toLonLat, lon2tile, lat2tile, tile2lon, tile2lat,
    tilesCovering, tileKey, tileBoundsXZ, planSurfaceTiles, createTileManager,
    WEST, EAST, SOUTH, NORTH, BASE_Z, TERRAIN_Z, IMAGE_Z, DETAIL_Z, CLOSE_Z, CHEUNG_CHAU, inCheungChau, PHOTO_CACHE_LIMITS
  };
})();
