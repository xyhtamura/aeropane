// Aeropane — Physical Glass & Gel Simulator
// WebGL-Based Real-time & Progressive Refraction/Absorption Pipeline

// ─── Deterministic Noise Core (Value Noise) ──────────────────────────────
class ValueNoise2D {
    constructor() {
        this.grid = new Float32Array(256 * 256);
        // Simple seeded LCG for deterministic preset noise
        let seed = 42;
        function lcg() {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        }
        for (let i = 0; i < this.grid.length; i++) {
            this.grid[i] = lcg();
        }
    }
    noise(x, y) {
        let X = Math.floor(x) & 255;
        let Y = Math.floor(y) & 255;
        let xf = x - Math.floor(x);
        let yf = y - Math.floor(y);
        
        let u = xf * xf * (3.0 - 2.0 * xf);
        let v = yf * yf * (3.0 - 2.0 * yf);
        
        let n00 = this.grid[Y * 256 + X];
        let n10 = this.grid[Y * 256 + ((X + 1) & 255)];
        let n01 = this.grid[((Y + 1) & 255) * 256 + X];
        let n11 = this.grid[((Y + 1) & 255) * 256 + ((X + 1) & 255)];
        
        let x1 = n00 + u * (n10 - n00);
        let x2 = n01 + u * (n11 - n01);
        return x1 + v * (x2 - x1);
    }
    fbm(x, y, octaves = 3) {
        let val = 0;
        let amp = 1.0;
        let freq = 1.0;
        let maxVal = 0;
        for (let i = 0; i < octaves; i++) {
            val += this.noise(x * freq, y * freq) * amp;
            maxVal += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        return val / maxVal;
    }
}

const vNoise = new ValueNoise2D();

// ─── State Management ────────────────────────────────────────────────────────
let originalImage = null;
let activeView = 'aeropane'; // 'aeropane' | 'original' | 'heightmap'
let renderParams = {};
let isCooking = false;
let cookProgress = 0;
let cookSliceIndex = 0;
const totalSlices = 40;
let animationFrameId = null;
let isCustomMapLoaded = false; // Flag for dropped custom heightmaps
let customMapImage = null;
let customMapFilename = '';
let customMapDirty = true;
let lastProceduralPreset = 'satinato';

// WebGL Context
let gl = null;
let glCanvas = null;
let shaderProgram = null;
let originalTexture = null;
let heightmapTexture = null;
let positionBuffer = null;

// ─── Liquid Glass (live wave-equation PDE) state ──────────────────────────
let liquidMode = false;
let liquidLoopId = null;
let simProgram = null;
let simFbo = null;                 // single framebuffer, retargeted each step
let stateTextures = [null, null];  // ping-pong: R=height, G=velocity
let stateRead = 0;                 // index of the texture holding current state
let simW = 0, simH = 0;
let liquidSupported = null;        // null=unknown, true/false after probe
let floatTexType = null;           // gl.FLOAT or HALF_FLOAT_OES once resolved
let activeHeightTex = null;        // when set, refraction pass samples this instead of the canvas map
let heightAmpOverride = null;      // when set, overrides u_noiseAmp (liquid distortion gain)
let queuedImpulse = null;          // {u, v, str} consumed by the next sim step
let pointerDown = false;
let rainCountdown = 0;

// DOM Elements
const imageInput = document.getElementById('imageInput');
const heightmapInput = document.getElementById('heightmapInput');
const dropZone = document.getElementById('dropZone');
const displayCanvas = document.getElementById('displayCanvas');
const hiddenOriginalCanvas = document.getElementById('hiddenOriginalCanvas');
const hiddenHeightCanvas = document.getElementById('hiddenHeightCanvas');
const presetSelect = document.getElementById('presetSelect');
const tintColorInput = document.getElementById('tintColor');
const cookBtn = document.getElementById('cookBtn');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const progressFill = document.getElementById('progressFill');
const percentLabel = document.getElementById('percentLabel');
const renderStateText = document.getElementById('renderState');
const pixelInfo = document.getElementById('pixelInfo');
const viewTabs = document.querySelectorAll('.view-tab');
const imageMapOption = document.getElementById('imageMapOption');
const mapSourceCard = document.getElementById('mapSourceCard');
const mapSourceName = document.getElementById('mapSourceName');
const importedMapControls = document.getElementById('importedMapControls');
const proceduralMapControls = document.getElementById('proceduralMapControls');
const loadHeightmapBtn = document.getElementById('loadHeightmapBtn');
const resetHeightmapBtn = document.getElementById('resetHeightmapBtn');

// ─── WebGL Shaders ──────────────────────────────────────────────────────────
const vertexShaderSource = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
        v_uv = (a_pos + 1.0) * 0.5;
        // Flip Y for texture space mapping
        gl_Position = vec4(a_pos, 0.0, 1.0);
    }
