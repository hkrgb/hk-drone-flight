'use strict';

const GAME_BUILD = window.GAME_BUILD || 'r6-20261121-2335';
function reportInitError(stage, error) {
  const message = String(error && (error.message || error) || 'unknown error').replace(/\s+/g, ' ').slice(0, 280);
  if (typeof window.__diag === 'function') {
    window.__diag({ type: 'init', stage: stage, message: message });
  }
  const stamp = byId('build-id');
  if (stamp) {
    stamp.hidden = false;
    stamp.textContent = '版本 ' + GAME_BUILD + ' · ' + stage;
    stamp.dataset.error = message;
  }
  return message;
}
function showInitFailure(stage, error) {
  const detail = reportInitError(stage, error);
  start.disabled = true;
  start.dataset.unlocked = '0';
  start.textContent = '未能開始飛行';
  if (byId('explore')) byId('explore').disabled = true;
  byId('briefing').textContent = '未能載入 3D 畫面（' + GAME_BUILD + '／' + stage + '）。原因：' + detail;
}

function appendBriefing(note) {
  const node = byId('briefing');
  if (!node || !note) return;
  node.textContent += note;
}

function allSettled(promises) {
  if (typeof Promise.allSettled === 'function') return Promise.allSettled(promises);
  return Promise.all(promises.map(item => Promise.resolve(item).then(
    value => ({ status: 'fulfilled', value: value }),
    reason => ({ status: 'rejected', reason: reason })
  )));
}

// Unlock as soon as the WebGL renderer can draw. Do not wait for network
// tiles, baked atlas images, or drone textures — those settle in the background.
function enableFlightStart() {
  if (start.dataset.unlocked === '1' || start.textContent === '未能開始飛行') return;
  start.dataset.unlocked = '1';
  start.textContent = '開始任務';
  start.disabled = false;
  if (byId('explore')) byId('explore').disabled = false;
  const stamp = byId('build-id');
  if (stamp && window.GAME_DEBUG && !window.__droneInitError && !stamp.dataset.error) {
    stamp.textContent = '版本 ' + GAME_BUILD + ' · 已初始化';
  }
}


