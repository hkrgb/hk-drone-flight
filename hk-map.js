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
  const IMAGE_Z = 15;
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
    // Diagnostic only: reproduce r8's overlapping ownership, not the default.
    if (mode === 'legacy') return [...bases, ...fine].map(t => ({ ...t, photo: t }));
    const fineKeys = new Set(fine.map(t => `${t.x}/${t.y}`));
    const ancestors = new Set();
    for (const t of fine) {
      for (let z = BASE_Z; z < IMAGE_Z; z++) {
        const scale = 2 ** (IMAGE_Z - z);
        ancestors.add(`${z}/${Math.floor(t.x / scale)}/${Math.floor(t.y / scale)}`);
      }
    }
    const result = [];
    function visit(z, x, y, photo) {
      if (z === IMAGE_Z && fineKeys.has(`${x}/${y}`)) {
        result.push({ z, x, y, photo: { z, x, y } });
      } else if (ancestors.has(`${z}/${x}/${y}`)) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
          visit(z + 1, x * 2 + dx, y * 2 + dy, photo);
      } else result.push({ z, x, y, photo });
    }
    const baseKeys = new Set(bases.map(t => `${t.x}/${t.y}`));
    for (const t of bases) visit(t.z, t.x, t.y, t);
    for (const t of fine) {
      const scale = 2 ** (IMAGE_Z - BASE_Z);
      if (!baseKeys.has(`${Math.floor(t.x / scale)}/${Math.floor(t.y / scale)}`))
        result.push({ ...t, photo: t });
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
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load ' + url));
      image.src = url;
    });
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
    const vary = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision
      ? 'highp' : 'mediump';
    const program = createProgram(gl, vary);
    const uniforms = Object.fromEntries(
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
    const query = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const layerMode = ['base', 'fine', 'legacy'].includes(query.get('mapLayers')) ? query.get('mapLayers') : 'partition';
    const flatDebug = query.get('mapHeight') === 'flat';
    const hideSkirts = query.get('hideSkirts') === '1';
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
      return sampleTerrarium(lat, lon) ?? 0;
    }

    function buildMesh(z, x, y) {
      const positions = [], uvs = [], indices = [];
      for (let r = 0; r < GRID; r++) {
        const vt = r / (GRID - 1);
        for (let c = 0; c < GRID; c++) {
          const ut = c / (GRID - 1);
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
      for (let r = 0; r < GRID - 1; r++) {
        for (let c = 0; c < GRID - 1; c++) {
          const i = r * GRID + c;
          indices.push(i, i + 1, i + GRID, i + 1, i + GRID + 1, i + GRID);
        }
      }
      const topCount = indices.length;
      // Vertical edge skirts cover T-junction cracks where two non-overlapping
      // patches have different tessellation. They have zero horizontal area;
      // unlike the old coarse layer they cannot cover a town/hill interior.
      if (layerMode !== 'legacy') {
        const edges = [[], [], [], []];
        for (let i = 0; i < GRID; i++) {
          edges[0].push(i); edges[1].push(i * GRID + GRID - 1);
          edges[2].push((GRID - 1) * GRID + i); edges[3].push(i * GRID);
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
      return { buffer, count: indices.length, topCount, revision: terrainRevision };
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
      if (queued.has(job.key) || images.has(job.key) || terrains.has(job.key)) return;
      queued.add(job.key);
      queue.push(job);
    }

    function pump() {
      while (inflight < MAX_CONCURRENT && queue.length) {
        const job = queue.shift();
        inflight++;
        const url = fillTemplate(job.kind === 'terrain' ? TERRAIN_TMPL : IMAGERY_TMPL, job.z, job.x, job.y);
        loadImage(url).then(image => {
          if (job.kind === 'terrain') {
            terrains.set(job.key, decodeTerrarium(image));
            loadedTerrain++;
            // All LODs depend on the same DEM. In r8 only z15 was rebuilt,
            // leaving z12 permanently on pre-download/local elevations.
            rebuildAllMeshes();
          } else {
            rememberImage(job.key, image);
            loadedImages++;

          }
          status.failed = failed;
          if (loadedImages > 0) {
            status.mode = 'online';
            status.message = '全港地圖（需網絡）';
          }
        }).catch((error) => {
          failed++;
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
          queued.delete(job.key);
          pump();
        });
      }
    }

    function evict(tcx, tcy, icx, icy) {
      for (const key of [...textures.keys()]) {
        const parts = key.split('/');
        const z = +parts[1], x = +parts[2], y = +parts[3];
        if (z !== BASE_Z && z === IMAGE_Z && (Math.abs(x - icx) > KEEP_RADIUS || Math.abs(y - icy) > KEEP_RADIUS)) {
          gl.deleteTexture(textures.get(key));
          textures.delete(key);
          images.delete(key);
          planDirty = true;
        }
      }
      // Keep a wider DEM halo than photos; never change the height underneath
      // still-visible coarse patches merely because the drone crossed a tile.
      // Bounded cache for long exploratory sessions (96 * 256² * 4 = 24 MiB).
      if (terrains.size > 96) {
        for (const key of [...terrains.keys()]) {
          const parts = key.split('/');
          if (Math.abs(+parts[2] - tcx) > KEEP_RADIUS + 2 || Math.abs(+parts[3] - tcy) > KEEP_RADIUS + 2)
            terrains.delete(key);
          if (terrains.size <= 96) break;
        }
        rebuildAllMeshes();
      }
    }

    function requestAround(x, z) {
      const { lat, lon } = toLonLat(x, z);
      const tcx = Math.floor(lon2tile(lon, TERRAIN_Z));
      const tcy = Math.floor(lat2tile(lat, TERRAIN_Z));
      const icx = Math.floor(lon2tile(lon, IMAGE_Z));
      const icy = Math.floor(lat2tile(lat, IMAGE_Z));
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          enqueue({
            kind: 'terrain',
            key: tileKey('ter', TERRAIN_Z, tcx + dx, tcy + dy),
            z: TERRAIN_Z, x: tcx + dx, y: tcy + dy
          });
        }
      }
      for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          enqueue({
            kind: 'image',
            key: tileKey('img', IMAGE_Z, icx + dx, icy + dy),
            z: IMAGE_Z, x: icx + dx, y: icy + dy
          });
        }
      }
      if (!lastBase) {
        tilesCovering(WEST, SOUTH, EAST, NORTH, BASE_Z).forEach(t => {
          enqueue({ kind: 'image', key: tileKey('img', t.z, t.x, t.y), ...t });
        });
        lastBase = true;
      }
      // Near DEM/photos first, not the whole-HK overview ahead of the drone.
      queue.sort((a, b) => {
        const priority = t => t.kind === 'terrain' ? 0 : t.z === IMAGE_Z ? 1 : 2;
        return priority(a) - priority(b);
      });
      pump();
      evict(tcx, tcy, icx, icy);
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
      lastDrawStats = { patches: plan.length, topTriangles: 0, skirtTriangles: 0, missingPhotos: 0 };
      for (const t of plan) {
        const { z, x, y, photo } = t;
        const key = tileKey('mesh', z, x, y);
        if (!meshes.has(key)) meshes.set(key, buildMesh(z, x, y));
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
      }).filter(t => t.kind === 'img' && (t.z === BASE_Z || t.z === IMAGE_Z))
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
        layerMode, flatDebug, hideSkirts, lastDrawStats: { ...lastDrawStats },
        terrainRevision, loadedImages, loadedTerrain,
        pending: queue.length, inflight, failed, meshCount: meshes.size,
        surface: surfaceTiles().map(t => ({ ...t, photo: { ...t.photo } })),
        meshRevisions: [...meshes.values()].map(m => m.revision)
      };
    }
    return { requestAround, draw, terrainElevation, paintMinimap, status, bounds, setHeightMode, getHeightMode, rebuildAllMeshes, debugSnapshot };
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
    WEST, EAST, SOUTH, NORTH, BASE_Z, TERRAIN_Z, IMAGE_Z
  };
})();