`;

const fragmentShaderSource = `
    precision highp float;
    varying vec2 v_uv;
    
    uniform sampler2D u_image;
    uniform sampler2D u_heightmap;
    uniform vec2 u_resolution;
    
    uniform float u_distance;      // d
    uniform float u_roughness;     // alpha
    uniform float u_ior;           // n
    uniform float u_noiseAmp;      // scaling for slope normals
    uniform vec3 u_tintColor;      // Beer-Lambert tint
    uniform float u_absorption;    // density factor
    
    // Scissor check uniform to limit texture coordinates drawn (redundancy for scissor test)
    uniform float u_minY;
    uniform float u_maxY;

    // Helper: sample displacement and run concentric circular variable blur
    vec4 variableBlur(vec2 uv, vec2 offset, float sigma) {
        if (sigma <= 0.01) {
            return texture2D(u_image, uv + offset);
        }
        
        vec4 acc = vec4(0.0);
        float totalWeight = 0.0;
        
        // Sampling ring configuration (concentric circles)
        const int RINGS = 3;
        const int SAMPLES_PER_RING = 6;
        
        // Center sample
        acc += texture2D(u_image, uv + offset) * 2.0;
        totalWeight += 2.0;
        
        for (int r = 1; r <= RINGS; r++) {
            float radius = (float(r) / float(RINGS)) * sigma * 0.018; // Scale radial spread
            float weight = exp(-float(r * r) / (2.0 * 2.0)); // Gaussian weight
            
            for (int s = 0; s < SAMPLES_PER_RING; s++) {
                float angle = (float(s) / float(SAMPLES_PER_RING)) * 6.28318;
                vec2 sampleOffset = vec2(cos(angle), sin(angle)) * radius;
                
                // Keep sample within display bounds
                vec2 sampleUV = clamp(uv + offset + sampleOffset, vec2(0.001), vec2(0.999));
                acc += texture2D(u_image, sampleUV) * weight;
                totalWeight += weight;
            }
        }
        return acc / totalWeight;
    }

    void main() {
        if (v_uv.y < u_minY || v_uv.y > u_maxY) {
            discard; // Ensure we only render the designated slice
        }

        vec2 texel = 1.0 / u_resolution;
        
        // Compute normal vector from heightmap gradients using central difference
        float hL = texture2D(u_heightmap, v_uv - vec2(texel.x, 0.0)).r;
        float hR = texture2D(u_heightmap, v_uv + vec2(texel.x, 0.0)).r;
        float hD = texture2D(u_heightmap, v_uv - vec2(0.0, texel.y)).r;
        float hU = texture2D(u_heightmap, v_uv + vec2(0.0, texel.y)).r;
        
        float dhdx = (hR - hL) * 0.5 * u_noiseAmp;
        float dhdy = (hU - hD) * 0.5 * u_noiseAmp;
        
        // Normal vector (normalized)
        vec3 N = normalize(vec3(-dhdx, -dhdy, 1.0));
        
        // 1. Refraction offset calculation: offset = (n - 1) * normal.xy * d
        // We scale by texel.x / texel.y to normalize across dimensions
        float refracScale = (u_ior - 1.0) * u_distance * 0.15;
        vec2 refractionOffset = N.xy * refracScale;
        
        // Clamp refracted UV coordinates
        vec2 refractedUV = clamp(v_uv + refractionOffset, vec2(0.001), vec2(0.999));
        
        // 2. Spatial Blur / Lobe Spread: sigma = d * alpha
        float sigma = u_distance * u_roughness;
        vec4 blurredColor = variableBlur(v_uv, refractionOffset, sigma);
        
        // 3. Beer-Lambert Absorption: Tint color scaled by pathlength s = T / N.z
        // pathlength grows at grazing normal angles (small N.z)
        float pathlength = 1.0 / max(N.z, 0.08); // Avoid division by zero
        float absorbAmt = 1.0 - exp(-u_absorption * (pathlength - 1.0));
        
        vec3 finalColor = mix(blurredColor.rgb, blurredColor.rgb * u_tintColor, absorbAmt);
        
        gl_FragColor = vec4(finalColor, blurredColor.a);
    }