const byId = id => document.getElementById(id);
const canvas = byId('world');
const gl = canvas.getContext('webgl', { antialias: true });
const map = byId('map').getContext('2d');
const start = byId('start');
const route = [
  { name: '長洲碼頭', x: 0, y: 200, z: 0 },
  { name: '避風塘上空', x: -440, y: 260, z: 160 },
  { name: '北岸水域', x: -360, y: 280, z: 820 },
  { name: '東灣外海', x: 700, y: 250, z: 100 },
  { name: '長洲碼頭回航', x: 0, y: 200, z: 0 }
];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bearing = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const run = { mode: 'ready', next: 0, time: 0, camera: false, explore: false };
let tiles = null;
let bakedLand = null;
let droneRenderer = null;
const craft = { x: 0, y: 4, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
const keys = new Set();
const pointers = new Map();
const buttons = [...document.querySelectorAll('[data-key]')];
const active = key => keys.has(key) || [...pointers.values()].includes(key);
const items = route.map(point => {
  const li = document.createElement('li');
  li.textContent = point.name;
  byId('route').append(li);
  return li;
});
function populatePlaces() {
  const select = byId('place');
  if (!select) return;
  if (typeof HK === 'undefined' || !HK.places) throw Error('hk-map.js did not load');
  HK.places.forEach(place => {
    const opt = document.createElement('option');
    opt.value = place.id;
    opt.textContent = place.name + (place.mission ? '（任務起點）' : '');
    select.append(opt);
  });
}


function terrainSample(column, row) {
  const index = 2 * (row * 401 + column);
  const sample = terrainBytes.charCodeAt(index) | terrainBytes.charCodeAt(index + 1) << 8;
  return Math.max(0, (sample << 16 >> 16) / 10);
}

const detailGrid = window.HK_DEPARTURE_TERRAIN;
const detailBytes = atob(detailGrid.data);
function bakedElevation(x, z) {
  const c = (x / 103 - 73.3 - detailGrid.x) / detailGrid.step;
  const r = (71.85 - z / 111 - detailGrid.z) / detailGrid.step;
  if (c >= 0 && r >= 0 && c < detailGrid.width-1 && r < detailGrid.height-1) {
    const left = Math.floor(c), top = Math.floor(r);
    const sample = (col,row) => {
      const i = 2 * (row * detailGrid.width + col);
      const raw = (detailBytes.charCodeAt(i) | detailBytes.charCodeAt(i+1)<<8)<<16>>16;
      return Math.max(0,raw*.1);
    };
    const dx=c-left, dz=r-top;
    return (sample(left,top)*(1-dx)+sample(left+1,top)*dx)*(1-dz)
      + (sample(left,top+1)*(1-dx)+sample(left+1,top+1)*dx)*dz;
  }
  const column = (x / 103 + 46.7) / .3;
  const row = (106.85 - z / 111) / .3;
  if (column < 0 || column > 400 || row < 0 || row > 490) return null;
  const left = Math.min(399, Math.floor(column));
  const top = Math.min(489, Math.floor(row));
  const east = column - left;
  const south = row - top;
  const upper = terrainSample(left, top) * (1 - east) + terrainSample(left + 1, top) * east;
  const lower = terrainSample(left, top + 1) * (1 - east) + terrainSample(left + 1, top + 1) * east;
  return upper * (1 - south) + lower * south;
}

function elevation(x, z) {
  if (tiles) {
    const streamed = tiles.terrainElevation(x, z);
    if (streamed != null) return streamed;
  }
  const baked = bakedElevation(x, z);
  return baked == null ? 0 : baked;
}

function selectedPlace() {
  const id = byId('place')?.value || 'cheung-chau';
  return HK.places.find(place => place.id === id) || HK.places[0];
}

const MIN_AGL = (typeof HK !== 'undefined' && HK.MIN_AGL) || 200;

function surfaceHeight(x, z) {
  return Math.max(0, elevation(x, z));
}

function terrainFloor(x, z) {
  return surfaceHeight(x, z) + MIN_AGL;
}

function altitudeAgl(x, y, z) {
  return y - surfaceHeight(x, z);
}

function placeCraft(place, explore) {
  const pos = HK.toXZ(place.lat, place.lon);
  // All starts, teleports and restarts stay at least 200 m AGL, never below sea.
  Object.assign(craft, {
    x: pos.x,
    y: terrainFloor(pos.x, pos.z),
    z: pos.z,
    vx: 0, vy: 0, vz: 0,
    yaw: place.yaw ?? 0
  });
}

function startFlight(explore = false) {
  const place = selectedPlace();
  const free = explore || !place.mission;
  // Already at 200 m AGL, so skip the old 15 m takeoff gate.
  Object.assign(run, { mode: 'flying', next: free ? 0 : 1, time: 0, camera: false, explore: free });
  placeCraft(place, free);
  keys.clear();
  pointers.clear();
  byId('overlay').hidden = true;
  byId('camera').disabled = false;
  start.blur();
  if (byId('mission-note')) {
    byId('mission-note').hidden = !free;
  }
}

function finish(success) {
  run.mode = 'ended';
  byId('overlay').hidden = false;
  byId('camera').disabled = true;
  byId('title').textContent = success ? '巡航完成' : '巡航中斷';
  byId('briefing').textContent = success
    ? '已完成三個巡查點並安全降落。飛行時間 ' + Math.ceil(run.time) + ' 秒。'
    : '電量耗盡。你可以由長洲碼頭再試一次。';
  start.textContent = '再飛一次';
  start.focus();
}

function update(dt) {
  if (run.mode !== 'flying') return;
  run.time += dt;
  if (!run.explore && run.time >= 240) return finish(false);
  const axis = (positive, negative) => Number(active(positive)) - Number(active(negative));
  craft.yaw += axis('KeyE', 'KeyQ') * dt * 1.7;
  const forward = axis('KeyW', 'KeyS');
  const side = axis('KeyD', 'KeyA');
  const vertical = Number(active('Space')) - Number(active('ShiftLeft') || active('ShiftRight'));
  const speed = 51 / Math.max(1, Math.hypot(forward, side));
  const sine = Math.sin(craft.yaw), cosine = Math.cos(craft.yaw);
  const ease = 1 - Math.exp(-4 * dt);
  craft.vx += ((forward * sine + side * cosine) * speed - craft.vx) * ease;
  craft.vz += ((forward * cosine - side * sine) * speed - craft.vz) * ease;
  craft.vy += (vertical * 23 - craft.vy) * ease;
  craft.x = clamp(craft.x + craft.vx * dt, HK.bounds.minX, HK.bounds.maxX);
  craft.z = clamp(craft.z + craft.vz * dt, HK.bounds.minZ, HK.bounds.maxZ);
  const floor = terrainFloor(craft.x, craft.z);
  const altitude = craft.y + craft.vy * dt;
  craft.y = clamp(altitude, floor, HK.MAX_ALTITUDE);
  if (altitude !== craft.y) craft.vy = 0;

  if (!run.explore) {
    if (run.next === 0) run.next = 1;
    const target = route[run.next];
    if (run.next >= 1 && run.next <= 3 && Math.hypot(craft.x - target.x, craft.z - target.z) <= 70) run.next++;
    if (run.next === 4 && Math.hypot(craft.x, craft.z) <= 40 &&
        altitudeAgl(craft.x, craft.y, craft.z) <= MIN_AGL + 15 &&
        Math.hypot(craft.vx, craft.vz) < 4) finish(true);
  }
}

function toggleCamera() {
  if (run.mode === 'flying') run.camera = !run.camera;
}

start.addEventListener('click', () => startFlight(false));
byId('explore')?.addEventListener('click', () => startFlight(true));
byId('place')?.addEventListener('change', () => {
  const place = selectedPlace();
  if (run.mode === 'flying') {
    startFlight(true);
  } else if (byId('start-hint')) {
    byId('start-hint').textContent = place.mission
      ? '由長洲碼頭起飛可進行原本的離島巡航任務。選其他地點則進入自由飛行，沒有全港任務。'
      : '將從「' + place.name + '」進入自由飛行。長洲巡航任務只在長洲碼頭出發。';
  }
});
byId('camera').addEventListener('click', event => {
  toggleCamera();
  if (event.detail > 0) event.currentTarget.blur();
});
const flightKeys = new Set([...buttons.map(button => button.dataset.key), 'ShiftRight']);
window.addEventListener('keydown', event => {
  if (event.code === 'KeyR' && run.mode !== 'ready' && !event.repeat && !start.disabled) startFlight(run.explore);
  if (run.mode !== 'flying') return;
  if (event.code === 'KeyC' && !event.repeat) toggleCamera();
  if (!flightKeys.has(event.code) || (event.code === 'Space' && event.target.closest('button,a'))) return;
  event.preventDefault();
  keys.add(event.code);
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  pointers.clear();
});
for (const button of buttons) {
  button.addEventListener('pointerdown', event => {
    if (run.mode !== 'flying') return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, button.dataset.key);
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(eventName, event => pointers.delete(event.pointerId));
  }
}

function shader(type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw Error(kind + ' shader compile failed: ' + (gl.getShaderInfoLog(result) || 'unknown'));
  }
  return result;
}

