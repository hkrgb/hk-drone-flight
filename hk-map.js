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
      uniform vec3 fallbackColour;
      void main() {
        vec3 colour = hasPhoto > 0.5 ? texture2D(photo, vUv).rgb : fallbackColour;
        float haze = min(0.55, 1.0-exp(-max(0.0,depth)*0.00008));
        gl_FragColor = vec4(mix(colour, vec3(0.69,0.84,0.81), haze), 1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    return program;
  }

  function sampleHeightGrid(grid, u, v) {
    const c = Math.max(0, Math.min(grid.width - 1.001, u * (grid.width - 1)));
    const r = Math.max(0, Math.min(grid.height - 1.001, v * (grid.height - 1)));
    const x0 = Math.floor(c), y0 = Math.floor(r);
    const tx = c - x0, ty = r - y0;
    const x1 = Math.min(grid.width - 1, x0 + 1);
    const y1 = Math.min(grid.height - 1, y0 + 1);
    const h00 = grid.heights[y0 * grid.width + x0];
    const h10 = grid.heights[y0 * grid.width + x1];
    const h01 = grid.heights[y1 * grid.width + x0];
    const h11 = grid.heights[y1 * grid.width + x1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }

  function createTileManager(gl, elevationFn) {
    const vary = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision
      ? 'highp' : 'mediump';
    const program = createProgram(gl, vary);
    const uniforms = Object.fromEntries(
      ['eye', 'rightAxis', 'upAxis', 'forwardAxis', 'lens', 'photo', 'hasPhoto', 'fallbackColour']
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
    let inflight = 0, failed = 0, loadedImages = 0, loadedTerrain = 0, lastBase = false;
    const status = { mode: 'loading', message: '正在載入全港地圖…', failed: 0 };
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      status.mode = 'offline';
      status.message = '目前以 file:// 開啟，瀏覽器通常無法載入全港圖磚。已用長洲離線地圖。請改用啟動遊戲.bat（http://127.0.0.1:8770/）。';
    }

    function rememberImage(key, image) {
      images.set(key, image);
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

    function heightAt(lat, lon, x, z) {
      const local = elevationFn ? elevationFn(x, z) : null;
      if (local != null) return Math.max(0, local);
      const tx = lon2tile(lon, TERRAIN_Z);
      const ty = lat2tile(lat, TERRAIN_Z);
      const key = tileKey('ter', TERRAIN_Z, Math.floor(tx), Math.floor(ty));
      const grid = terrains.get(key);
      if (!grid) return 0;
      return Math.max(0, sampleHeightGrid(grid, tx - Math.floor(tx), ty - Math.floor(ty)));
    }

    function buildMesh(z, x, y, flat) {
      const positions = [], uvs = [], indices = [];
      for (let r = 0; r < GRID; r++) {
        const vt = r / (GRID - 1);
        for (let c = 0; c < GRID; c++) {
          const ut = c / (GRID - 1);
          const lon = tile2lon(x + ut, z);
          const lat = tile2lat(y + vt, z);
          const p = toXZ(lat, lon);
          positions.push(p.x, flat ? -0.5 : heightAt(lat, lon, p.x, p.z), p.z);
          uvs.push(ut, 1 - vt);
        }
      }
      for (let r = 0; r < GRID - 1; r++) {
        for (let c = 0; c < GRID - 1; c++) {
          const i = r * GRID + c;
          indices.push(i, i + 1, i + GRID, i + 1, i + GRID + 1, i + GRID);
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
      return { buffer, count: indices.length };
    }

    function maybeMesh(z, x, y, flat) {
      const key = tileKey('mesh', z, x, y);
      if (meshes.has(key)) {
        if (!flat && !meshes.get(key).hasHeight && terrains.size) {
          gl.deleteBuffer(meshes.get(key).buffer);
          const rebuilt = buildMesh(z, x, y, false);
          rebuilt.hasHeight = true;
          meshes.set(key, rebuilt);
        }
        return;
      }
      if (!flat) {
        const { lon, lat } = { lon: tile2lon(x + 0.5, z), lat: tile2lat(y + 0.5, z) };
        const parent = tileKey('ter', TERRAIN_Z, Math.floor(lon2tile(lon, TERRAIN_Z)), Math.floor(lat2tile(lat, TERRAIN_Z)));
        if (!terrains.has(parent) && !(elevationFn && elevationFn(toXZ(lat, lon).x, toXZ(lat, lon).z) != null)) {
          return;
        }
      }
      const built = buildMesh(z, x, y, flat);
      built.hasHeight = !flat;
      meshes.set(key, built);
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
            for (const imgKey of [...images.keys()]) {
              const parts = imgKey.split('/');
              if (parts[0] === 'img' && +parts[1] === IMAGE_Z) maybeMesh(+parts[1], +parts[2], +parts[3], false);
            }
          } else {
            rememberImage(job.key, image);
            loadedImages++;
            maybeMesh(job.z, job.x, job.y, job.z === BASE_Z);
          }
          status.failed = failed;
          if (loadedImages + loadedTerrain > 0) {
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
      for (const [key, mesh] of [...meshes]) {
        const parts = key.split('/');
        const z = +parts[1], x = +parts[2], y = +parts[3];
        if (z === BASE_Z) continue;
        const cc = z === IMAGE_Z ? icx : tcx;
        const cr = z === IMAGE_Z ? icy : tcy;
        if (Math.abs(x - cc) > KEEP_RADIUS || Math.abs(y - cr) > KEEP_RADIUS) {
          gl.deleteBuffer(mesh.buffer);
          meshes.delete(key);
        }
      }
      for (const key of [...textures.keys()]) {
        const parts = key.split('/');
        const z = +parts[1], x = +parts[2], y = +parts[3];
        if (z !== BASE_Z && z === IMAGE_Z && (Math.abs(x - icx) > KEEP_RADIUS || Math.abs(y - icy) > KEEP_RADIUS)) {
          gl.deleteTexture(textures.get(key));
          textures.delete(key);
          images.delete(key);
        }
      }
      for (const key of [...terrains.keys()]) {
        const parts = key.split('/');
        if (Math.abs(+parts[2] - tcx) > KEEP_RADIUS || Math.abs(+parts[3] - tcy) > KEEP_RADIUS) {
          terrains.delete(key);
        }
      }
    }

    function requestAround(x, z) {
      const { lat, lon } = toLonLat(x, z);
      if (!lastBase) {
        tilesCovering(WEST, SOUTH, EAST, NORTH, BASE_Z).forEach(t => {
          enqueue({ kind: 'image', key: tileKey('img', t.z, t.x, t.y), ...t });
        });
        lastBase = true;
      }
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
      const order = [...meshes.entries()].map(([key, mesh]) => ({
        key, mesh, z: +key.split('/')[1]
      })).sort((a, b) => a.z - b.z);
      for (const { key, mesh, z } of order) {
        const parts = key.split('/');
        const texKey = tileKey('img', z, +parts[2], +parts[3]);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 20, 12);
        gl.activeTexture(gl.TEXTURE0);
        if (textures.has(texKey)) {
          gl.bindTexture(gl.TEXTURE_2D, textures.get(texKey));
          gl.uniform1f(uniforms.hasPhoto, 1);
        } else {
          gl.uniform1f(uniforms.hasPhoto, 0);
          gl.uniform3f(uniforms.fallbackColour, 0.35, 0.48, 0.36);
        }
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      }
    }

    function terrainElevation(x, z) {
      const local = elevationFn ? elevationFn(x, z) : null;
      if (local != null) return Math.max(0, local);
      const { lat, lon } = toLonLat(x, z);
      const tx = lon2tile(lon, TERRAIN_Z);
      const ty = lat2tile(lat, TERRAIN_Z);
      const key = tileKey('ter', TERRAIN_Z, Math.floor(tx), Math.floor(ty));
      const grid = terrains.get(key);
      if (!grid) return null;
      return Math.max(0, sampleHeightGrid(grid, tx - Math.floor(tx), ty - Math.floor(ty)));
    }

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

    return { requestAround, draw, terrainElevation, paintMinimap, status, bounds };
  }

  return {
    ORIGIN_LAT, ORIGIN_LON, bounds, places, MAX_ALTITUDE, MIN_AGL,
    LANDSD_LOGO, IMAGERY_TMPL, TERRAIN_TMPL,
    toXZ, toLonLat, lon2tile, lat2tile, tile2lon, tile2lat,
    tilesCovering, tileKey, createTileManager,
    WEST, EAST, SOUTH, NORTH, BASE_Z, TERRAIN_Z, IMAGE_Z
  };
})();