`;

// ─── Setup WebGL Program ────────────────────────────────────────────────────
function initWebGL(width, height) {
    if (!glCanvas) {
        glCanvas = document.createElement('canvas');
    }
    glCanvas.width = width;
    glCanvas.height = height;
    
    gl = glCanvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) {
        console.error("WebGL context creation failed.");
        return false;
    }
    
    // Compile shaders
    const compileShader = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error("Shader compiler error:", gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    };
    
    const vs = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vs || !fs) return false;
    
    shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vs);
    gl.attachShader(shaderProgram, fs);
    gl.linkProgram(shaderProgram);
    
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        console.error("WebGL Program linking failed.");
        return false;
    }
    
    // Position Buffer
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
         1,  1,
    ]), gl.STATIC_DRAW);
    
    // Setup textures
    if (originalTexture) gl.deleteTexture(originalTexture);
    originalTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, originalTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    if (heightmapTexture) gl.deleteTexture(heightmapTexture);
    heightmapTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, heightmapTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    return true;
}

// ─── Liquid Glass — GPU wave-equation simulator ───────────────────────────
// The pane becomes a body of water: h(x,y,t) evolved by the 2-D wave equation
// on a ping-pong float target. R = surface height, G = surface velocity.
// The live height field is fed straight into the refraction shader as the
// glass map, so the photo warps under real ripples. Pointer = a finger in it.
const simFragSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_state;   // .r = height, .g = velocity
    uniform vec2 u_res;
    uniform float u_c2;          // wave speed^2 * dt^2 (CFL-stable when <= 0.49)
    uniform float u_damp;        // velocity damping — surface tension / viscosity
    uniform vec2 u_impulse;      // disturbance centre, uv
    uniform float u_impStr;      // disturbance amplitude (0 = none this step)
    uniform float u_impRad;      // disturbance radius, uv

    void main() {
        vec2 t = 1.0 / u_res;
        vec2 s = texture2D(u_state, v_uv).rg;
        float h = s.r;
        float v = s.g;

        // Laplacian via 4-neighbour stencil (CLAMP_TO_EDGE = reflective walls)
        float hl = texture2D(u_state, v_uv - vec2(t.x, 0.0)).r;
        float hr = texture2D(u_state, v_uv + vec2(t.x, 0.0)).r;
        float hd = texture2D(u_state, v_uv - vec2(0.0, t.y)).r;
        float hu = texture2D(u_state, v_uv + vec2(0.0, t.y)).r;
        float lap = hl + hr + hd + hu - 4.0 * h;

        v += u_c2 * lap;   // accelerate toward the mean (restoring force)
        v *= u_damp;       // bleed energy
        h += v;            // integrate height

        if (u_impStr != 0.0) {
            vec2 dd = v_uv - u_impulse;
            dd.x *= u_res.x / u_res.y;                 // keep drops circular
            float b = exp(-dot(dd, dd) / (u_impRad * u_impRad));
            h += b * u_impStr;
        }

        gl_FragColor = vec4(h, v, 0.0, 1.0);
    }
`;

function compileProgram(fragSrc) {
    const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("Sim shader error:", gl.getShaderInfoLog(sh));
            return null;
        }
        return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, vertexShaderSource);
    const fs = mk(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error("Sim program link failed.");
        return null;
    }
    return p;
}

// Probe for a color-renderable float texture type (half-float preferred).
function pickFloatType() {
    const test = (type) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, type, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(tex);
        return ok;
    };
    const half = gl.getExtension('OES_texture_half_float');
    if (half) {
        gl.getExtension('EXT_color_buffer_half_float');
        if (test(half.HALF_FLOAT_OES)) {
            floatLinear = !!gl.getExtension('OES_texture_half_float_linear');
            return half.HALF_FLOAT_OES;
        }
    }
    if (gl.getExtension('OES_texture_float')) {
        gl.getExtension('WEBGL_color_buffer_float');
        if (test(gl.FLOAT)) {
            floatLinear = !!gl.getExtension('OES_texture_float_linear');
            return gl.FLOAT;
        }
    }
    return null;
}
let floatLinear = false;

function makeStateTexture(w, h) {
    const filter = floatLinear ? gl.LINEAR : gl.NEAREST;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, floatTexType, null);
    return tex;
}

// Build (or rebuild) the sim resources to match the current image aspect.
function initLiquidGL() {
    if (!gl) return false;
    if (floatTexType === null) {
        floatTexType = pickFloatType();
        if (floatTexType === null) return false;
    }
    if (!simProgram) {
        simProgram = compileProgram(simFragSource);
        if (!simProgram) return false;
    }
    if (!simFbo) simFbo = gl.createFramebuffer();

    // Sim grid: cap the long edge for a smooth, cheap surface. Ripples are
    // low-frequency, so a coarse grid up-samples cleanly through the refractor.
    const w = glCanvas.width, h = glCanvas.height;
    const scale = Math.min(1, 400 / Math.max(w, h));
    const nw = Math.max(32, Math.round(w * scale));
    const nh = Math.max(32, Math.round(h * scale));
    if (nw === simW && nh === simH && stateTextures[0]) {
        calmLiquid();
        return true;
    }
    simW = nw; simH = nh;
    stateTextures.forEach(t => t && gl.deleteTexture(t));
    stateTextures = [makeStateTexture(simW, simH), makeStateTexture(simW, simH)];
    stateRead = 0;
    calmLiquid();
    return true;
}