function loadAtlas(unit, url) {
  const texture = gl.createTexture();
  function upload(source) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }
  upload(new ImageData(1, 1));
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        upload(image);
        if (gl.getError() !== gl.NO_ERROR) throw Error('Imagery texture upload failed');
        chartImages[unit] = image;
        paintChart();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(Error('Imagery image could not be decoded'));
    image.src = url;
  });
}


function decodeBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function encodeAssetUrl(url) {
  if (!url || String(url).slice(0, 5) === 'data:') return url;
  try { return encodeURI(url); } catch (error) { return url; }
}

function loadTexture(gl, url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([180, 180, 180, 255]));
  const ready = new Promise(resolve => {
    const finish = (ok, error) => {
      if (error) {
        console.error(error);
        if (!window.__droneTextureError) {
          window.__droneTextureError = reportInitError('drone-texture', error);
        }
      }
      resolve(!!ok);
    };
    if (!url) return finish(false, Error('Missing drone texture url'));
    const image = new Image();
    image.onload = () => {
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        const code = gl.getError();
        if (code !== gl.NO_ERROR) throw Error('Texture upload failed (' + code + '): ' + url);
        try {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } catch (mipError) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        finish(true);
      } catch (error) {
        // Typical on file:// when the image is treated as cross-origin / tainted.
        finish(false, error);
      }
    };
    image.onerror = () => finish(false, Error('Texture failed to load: ' + url));
    try {
      image.src = encodeAssetUrl(url);
    } catch (error) {
      finish(false, error);
    }
  });
  return { texture, ready };
}