// Clear the surface back to flat, still water.
function calmLiquid() {
    if (!simFbo || !stateTextures[0]) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, simFbo);
    gl.viewport(0, 0, simW, simH);
    gl.clearColor(0, 0, 0, 1);
    stateTextures.forEach(tex => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function stepLiquid(impulse) {
    const c2 = Math.min(0.49, Math.max(0, parseFloat(document.getElementById('valLiquidSpeed').value) || 0.3));
    const damp = Math.min(1, Math.max(0.9, parseFloat(document.getElementById('valLiquidDamp').value) || 0.985));

    const src = stateTextures[stateRead];
    const dst = stateTextures[stateRead ^ 1];

    gl.useProgram(simProgram);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, simFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.viewport(0, 0, simW, simH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);

    const loc = (n) => gl.getUniformLocation(simProgram, n);
    gl.uniform1i(loc("u_state"), 0);
    gl.uniform2f(loc("u_res"), simW, simH);
    gl.uniform1f(loc("u_c2"), c2);
    gl.uniform1f(loc("u_damp"), damp);
    if (impulse) {
        gl.uniform2f(loc("u_impulse"), impulse.u, impulse.v);
        gl.uniform1f(loc("u_impStr"), impulse.str);
        gl.uniform1f(loc("u_impRad"), impulse.rad);
    } else {
        gl.uniform1f(loc("u_impStr"), 0.0);
    }

    const posLoc = gl.getAttribLocation(simProgram, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    stateRead ^= 1;
}

function liquidFrame() {
    if (!liquidMode) return;

    // Advance the surface (two substeps per frame for a livelier medium).
    const imp = queuedImpulse;
    queuedImpulse = null;
    stepLiquid(imp);
    stepLiquid(null);

    // Optional ambient rain: random droplets on a jittered cadence.
    const rain = document.getElementById('liquidRain');
    if (rain && rain.checked && --rainCountdown <= 0) {
        queuedImpulse = { u: Math.random(), v: Math.random(), str: 0.05, rad: 0.02 };
        rainCountdown = 18 + Math.floor(Math.random() * 42);
    }

    // Render the photo through the live surface.
    activeHeightTex = stateTextures[stateRead];
    heightAmpOverride = parseFloat(document.getElementById('valLiquidDistort').value) || 8;
    drawWebGLPass(0.0, 1.0);
    activeHeightTex = null;
    heightAmpOverride = null;

    displayCanvas.getContext('2d').drawImage(glCanvas, 0, 0);
    liquidLoopId = requestAnimationFrame(liquidFrame);
}

const liquidControls = document.getElementById('liquidControls');

function enterLiquidMode() {
    if (!originalImage || !gl) return;
    if (liquidSupported === false) return;
    if (!initLiquidGL()) {
        liquidSupported = false;
        renderStateText.textContent = "Liquid: no float target";
        renderStateText.style.color = "var(--warn)";
        presetSelect.value = lastProceduralPreset;
        updateMapSourceUI();
        return;
    }
    liquidSupported = true;
    liquidMode = true;
    if (liquidControls) liquidControls.hidden = false;
    proceduralMapControls.hidden = true;
    importedMapControls.hidden = true;
    mapSourceName.textContent = "Liquid Glass (live)";
    displayCanvas.style.cursor = "crosshair";
    renderStateText.textContent = "Liquid — live";
    renderStateText.style.color = "var(--aqua)";
    document.getElementById('backendStatus').textContent = "Backend: WebGL Liquid";

    // A first drop so the surface is already alive on entry.
    queuedImpulse = { u: 0.5, v: 0.55, str: 0.13, rad: 0.05 };
    rainCountdown = 30;
    cancelAnimationFrame(liquidLoopId);
    liquidLoopId = requestAnimationFrame(liquidFrame);
}

function exitLiquidMode() {
    liquidMode = false;
    cancelAnimationFrame(liquidLoopId);
    liquidLoopId = null;
    activeHeightTex = null;
    heightAmpOverride = null;
    if (liquidControls) liquidControls.hidden = true;
    displayCanvas.style.cursor = "";
    renderStateText.textContent = "Idle";
    renderStateText.style.color = "#008f82";
    document.getElementById('backendStatus').textContent = "Backend: WebGL (GPU)";
}

// Map a pointer event on the display canvas to sim uv (top-left origin → uv).
function pointerToUV(e) {
    const r = displayCanvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = 1.0 - (e.clientY - r.top) / r.height; // framebuffer is bottom-up
    return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}

// ─── Glass Map Generation ────────────────────────────────────────────────
function renderImportedHeightmap() {
    if (!customMapImage) return;

    const w = hiddenHeightCanvas.width;
    const h = hiddenHeightCanvas.height;
    const ctx = hiddenHeightCanvas.getContext('2d');
    const blur = Math.max(0, parseFloat(document.getElementById('valMapBlur').value) || 0);
    const strength = Math.max(0, parseFloat(document.getElementById('valMapStrength').value) || 0);
    const invert = document.getElementById('invertHeightmap').checked;
    const bleed = Math.ceil(blur * 2);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    ctx.drawImage(customMapImage, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
    ctx.restore();

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
        let height = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
        if (invert) height = 255 - height;
        height = Math.max(0, Math.min(255, 128 + (height - 128) * strength));
        data[i] = height;
        data[i + 1] = height;
        data[i + 2] = height;
        data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    customMapDirty = false;
}

function generateHeightmap() {
    const preset = presetSelect.value;
    if (preset === 'image-map' && isCustomMapLoaded) {
        if (customMapDirty) renderImportedHeightmap();
        return;
    }
    const w = hiddenHeightCanvas.width;
    const h = hiddenHeightCanvas.height;
    const ctx = hiddenHeightCanvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;
    
    const freq = parseFloat(document.getElementById('valNoiseFreq').value);
    const amp = parseFloat(document.getElementById('valNoiseAmp').value);
    
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let val = 0.5; // Neutral height middle
            
            if (preset === 'satinato') {
                // High-frequency, tiny grain noise
                val = 0.5 + (vNoise.noise(x * 1.5, y * 1.5) - 0.5) * 0.12 * amp;
            } 
            else if (preset === 'sandblast') {
                // Coarser, organic bumps using fBm
                val = vNoise.fbm(x * freq * 3, y * freq * 3, 3) * amp;
            } 
            else if (preset === 'reeded') {
                // 1-D vertical periodic ridges with organic meandering/drift
                let drift = vNoise.noise(x * 0.005, y * 0.02) * 8.0;
                let ridgeVal = Math.sin((x + drift) * freq * 18.0);
                
                // Add a fine surface ripple overlay
                let fineRipple = (vNoise.noise(x * 0.2, y * 0.2) - 0.5) * 0.08;
                val = 0.5 + (ridgeVal * 0.45 + fineRipple) * amp;
            } 
            else if (preset === 'cathedral') {
                // Low-frequency dimples
                let cellVal = Math.sin(x * freq * 6) * Math.cos(y * freq * 6);
                val = 0.5 + cellVal * 0.4 * amp;
            } 
            else if (preset === 'seedy') {
                // Base smooth glass
                val = 0.5;
                // Seed micro-bubbles on coordinates deterministically
                let noiseCoord = vNoise.noise(x * 0.03, y * 0.03);
                if (noiseCoord > 0.88) {
                    let bubbleCenter = vNoise.noise(x * 0.5, y * 0.5);
                    if (bubbleCenter > 0.7) {
                        val = 0.5 - 0.3 * amp; // Depress height at bubbles
                    }
                }
            } 
            else if (preset === 'custom-noise') {
                // Pure multiresolution fBm
                val = vNoise.fbm(x * freq * 2.5, y * freq * 2.5, 4) * amp;
            }
            
            // Clamp and write height
            let u8 = Math.max(0, Math.min(255, Math.floor(val * 255)));
            let idx = (y * w + x) * 4;
            data[idx]     = u8; // Red: Height
            data[idx + 1] = u8; // Green: Height
            data[idx + 2] = u8; // Blue: Height
            data[idx + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
}

// ─── Render Pass Control ────────────────────────────────────────────────────
function getParams() {
    const hex = tintColorInput.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    
    return {
        distance:   parseFloat(document.getElementById('valDistance').value),
        roughness:  parseFloat(document.getElementById('valRoughness').value),
        ior:        parseFloat(document.getElementById('valIor').value),
        absorption: parseFloat(document.getElementById('valAbsorption').value),
        noiseFreq:  parseFloat(document.getElementById('valNoiseFreq').value),
        noiseAmp:   presetSelect.value === 'image-map'
            ? 1
            : parseFloat(document.getElementById('valNoiseAmp').value),
        tintColor:  [r, g, b]
    };
}

function drawWebGLPass(minY, maxY) {
    if (!gl) return;
    
    const params = getParams();
    
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.useProgram(shaderProgram);
    
    // Enable scissor testing to chunk render passes
    gl.enable(gl.SCISSOR_TEST);
    let pxMinY = Math.floor(minY * glCanvas.height);
    let pxMaxY = Math.floor(maxY * glCanvas.height);
    gl.scissor(0, pxMinY, glCanvas.width, pxMaxY - pxMinY);
    
    // Textures bind
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, originalTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hiddenOriginalCanvas);
    
    gl.activeTexture(gl.TEXTURE1);
    if (activeHeightTex) {
        // Liquid mode: sample the live wave field directly (no canvas upload).
        gl.bindTexture(gl.TEXTURE_2D, activeHeightTex);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, heightmapTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hiddenHeightCanvas);
    }

    // Uniforms mapping
    const loc = (name) => gl.getUniformLocation(shaderProgram, name);
    gl.uniform1i(loc("u_image"), 0);
    gl.uniform1i(loc("u_heightmap"), 1);
    gl.uniform2f(loc("u_resolution"), glCanvas.width, glCanvas.height);

    gl.uniform1f(loc("u_distance"), params.distance);
    gl.uniform1f(loc("u_roughness"), params.roughness);
    gl.uniform1f(loc("u_ior"), params.ior);
    gl.uniform1f(loc("u_noiseAmp"), heightAmpOverride !== null ? heightAmpOverride : params.noiseAmp);
    gl.uniform3fv(loc("u_tintColor"), new Float32Array(params.tintColor));
    gl.uniform1f(loc("u_absorption"), params.absorption);
    gl.uniform1f(loc("u_minY"), minY);
    gl.uniform1f(loc("u_maxY"), maxY);
    
    // Draw
    const posLoc = gl.getAttribLocation(shaderProgram, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
}

// ─── Rendering Pipelines ────────────────────────────────────────────────────

// Fast Preview: WebGL draws single pass directly to visible canvas
function updatePreview() {
    if (!originalImage || isCooking) return;
    if (liquidMode) return; // the live loop owns the canvas in liquid mode

    const w = originalImage.width;
    const h = originalImage.height;
    
    // Generate fresh Heightmap texture
    generateHeightmap();
    
    // Draw Tier 1 Full-screen pass (No scissor limits)
    drawWebGLPass(0.0, 1.0);
    
    // Blit to screen
    const ctx = displayCanvas.getContext('2d');
    ctx.drawImage(glCanvas, 0, 0);
    
    updateDisplayTab();
}

// High Quality Cook Render Loop (Tier 3 Progressive Scissor Engine)
function runCookSlice() {
    if (!isCooking) return;
    
    // Progress calculation
    let minY = cookSliceIndex / totalSlices;
    let maxY = (cookSliceIndex + 1) / totalSlices;
    
    // Execute WebGL render for current slice band
    drawWebGLPass(minY, maxY);
    
    // Draw finished slice on display canvas
    const ctx = displayCanvas.getContext('2d');
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    
    let pyMinY = Math.floor(minY * h);
    let pyMaxY = Math.floor(maxY * h);
    let pyHeight = pyMaxY - pyMinY;
    
    // WebGL coordinates have origin at bottom-left, Canvas 2D at top-left
    let glSourceY = pyMinY; 
    
    ctx.drawImage(
        glCanvas, 
        0, glCanvas.height - pyMaxY, w, pyHeight, // Source slice
        0, h - pyMaxY, w, pyHeight                // Destination slice
    );
    
    // Update progress bar
    cookSliceIndex++;
    cookProgress = Math.round((cookSliceIndex / totalSlices) * 100);
    progressFill.style.width = `${cookProgress}%`;
    percentLabel.textContent = `${cookProgress}%`;
    
    if (cookSliceIndex < totalSlices) {
        animationFrameId = requestAnimationFrame(runCookSlice);
    } else {
        finishCooking();
    }
}

function startCooking() {
    if (!originalImage || isCooking) return;
    if (liquidMode) return; // live surface is already the render; use Save PNG to grab a frame
    
    isCooking = true;
    cookProgress = 0;
    cookSliceIndex = 0;
    
    cookBtn.disabled = true;
    cancelBtn.disabled = false;
    saveBtn.disabled = true;
    presetSelect.disabled = true;
    
    renderStateText.textContent = "Cooking...";
    renderStateText.style.color = "var(--aqua)";
    
    // Ensure heightmap is fully calculated and textures loaded
    generateHeightmap();
    
    // Clear display canvas slightly to indicate beginning
    const ctx = displayCanvas.getContext('2d');
    ctx.fillStyle = "rgba(224, 242, 254, 0.45)";
    ctx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
    
    // Start progressive scissor render loop
    animationFrameId = requestAnimationFrame(runCookSlice);
}

function cancelCooking() {
    if (!isCooking) return;
    isCooking = false;
    cancelAnimationFrame(animationFrameId);
    
    cookBtn.disabled = false;
    cancelBtn.disabled = true;
    presetSelect.disabled = false;
    renderStateText.textContent = "Cancelled";
    renderStateText.style.color = "var(--warn)";
    
    updatePreview();
}

function finishCooking() {
    isCooking = false;
    cookBtn.disabled = false;
    cancelBtn.disabled = true;
    saveBtn.disabled = false;
    presetSelect.disabled = false;
    renderStateText.textContent = "Done";
    renderStateText.style.color = "var(--aqua)";
    
    // Lock in final render representation
    updateDisplayTab();
}

// ─── Workspace Tabs Routing ──────────────────────────────────────────────────
function updateDisplayTab() {
    if (!originalImage) return;
    const ctx = displayCanvas.getContext('2d');
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    
    if (activeView === 'original') {
        ctx.drawImage(hiddenOriginalCanvas, 0, 0);
    } 
    else if (activeView === 'heightmap') {
        ctx.drawImage(hiddenHeightCanvas, 0, 0);
    } 
    else if (activeView === 'aeropane') {
        // If cooking was finished, it stays in displayCanvas, else we show preview draw
        if (!isCooking && cookProgress < 100) {
            ctx.drawImage(glCanvas, 0, 0);
        }
    }
}

viewTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
        viewTabs.forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        activeView = e.target.getAttribute('data-view');
        updateDisplayTab();
    });
});

// ─── Pixel Inspector ────────────────────────────────────────────────────────
function toHex(rgb) {
    return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
}

displayCanvas.addEventListener('pointermove', (e) => {
    if (!originalImage) return;
    const r = displayCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) * (displayCanvas.width / r.width));
    const y = Math.floor((e.clientY - r.top) * (displayCanvas.height / r.height));
    
    if (x < 0 || y < 0 || x >= displayCanvas.width || y >= displayCanvas.height) return;
    
    const ctx = displayCanvas.getContext('2d');
    let d;
    try {
        d = ctx.getImageData(x, y, 1, 1).data;
    } catch (err) { return; }
    
    // Hex
    const hex = toHex([d[0], d[1], d[2]]);
    
    // Simple RGB readout
    pixelInfo.innerHTML = `
        <span class="sw" style="background:${hex}"></span>
        ${x}, ${y} &middot; ${hex} &middot; R:${d[0]} G:${d[1]} B:${d[2]}
    `;
});

displayCanvas.addEventListener('pointerleave', () => {
    pixelInfo.textContent = "hover to inspect pixels";
});

// ─── Liquid pointer disturbance ───────────────────────────────────────────
displayCanvas.addEventListener('pointerdown', (e) => {
    if (!liquidMode) return;
    pointerDown = true;
    const p = pointerToUV(e);
    queuedImpulse = { u: p.u, v: p.v, str: 0.14, rad: 0.035 };
    displayCanvas.setPointerCapture(e.pointerId);
});