function createDroneRenderer(gl) {
  const model = window.DRONE_MODEL;
  if (!model) throw Error('Drone model data missing');
  const vary = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision
    ? 'highp' : 'mediump';
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 tangent;
    attribute vec2 uv;
    uniform vec3 eye, rightAxis, upAxis, forwardAxis, modelPos;
    uniform vec2 lens, modelYaw;
    varying ${vary} vec3 vWorld, vNormal, vTangent;
    varying ${vary} vec2 vUv;
    varying ${vary} float depth, bitangentSign;
    void main() {
      vec3 local = vec3(
        position.x * modelYaw.x + position.z * modelYaw.y,
        position.y,
        position.z * modelYaw.x - position.x * modelYaw.y
      );
      vec3 world = modelPos + local;
      vec3 delta = world - eye;
      depth = dot(delta, forwardAxis);
      gl_Position = vec4(dot(delta,rightAxis)*lens.x, dot(delta,upAxis)*lens.y,
                         depth*1.00005-0.4, depth);
      vWorld = world;
      vNormal = vec3(
        normal.x * modelYaw.x + normal.z * modelYaw.y,
        normal.y,
        normal.z * modelYaw.x - normal.x * modelYaw.y
      );
      vTangent = vec3(
        tangent.x * modelYaw.x + tangent.z * modelYaw.y,
        tangent.y,
        tangent.z * modelYaw.x - tangent.x * modelYaw.y
      );
      bitangentSign = tangent.w;
      vUv = uv;
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying ${vary} vec3 vWorld, vNormal, vTangent;
    varying ${vary} vec2 vUv;
    varying ${vary} float depth, bitangentSign;
    uniform sampler2D diffuseMap, specGlossMap, normalMap;
    uniform vec3 eye, diffuseFactor, specularFactor;
    uniform float glossinessFactor;
    void main() {
      vec3 Nref = normalize(vNormal);
      vec3 T = normalize(vTangent);
      vec3 B = normalize(cross(Nref, T)) * bitangentSign;
      vec3 Nmap = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
      vec3 N = normalize(mat3(T, B, Nref) * Nmap);
      vec3 L = normalize(vec3(0.35, 0.85, 0.4));
      vec3 V = normalize(eye - vWorld);
      vec3 H = normalize(L + V);
      vec3 albedo = texture2D(diffuseMap, vUv).rgb * diffuseFactor;
      vec3 spec = texture2D(specGlossMap, vUv).rgb * specularFactor;
      float ndotl = max(dot(N, L), 0.0);
      vec3 colour = albedo * (0.28 + 0.72 * ndotl);
      float gloss = glossinessFactor;
      if (gloss > 0.001) {
        colour += spec * pow(max(dot(N, H), 0.0), exp2(10.0 * gloss + 1.0));
      } else {
        colour += spec * ndotl * 0.15;
      }
      float haze = min(0.55, 1.0-exp(-max(0.0,depth)*0.00008));
      gl_FragColor = vec4(mix(colour, vec3(0.69,0.84,0.81), haze), 1.0);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));

  const positions = new Float32Array(decodeBuffer(model.positions));
  const normals = new Float32Array(decodeBuffer(model.normals));
  const uvs = new Float32Array(decodeBuffer(model.uvs));
  const tangents = new Float32Array(decodeBuffer(model.tangents));
  const indices = new Uint16Array(decodeBuffer(model.indices));
  if (positions.length !== model.vertexCount * 3 || indices.length !== model.indexCount) {
    throw Error('Drone model buffer size mismatch');
  }
  const packed = new Float32Array(indices.length * 12);
  let w = 0;
  for (const i of indices) {
    packed[w++] = positions[i * 3];
    packed[w++] = positions[i * 3 + 1];
    packed[w++] = positions[i * 3 + 2];
    packed[w++] = normals[i * 3];
    packed[w++] = normals[i * 3 + 1];
    packed[w++] = normals[i * 3 + 2];
    packed[w++] = tangents[i * 4];
    packed[w++] = tangents[i * 4 + 1];
    packed[w++] = tangents[i * 4 + 2];
    packed[w++] = tangents[i * 4 + 3];
    packed[w++] = uvs[i * 2];
    packed[w++] = uvs[i * 2 + 1];
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);
  const uniforms = Object.fromEntries(
    ['eye','rightAxis','upAxis','forwardAxis','lens','modelPos','modelYaw',
     'diffuseMap','specGlossMap','normalMap','diffuseFactor','specularFactor','glossinessFactor']
      .map(name => [name, gl.getUniformLocation(program, name)])
  );
  const attribs = {
    position: gl.getAttribLocation(program, 'position'),
    normal: gl.getAttribLocation(program, 'normal'),
    tangent: gl.getAttribLocation(program, 'tangent'),
    uv: gl.getAttribLocation(program, 'uv')
  };
  const textures = model.material.textures;
  const maps = [
    loadTexture(gl, textures.diffuse),
    loadTexture(gl, textures.specularGlossiness),
    loadTexture(gl, textures.normal)
  ];
  const ready = Promise.all(maps.map(item => item.ready));
  const stride = 48;
  return {
    ready,
    draw(camera) {
      if (run.camera) return;
      gl.useProgram(program);
      gl.disable(gl.CULL_FACE);
      gl.uniform3fv(uniforms.eye, camera.eye);
      gl.uniform3fv(uniforms.rightAxis, camera.right);
      gl.uniform3fv(uniforms.upAxis, camera.up);
      gl.uniform3fv(uniforms.forwardAxis, camera.forward);
      gl.uniform2f(uniforms.lens, camera.fx, camera.fy);
      gl.uniform3f(uniforms.modelPos, craft.x, craft.y, craft.z);
      gl.uniform2f(uniforms.modelYaw, Math.cos(craft.yaw), Math.sin(craft.yaw));
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, maps[0].texture);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, maps[1].texture);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, maps[2].texture);
      gl.uniform1i(uniforms.diffuseMap, 2);
      gl.uniform1i(uniforms.specGlossMap, 3);
      gl.uniform1i(uniforms.normalMap, 4);
      gl.uniform3fv(uniforms.diffuseFactor, new Float32Array(model.material.diffuseFactor.slice(0, 3)));
      gl.uniform3fv(uniforms.specularFactor, new Float32Array(model.material.specularFactor));
      gl.uniform1f(uniforms.glossinessFactor, model.material.glossinessFactor);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(attribs.position);
      gl.enableVertexAttribArray(attribs.normal);
      gl.enableVertexAttribArray(attribs.tangent);
      gl.enableVertexAttribArray(attribs.uv);
      gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, stride, 12);
      gl.vertexAttribPointer(attribs.tangent, 4, gl.FLOAT, false, stride, 24);
      gl.vertexAttribPointer(attribs.uv, 2, gl.FLOAT, false, stride, 40);
      gl.drawArrays(gl.TRIANGLES, 0, indices.length);
      gl.disableVertexAttribArray(attribs.normal);
      gl.disableVertexAttribArray(attribs.tangent);
      gl.disableVertexAttribArray(attribs.uv);
    }
  };
}