displayCanvas.addEventListener('pointermove', (e) => {
    if (!liquidMode || !pointerDown) return;
    const p = pointerToUV(e);
    queuedImpulse = { u: p.u, v: p.v, str: 0.05, rad: 0.03 };
});

const endPointer = () => { pointerDown = false; };
displayCanvas.addEventListener('pointerup', endPointer);
displayCanvas.addEventListener('pointercancel', endPointer);

// ─── File Drag-and-Drop & Load Operations ──────────────────────────────────
function revealWorkspace(img) {
    const prompt = document.getElementById('viewportPrompt');
    if (prompt) prompt.style.display = 'none';
    displayCanvas.hidden = false;
    
    // Resize hidden canvases to source bounds
    const w = img.width;
    const h = img.height;
    
    displayCanvas.width = w;
    displayCanvas.height = h;
    
    hiddenOriginalCanvas.width = w;
    hiddenOriginalCanvas.height = h;
    hiddenOriginalCanvas.getContext('2d').drawImage(img, 0, 0);
    
    hiddenHeightCanvas.width = w;
    hiddenHeightCanvas.height = h;
    customMapDirty = true;
    
    // Init WebGL pipeline
    initWebGL(w, h);
    
    // Trigger preview
    updatePreview();
    
    saveBtn.disabled = false;
}

function handleImageFile(file) {
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            originalImage = img;
            revealWorkspace(img);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function updateMapSourceUI() {
    const importedActive = presetSelect.value === 'image-map' && isCustomMapLoaded;
    mapSourceCard.classList.toggle('is-imported', importedActive);
    importedMapControls.hidden = !importedActive;
    proceduralMapControls.hidden = importedActive;
    resetHeightmapBtn.disabled = !importedActive;

    if (importedActive) {
        mapSourceName.textContent = customMapFilename || 'Imported image map';
        return;
    }

    const selected = presetSelect.options[presetSelect.selectedIndex];
    mapSourceName.textContent = `Procedural: ${selected ? selected.textContent : 'Satinato'}`;
}

function handleHeightmapFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            // Sized to match current workspace bounds (or fallback to image bounds)
            const w = displayCanvas.width || img.width;
            const h = displayCanvas.height || img.height;
            
            // If no original image has been loaded yet, initialize workspace with a blank canvas
            if (!originalImage) {
                const blank = document.createElement('canvas');
                blank.width = w;
                blank.height = h;
                const oCtx = blank.getContext('2d');
                oCtx.fillStyle = '#ffffff';
                oCtx.fillRect(0, 0, w, h);
                originalImage = blank;
                revealWorkspace(originalImage);
            }

            customMapImage = img;
            customMapFilename = file.name;
            customMapDirty = true;
            isCustomMapLoaded = true;
            imageMapOption.disabled = false;
            presetSelect.value = 'image-map';
            updateMapSourceUI();
            
            // Trigger refresh
            updatePreview();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// Setup welcome card click to browse
const viewportPrompt = document.getElementById('viewportPrompt');
if (viewportPrompt) {
    viewportPrompt.addEventListener('click', () => imageInput.click());
}

imageInput.addEventListener('change', (e) => handleImageFile(e.target.files[0]));
heightmapInput.addEventListener('change', (e) => {
    handleHeightmapFile(e.target.files[0]);
    e.target.value = '';
});
loadHeightmapBtn.addEventListener('click', () => heightmapInput.click());
resetHeightmapBtn.addEventListener('click', () => {
    presetSelect.value = lastProceduralPreset;
    presetSelect.dispatchEvent(new Event('change'));
});
document.getElementById('invertHeightmap').addEventListener('input', () => {
    customMapDirty = true;
    updatePreview();
});

// Full-screen drag and drop routing
window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    // Route drop destination depending on active tab selection
    if (activeView === 'heightmap') {
        handleHeightmapFile(e.dataTransfer.files[0]);
    } else {
        handleImageFile(e.dataTransfer.files[0]);
    }
});