function initializeRenderer() {
  if (!gl) throw Error('WebGL unavailable');
  if (typeof HK === 'undefined') throw Error('hk-map.js did not load (HK missing)');
  if (!window.DRONE_MODEL) throw Error('drone-model.js did not load (DRONE_MODEL missing)');
  const program = gl.createProgram();
  const varyingPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision
    ? 'highp' : 'mediump';
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute vec3 position;
    attribute vec3 colour;
    uniform vec3 eye, rightAxis, upAxis, forwardAxis;
    uniform vec2 lens;
    varying ${varyingPrecision} vec3 shade, world;
    varying ${varyingPrecision} float depth;
    void main() {
      vec3 delta = position - eye;
      depth = dot(delta, forwardAxis);
      gl_Position = vec4(dot(delta,rightAxis)*lens.x, dot(delta,upAxis)*lens.y,
                         depth*1.00005-0.4, depth);
      shade = colour;
      world = position;
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying ${varyingPrecision} vec3 shade, world;
    varying ${varyingPrecision} float depth;
    uniform sampler2D overviewPhoto, detailPhoto;
    uniform float overviewReady, detailReady, photoSurface;
    void main() {
      vec3 colour = shade;
      if (photoSurface > 0.5) {
        vec2 tile = vec2(
          dot(world.xz, vec2(0.00706204649, -0.000006988322)) + 0.827321833,
          dot(world.xz, vec2(0.000006799489, 0.00710306546)) + 0.046492600);
        vec2 overviewUV = (vec2(tile.x, -tile.y) + vec2(23.0, 80.0)) / vec2(64.0, 96.0);
        vec2 detailUV = (vec2(tile.x, -tile.y) + vec2(14.0, 19.0)) / vec2(26.0, 30.0);
        vec2 overviewEdge = min(overviewUV, 1.0 - overviewUV);
        vec2 detailEdge = min(detailUV, 1.0 - detailUV);
        float overviewWeight = overviewReady * smoothstep(0.0, 0.012, min(overviewEdge.x, overviewEdge.y));
        float detailWeight = detailReady * smoothstep(0.0, 0.015, min(detailEdge.x, detailEdge.y));
        colour = mix(colour, texture2D(overviewPhoto, overviewUV).rgb, overviewWeight);
        colour = mix(colour, texture2D(detailPhoto, detailUV).rgb, detailWeight);
      }
      float haze = 1.0-exp(-max(0.0,depth)*0.00023);
      gl_FragColor = vec4(mix(colour,vec3(0.69,0.84,0.81),haze),1.0);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  const uniforms = Object.fromEntries(['eye','rightAxis','upAxis','forwardAxis','lens',
    'overviewPhoto','detailPhoto','overviewReady','detailReady','photoSurface']
    .map(name => [name, gl.getUniformLocation(program, name)]));
  const position = gl.getAttribLocation(program, 'position');
  const colour = gl.getAttribLocation(program, 'colour');
  gl.enableVertexAttribArray(position);
  gl.enableVertexAttribArray(colour);
  const landscape = gl.createBuffer();
  const objects = gl.createBuffer();
  let landCount = 0;
  let bakedReady = false;
  function ensureBakedLandscape() {
    if (bakedReady) return;
    const land = createLandscape();
    landCount = land.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, landscape);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(land), gl.STATIC_DRAW);
    bakedReady = true;
    bakedLand = true;
  }
  gl.useProgram(program);
  gl.uniform1i(uniforms.overviewPhoto, 0);
  gl.uniform1i(uniforms.detailPhoto, 1);
  tiles = HK.createTileManager(gl, bakedElevation);
  tiles.requestAround(craft.x, craft.z);
  try {
    droneRenderer = createDroneRenderer(gl);
  } catch (error) {
    console.error(error);
    droneRenderer = null;
    window.__droneInitError = reportInitError('drone-model', error);
  }
  if (tiles.status.mode === 'offline') ensureBakedLandscape();
  if (window.__droneInitError) {
    appendBriefing(' 無人機模型未能載入：' + window.__droneInitError + '。你仍可開始飛行。');
  }
  // r5 bug: Start waited on drone textures / atlas. If texImage2D threw
  // (common on file://) the promise never settled and the button stayed on
  // 「載入地圖...」 forever, even after the 3D view was already drawing.
  enableFlightStart();
  const atlasLoads = (typeof landsImagery !== 'undefined' && landsImagery ? landsImagery : []).map((url, unit) => loadAtlas(unit, url).then(() => {
    gl.useProgram(program);
    gl.uniform1f(unit === 0 ? uniforms.overviewReady : uniforms.detailReady, 1);
  }));
  const droneReady = droneRenderer ? droneRenderer.ready : Promise.resolve([]);
  allSettled([droneReady, allSettled(atlasLoads)]).then(([droneResult, atlasWrap]) => {
    const results = atlasWrap.status === 'fulfilled' ? atlasWrap.value : [];
    const atlasFailed = !results.length || results.some(item => item.status === 'rejected');
    const atlasOk = results.some(item => item.status === 'fulfilled');
    if (atlasFailed) {
      appendBriefing(atlasOk
        ? ' 長洲離線航拍圖未能全部載入。'
        : ' 長洲離線航拍圖載入失敗，已使用備用地形。');
      ensureBakedLandscape();
    }
    if (droneRenderer && droneResult.status === 'fulfilled') {
      const flags = droneResult.value;
      const ok = Array.isArray(flags) ? flags.every(Boolean) : !!flags;
      if (!ok) {
        const fileHint = (typeof location !== 'undefined' && location.protocol === 'file:')
          ? '（目前是 file://，瀏覽器可能禁止把本地貼圖傳到 WebGL。請改用「啟動遊戲.bat」開啟 http://127.0.0.1:8770/。）'
          : '';
        appendBriefing(' 無人機貼圖未能載入' + fileHint + '機身會以素色顯示。');
      }
    } else if (droneResult.status === 'rejected') {
      reportInitError('drone-texture', droneResult.reason);
      appendBriefing(' 無人機貼圖載入錯誤：' + (droneResult.reason && (droneResult.reason.message || droneResult.reason)) + '。你仍可開始飛行。');
    }
  }).catch(error => {
    reportInitError('post-init', error);
    appendBriefing(' 背景資源載入發生錯誤：' + (error && (error.message || error)) + '。你仍可開始飛行。');
    enableFlightStart();
  });
  setTimeout(() => {
    if (tiles.status.mode !== 'online') {
      if (tiles.status.mode === 'loading') {
        tiles.status.mode = 'offline';
        tiles.status.message = '全港圖磚未及時回應，已改用長洲離線地圖';
      }
      ensureBakedLandscape();
    }
  }, 4000);

  function draw(buffer, count) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(colour, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, count / 6);
  }

  let tileClock = 0;
  return (camera, seconds) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(.66,.83,.87,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (seconds - tileClock > 0.4) {
      tiles.requestAround(craft.x, craft.z);
      tileClock = seconds;
      const statusNode = byId('map-status');
      if (statusNode) statusNode.textContent = tiles.status.message;
    }
    const offline = tiles.status.mode === 'offline';
    if (offline) ensureBakedLandscape();
    if (!offline) tiles.draw(camera);
    gl.useProgram(program);
    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(colour);
    gl.uniform3fv(uniforms.eye, camera.eye);
    gl.uniform3fv(uniforms.rightAxis, camera.right);
    gl.uniform3fv(uniforms.upAxis, camera.up);
    gl.uniform3fv(uniforms.forwardAxis, camera.forward);
    gl.uniform2f(uniforms.lens, camera.fx, camera.fy);
    if (bakedReady && (offline || tiles.status.mode === 'loading')) {
      gl.uniform1f(uniforms.photoSurface, 1);
      draw(landscape, landCount);
    }
    gl.uniform1f(uniforms.photoSurface, 0);
    const geometry = createObjects(seconds);
    gl.bindBuffer(gl.ARRAY_BUFFER, objects);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry), gl.DYNAMIC_DRAW);
    draw(objects, geometry.length);
    if (droneRenderer) droneRenderer.draw(camera);
  };
}