// ─── Dynamic Sliders Syncing ─────────────────────────────────────────────────
function initDynamicSliders() {
    document.querySelectorAll('.dynamic-slider-group').forEach(group => {
        const valInput = group.querySelector('.val-input');
        const slider = group.querySelector('.param-slider');
        const minInput = group.querySelector('.min-input');
        const maxInput = group.querySelector('.max-input');
        const affectsImportedMap = group.dataset.param === 'mapStrength'
            || group.dataset.param === 'mapBlur';
        
        const sync = () => {
            let v = parseFloat(valInput.value) || 0;
            let min = minInput ? parseFloat(minInput.value) || 0 : 0;
            let max = maxInput ? parseFloat(maxInput.value) || 100 : 100;
            
            // Adjust bounds if value drifts outside
            if (v < min) {
                min = v;
                if (minInput) minInput.value = min;
            }
            if (v > max) {
                max = v;
                if (maxInput) maxInput.value = max;
            }
            
            slider.min = min;
            slider.max = max;
            slider.value = v;
        };
        
        valInput.addEventListener('input', () => {
            sync();
            if (affectsImportedMap) customMapDirty = true;
            updatePreview();
        });
        
        slider.addEventListener('input', () => {
            valInput.value = slider.value;
            if (affectsImportedMap) customMapDirty = true;
            updatePreview();
        });
        
        if (minInput && maxInput) {
            [minInput, maxInput].forEach(el => el.addEventListener('input', sync));
        }
        
        sync();
    });
}

// Preset changes load preset values
presetSelect.addEventListener('change', () => {
    const val = presetSelect.value;

    if (val === 'liquid') {
        enterLiquidMode();
        return;
    }
    if (liquidMode) exitLiquidMode();

    if (val === 'image-map') {
        customMapDirty = true;
    } else {
        lastProceduralPreset = val;
    }
    const freqInput = document.getElementById('valNoiseFreq');
    const ampInput = document.getElementById('valNoiseAmp');
    
    if (val === 'satinato') {
        freqInput.value = 0.12;
        ampInput.value = 0.4;
    } else if (val === 'sandblast') {
        freqInput.value = 0.08;
        ampInput.value = 1.0;
    } else if (val === 'reeded') {
        freqInput.value = 0.025;
        ampInput.value = 1.5;
    } else if (val === 'cathedral') {
        freqInput.value = 0.035;
        ampInput.value = 2.0;
    } else if (val === 'seedy') {
        freqInput.value = 0.05;
        ampInput.value = 1.2;
    }

    updateMapSourceUI();
    
    // Dispatch input syncs
    freqInput.dispatchEvent(new Event('input'));
    ampInput.dispatchEvent(new Event('input'));
});

tintColorInput.addEventListener('input', updatePreview);

// ─── Export ──────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
    if (!originalImage || isCooking) return;
    
    const filename = document.getElementById('filenameInput').value || 'aeropane_charmed';
    const link = document.createElement('a');
    link.download = `${filename}.png`;
    link.href = displayCanvas.toDataURL('image/png');
    link.click();
});

cookBtn.addEventListener('click', startCooking);
cancelBtn.addEventListener('click', cancelCooking);

// Liquid transport
const liquidDropBtn = document.getElementById('liquidDropBtn');
const liquidClearBtn = document.getElementById('liquidClearBtn');
if (liquidDropBtn) liquidDropBtn.addEventListener('click', () => {
    queuedImpulse = { u: 0.3 + Math.random() * 0.4, v: 0.3 + Math.random() * 0.4, str: 0.16, rad: 0.05 };
});
if (liquidClearBtn) liquidClearBtn.addEventListener('click', () => { if (liquidMode) calmLiquid(); });

// Initialize Sliders
initDynamicSliders();
updateMapSourceUI();
document.getElementById('backendStatus').textContent = "Backend: WebGL (GPU)";