function triangle(out, a, b, c, colour) {
  out.push(...a, ...colour, ...b, ...colour, ...c, ...colour);
}

function quad(out, a, b, c, d, colour) {
  triangle(out, a, b, c, colour);
  triangle(out, a, c, d, colour);
}

function box(out, x, y, z, w, h, d, colour, transform = point => point) {
  const corners = [
    [-w,-h,-d],[w,-h,-d],[w,-h,d],[-w,-h,d],
    [-w,h,-d],[w,h,-d],[w,h,d],[-w,h,d]
  ].map(([dx,dy,dz]) => transform([x+dx/2,y+dy/2,z+dz/2]));
  const faces = [[0,1,2,3,.54],[4,5,6,7,1],[0,1,5,4,.77],
    [1,2,6,5,.67],[2,3,7,6,.82],[3,0,4,7,.71]];
  for (const [a,b,c,d,light] of faces) {
    quad(out,corners[a],corners[b],corners[c],corners[d],colour.map(value => value*light));
  }
}

function createLandscape() {
  const geometry = [];
  quad(geometry,[-7100,-.25,-7100],[7100,-.25,-7100],[7100,-.25,7100],[-7100,-.25,7100],[.061,.34,.38]);
  function landFace(a,b,c) {
    const average = (a[1]+b[1]+c[1])/3;
    const slope = clamp(.53 + ((a[1]-b[1])*.7 + a[1]-c[1])*.022,.29,.72);
    const grain = Math.sin(a[0]*.17+a[2]*.09)*.028;
    const colour = average < 4 ? [.62,.57,.39] : [slope*.53+grain,slope*.84+grain,slope*.48];
    triangle(geometry,a,b,c,colour);
  }
  // Build from the original elevation grid so narrow coves and ridges keep their samples.
  function gridRow(row) {
    const z = (106.85 - row * .3) * 111;
    return Array.from({ length: 801 }, (_, column) => {
      const x = (column * .15 - 46.7) * 103;
      return [x,elevation(x,z),z];
    });
  }
  let north = gridRow(0);
  for (let row = .5; row <= 490; row += .5) {
    const south = gridRow(row);
    for (let column = 0; column < 800; column++) {
      const nw = north[column], ne = north[column + 1];
      const sw = south[column], se = south[column + 1];
      if (nw[1] || ne[1] || sw[1]) landFace(nw, ne, sw);
      if (ne[1] || se[1] || sw[1]) landFace(ne, se, sw);
    }
    north = south;
  }
  return geometry;
}

function createObjects(seconds) {
  const out = [];
  box(out,0,1,0,62,2,64,[.48,.54,.49]);
  for (const x of [-27,27]) box(out,x,2.08,0,1,.15,55,[.77,.78,.63]);
  const target = route[run.next];
  const returning = run.next === 0 || run.next === 4;
  const angleToDrone = bearing(target,craft);
  const radius = returning ? 24 : 52;
  const centreY = Math.max(target.y, terrainFloor(target.x, target.z));
  const stripe = returning ? 2 : 3.5;
  if (run.mode === 'flying') {
    function ringPoint(angle, r) {
      const lateral = Math.cos(angle)*r;
      return returning ? [target.x+lateral,centreY,target.z+Math.sin(angle)*r] :
        [target.x+lateral*Math.cos(angleToDrone),centreY+Math.sin(angle)*r,
         target.z-lateral*Math.sin(angleToDrone)];
    }
    for (let i=0;i<48;i++) {
      const a = i*Math.PI/24, b = (i+.86)*Math.PI/24;
      quad(out,ringPoint(a,radius-stripe),ringPoint(a,radius),
        ringPoint(b,radius),ringPoint(b,radius-stripe),returning?[.33,.96,.55]:[1,.65,.18]);
    }
  }
  return out;
}

const chart = document.createElement('canvas');
chart.width = 180;
chart.height = 160;
const chartContext = chart.getContext('2d');
const chartImages = [];
const chartPoint = (x,z) => [90+x/28,80-z/28];
function paintChart() {
  chartContext.fillStyle = '#204d5d';
  chartContext.fillRect(0,0,180,160);
  chartImages.forEach((image,unit) => {
    // Map chart pixels to the same north-up aerial tile coordinates as the terrain shader.
    const scale = unit ? 128 : 16;
    const tileX = unit ? 14 : 23, tileY = unit ? 19 : 80;
    const x0 = -90*28, z0 = 80*28;
    const transform = new DOMMatrix([
      scale*.00706204649*28,-scale*.000006799489*28,
      scale*.000006988322*28,scale*.00710306546*28,
      scale*(tileX+.827321833+x0*.00706204649-z0*.000006988322),
      scale*(tileY-.046492600-x0*.000006799489-z0*.00710306546)
    ]);
    chartContext.save();
    chartContext.setTransform(transform.inverse());
    chartContext.drawImage(image,0,0);
    chartContext.restore();
  });
}

function drawMap() {
  let worldToPix;
  if (tiles && tiles.status.mode === 'online') {
    worldToPix = tiles.paintMinimap(map, craft);
  } else {
    map.drawImage(chart,0,0);
    worldToPix = (x,z) => chartPoint(x,z);
  }
  const plot = (x,z) => {
    const p = worldToPix(x,z);
    return [clamp(p[0], 4, 176), clamp(p[1], 4, 156)];
  };
  if (!run.explore) {
    map.strokeStyle = '#e9bb6b';
    map.setLineDash([3,3]);
    map.beginPath();
    route.forEach((point,index) => map[index ? 'lineTo' : 'moveTo'](...plot(point.x,point.z)));
    map.stroke();
    map.setLineDash([]);
    route.slice(0,4).forEach((point,index) => {
      map.fillStyle = index===run.next || (index===0 && run.next===4) ? '#ffca6c' : '#b3e9c6';
      map.beginPath();
      map.arc(...plot(point.x,point.z),3,0,Math.PI*2);
      map.fill();
    });
  } else {
    map.fillStyle = '#ffe7a8';
    HK.places.forEach(place => {
      const pos = HK.toXZ(place.lat, place.lon);
      const [x,z] = worldToPix(pos.x, pos.z);
      if (x < 2 || x > 178 || z < 2 || z > 158) return;
      map.beginPath();
      map.arc(x, z, 2, 0, Math.PI*2);
      map.fill();
    });
  }
  const [x,z] = plot(craft.x,craft.z);
  map.save();
  map.translate(x,z);
  map.rotate(craft.yaw);
  map.fillStyle = '#fff';
  map.beginPath();
  map.moveTo(0,-7); map.lineTo(5,5); map.lineTo(0,3); map.lineTo(-5,5);
  map.closePath(); map.fill();
  map.restore();
}

function cameraView() {
  const yaw = run.mode === 'ready' ? -.72 : craft.yaw;
  const sine = Math.sin(yaw), cosine = Math.cos(yaw);
  const pitch = run.mode === 'ready' ? -.27 : run.camera ? -.13 : -.27;
  const horizontal = Math.cos(pitch), vertical = Math.sin(pitch);
  const ready = run.mode === 'ready';
  const setback = ready ? 460 : run.camera ? -1.7 : 13;
  const lift = ready ? 190 : run.camera ? .15 : 5;
  const fy = 1.52;
  return {
    eye: [craft.x-sine*setback,craft.y+lift,craft.z-cosine*setback],
    right: [cosine,0,-sine],
    up: [-sine*vertical,horizontal,-cosine*vertical],
    forward: [sine*horizontal,vertical,cosine*horizontal],
    fx: Math.min(fy*canvas.height/canvas.width,2.3), fy
  };
}

let hudTime = -Infinity;
function drawHud(camera, seconds) {
  const target = route[run.next];
  const marker = byId('marker');
  const flying = run.mode === 'flying';
  marker.hidden = !flying || run.explore || run.next===0;
  byId('reticle').hidden = !flying || !run.camera;
  if (!marker.hidden) {
    const relative = [target.x-camera.eye[0],target.y-camera.eye[1],target.z-camera.eye[2]];
    const depth = dot(relative,camera.forward);
    const side = dot(relative,camera.right);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const x = depth>1 ? width*(.5+.5*camera.fx*side/depth) : side<0 ? 0 : width;
    const y = depth>1 ? height*(.5-.5*camera.fy*dot(relative,camera.up)/depth) : height*.5;
    marker.style.left = clamp(x,72,width-72)+'px';
    marker.style.top = clamp(y,Math.min(195,height*.45),height*.69)+'px';
    const hint = depth<=1 || x<72 ? (side<0?'‹ ':'› ') : x>width-72 ? '› ' : '';
    marker.textContent = hint + target.name + ' · ' + Math.round(distance(craft,target)) + ' m';
  }
  if (seconds - hudTime < .12) return;
  hudTime = seconds;
  if (run.explore) {
    const nearest = HK.places.slice().sort((a,b) => {
      const pa = HK.toXZ(a.lat,a.lon), pb = HK.toXZ(b.lat,b.lon);
      return Math.hypot(craft.x-pa.x,craft.z-pa.z) - Math.hypot(craft.x-pb.x,craft.z-pb.z);
    })[0];
    byId('target').textContent = '自由飛行';
    byId('guide').textContent = '鄰近：' + nearest.name + ' · 長洲任務僅在碼頭出發';
  } else {
    byId('target').textContent = target.name;
    byId('guide').textContent = run.next===4 ?
      '飛入綠圈，降至最低離地高度（200 米）並停定' :
      '飛向黃圈 · 目標海拔 ' + target.y + ' 米';
  }
  byId('height').textContent = Math.round(craft.y);
  if (byId('agl')) byId('agl').textContent = Math.max(0, Math.round(altitudeAgl(craft.x, craft.y, craft.z)));
  byId('speed').textContent = Math.round(Math.hypot(craft.vx,craft.vz)*3.6);
  byId('heading').textContent = String((Math.round(craft.yaw*180/Math.PI)%360+360)%360).padStart(3,'0');
  byId('battery').textContent = run.explore ? '—' : Math.max(0,100-Math.floor(run.time/2.4));
  items.forEach((li,index) => {
    li.classList.toggle('current',index===run.next);
    li.classList.toggle('done',index<run.next);
  });
  drawMap();
}

try {
  if (byId('build-id') && window.GAME_DEBUG) byId('build-id').textContent = '版本 ' + GAME_BUILD + ' · 正在初始化';
  populatePlaces();
  const render = initializeRenderer();
  let previous = performance.now();
  function frame(now) {
    try {
      const scale = Math.min(devicePixelRatio || 1,1.6);
      const width = Math.max(1,Math.round(canvas.clientWidth*scale));
      const height = Math.max(1,Math.round(canvas.clientHeight*scale));
      if (canvas.width!==width || canvas.height!==height) {
        canvas.width=width; canvas.height=height;
      }
      update(clamp((now-previous)/1000,0,.05));
      previous = now;
      const camera = cameraView();
      render(camera,now/1000);
      drawHud(camera,now/1000);
    } catch (error) {
      if (!window.__frameError) {
        window.__frameError = reportInitError('frame', error);
        appendBriefing(' 畫面更新發生錯誤（' + GAME_BUILD + '／frame）。原因：' + window.__frameError + '。若開始按鈕已解鎖，仍可嘗試飛行。');
        enableFlightStart();
      }
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener('visibilitychange', () => { previous = performance.now(); });
  requestAnimationFrame(frame);
} catch (error) {
  console.error(error);
  const stage = !gl ? 'webgl-context' : (typeof HK === 'undefined' ? 'hk-map-script' : (!window.DRONE_MODEL ? 'drone-model-script' : 'initializeRenderer'));
  showInitFailure(stage, error);
}

