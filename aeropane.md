# Aeropane — frosted glass / gel as physical image filter

*MVP shipped on 2026-07-12. Features WebGL Tier-1 preview, Tier-3 progressive scissor render, and light-mode Frutiger Aero design.*

Sibling of the **visual tools** family (GaHueMa shipped, DHuenut concept'd): image/video in, image/video out, single-purpose, web-native. Where GaHueMa bends hue and DHuenut maps the hue torus, this one puts a **physical pane of matter between the viewer and the image** — frosted glass, gel, reeded glass, grown ice — and renders what light actually does passing through it.

---

## Stance

- **Offline-first, quality-first.** Not chasing realtime. The render takes as long as it takes. No cool effect gets sacrificed to a frame budget.
- **Progressive render with a playable progress bar.** As frames finish they become playable — scrub and play the done region while the tail still cooks (VirtualDub / render-farm preview idiom). This is the whole UX contract: never a black box with a percentage, always a growing watchable thing.
- **Physically modeled, then physically transgressive.** Match Blender-grade ground truth first; then push where Blender can't go (§ Beyond Blender).
- Hindcasts acausality not needed here — the effect is spatial per-frame, so streaming/progressive rendering is trivially causal. (If video glass maps arrive, still frame-wise causal.)

---

## Physical model

Rough dielectric interface = microfacet BTDF (GGX transmission, Walter et al. 2007). Two separable consequences on the image behind the pane:

1. **Refraction offset** — mean surface normal tilts the transmitted ray. Offset ≈ (n−1)·∇h·d, with h(x,y) the surface height field and d the glass-to-subject distance. This is the wobble/distortion channel.
2. **Angular spread** — roughness α widens the transmitted lobe; on the image plane this is a blur with kernel σ ≈ d·tan(θ_α). The BTDF lobe is near-Gaussian in angle, so a spatially-varying Gaussian blur is *physically justified*, not a hack.

Plus the supporting stack:

- **Distance-dependent blur** — the single realism-maker most fakes miss. Object touching the glass = sharp; far object = mush. σ per pixel scales with d. Needs a depth channel (real, estimated, or authored — a painted "distance map" is a legitimate creative control).
- **Fresnel** — grazing angles go reflective; blurry environment specular on the rough surface, roughness-matched.
- **Absorption** — Beer–Lambert `exp(−σ_a · pathlength)` tint. Essential for gel; pathlength grows at grazing → natural edge darkening.
- **Gel vs frost = same model, different spectrum of h.** Frost: high-frequency micro-roughness (small offset, heavy blur). Gel: smooth low-frequency blobs (big slow distortion, mild blur) + volume scattering → internal glow, light bleed at edges. Everything in between is a knob, not a mode.

## Frostedness taxonomy

"Type of frostedness" = the pair (spectrum of h, roughness α), and the obscure-glass trade already names the presets: satinato / acid-etch (fine isotropic), sandblast (coarser isotropic), **reeded / fluted** (1-D periodic ridges), cathedral / hammered (low-freq dimples), seedy (embedded bubbles), glue-chip (fern/frost dendrites), stipple, pattern glass (Pilkington's Arctic, Flemish, Autumn…). Plus the gel branch: lighting-diffusion gels (Rosco Tough Frost / Opal / Hamburg Frost as reference targets), petroleum-jelly-on-filter (classic cinematography vignette trick), ballistic gel slab.

Anti-lattice hook, and it's a real one: reeded/fluted glass is a *periodic lattice* — the tool should ship the dequantized versions natively. Irregular flute widths, drifting ridge phase, flutes that meander. Machine glass made organic — squarely the counter-poetics thesis, in glass.

## Glass maps (the roadmap spine)

1. **Procedural h(x,y)** — noise families + the taxonomy presets above.
2. **Image as glass map** — any image becomes the pane. Luminance→height (or normal-map import). Portrait frosted through another portrait. This is where it becomes an instrument instead of a filter.
3. **Video as glass map** — h(x,y,t). Breathing glass, glass that is itself footage. Two videos: one is the world, one is the window.

## Beyond Blender

Blender/Cycles does rough refraction fine — path-traced GGX transmission is the ground-truth reference to eyeball against. What it can't do, or can't do natively, is the actual destination:

- **Grown frost.** Don't texture the frost — *simulate its formation*: diffusion-limited aggregation / phase-field dendrite growth of ice on the pane, then render through the grown h field. Frost as a process with a time axis, seedable, directable (nucleation sites, humidity, gradient). Watch the window freeze over the footage.
- **Live gel physics.** h(x,y,t) evolved by thin-film / Hele-Shaw flow: gel that sags under gravity, gets finger-pressed, heals viscously. Condensation branch: breath-fog deposition, droplet nucleation + coalescence, runnels, wipe gestures.
- **Wave optics.** Cycles is geometric-only. Fine frost structure at ~wavelength scale diffracts: spectral PSFs, glory/corona halos around lights, structural color. A diffraction-kernel tier (Fraunhofer of the local aperture function) gets effects no geometric renderer has.
- **Spectral scatter.** Wavelength-dependent σ and n(λ) → chromatic blur fringes, dispersion in the wobble. Cheap in a purpose-built 2.5-D renderer, painful in a general one.
- **Nonphysical extrapolation** (the DHuenut move — find the parameter that generalizes, then let it leave physical range): negative (n−1) panes, complex/rotating IOR fields, roughness < 0 as "de-frosting" deconvolution, glass maps driven by the image itself (footage frosts itself — feedback).

## Rendering architecture (sketch, not commitment)

Web, offline, tiered:

- **Tier 1 — screen-space:** normal-map UV offset + per-pixel variable-σ blur via mip/scale pyramid. Fast preview tier; matches Windows-Acrylic-class output but distance-aware.
- **Tier 2 — splatting:** each source pixel splats its projected BTDF footprint (anisotropic, offset, tinted). Handles heavy anisotropy (reeded!) and big lobes correctly where screen-space gather breaks.
- **Tier 3 — 2.5-D ray march:** actual slab — entry refraction, internal scattering events, exit; multiple-scattering, spectral samples, Fresnel bounce. The quality tier the progress bar exists for.
- **Tier 4 — wave patch:** diffraction kernels composited where the geometric tiers can't speak.

Plumbing: WebCodecs decode → process (WebGPU compute preferred, WASM/CPU fallback) → WebCodecs encode, frames appended to a playable buffer as they land (GaHueMa's webm-export lineage, upgraded to streaming). Determinism: seedable everything, so re-renders reproduce.

## Design

**Light-mode Frutiger Aero / Google Glass** — implemented in 2026-07-12 styling pivot. Features transparent glassmorphic cards (`backdrop-filter: blur(25px) saturate(180%)`), a bright sky-to-white background gradient with organic blue/green radial glows, and bubbly capsule-like buttons with sharp web 2.0 gloss reflections. The UI represents a nostalgic, highly polished skin / media object (large viewport, responsive controls, and a custom progressive rendering progress track).

## Name shelf (resolved)

Facets on the table: the **pane/vessel** (identity is the glass itself — vessel-naming legitimate here), the **scattering operation**, the **image-on-glass** resonance (photography's ground glass), the **frost-pattern**.

Selected name: **Aeropane** (Frutiger Aero + pane). Selected on 2026-07-12. Captures the y2k prosumer utility SKU vibe, matches the aqua-glass UI aesthetic, has zero web search collision, and acts as the literal vessel container for the physical light scattering. *Vitreality* has been parked for a future project.

Candidates considered:
- **Mattscheibe** — German for ground-glass focusing screen (also slang: foggy head, the TV). Real word, coined-feeling to English eyes, low English-web collision, warm-foreign-technical register. The photography resonance is exact: the ground glass is where photographers *see the image*.
- **Ground Glass** — same facet, plainspoken-technical two-worder (the Sounder / Horn-of-Plenty structural break). Collision with the photo/medical term is resonant rather than noisy, but not self-indexing.
- **Ballotini** — real trade word: micro glass beads used as diffusers. Names the scatterer, Italian-diminutive warmth, low collision, self-indexing-ish.
- **Frostwork** — real word for hoarfrost patterns on windowpanes (also aragonite cave formations). Names the grown-frost destination feature. Warm-plain. Moderate collision (cave term, a videogame weapon).
- **Firn** — granular translucent old snow; short, glaciological, physicist-grave. Mechanism check passes (granular scattering medium) but it's snow, not glass — pane-ness lost.
- **Satinato** — Italian glass-trade finish. Pretty, but it's a live commercial product word (glass suppliers own the search).

Anti-contradiction watch: anything meaning *clear/transparent* (Pellucid, Vitrine-as-display-case) fails — the tool's whole act is refusing transparency. Register bookkeeping: family already has coined-playful (GaHueMa, DHuenut); Mattscheibe/Ballotini sit comfortably beside them; Ground Glass would be this suite's plainspoken break.

## MVP Discoveries & Technical Accomplishments (2026-07-12)

* **WebGL-Scissor Progressive Rendering:** Built a high-performance progressive renderer running entirely on the GPU. Rather than processing pixels on the CPU or causing browser GPU-timeouts on large assets, the engine scissors the canvas coordinates into horizontal strips (`gl.scissor`) and renders them slice-by-slice. This delivers a watchable, responsive progress track while maintaining WebGL acceleration.
* **On-the-fly Fragment Normal Generation:** The fragment shader calculates heights and slope gradients dynamically using central differences on the heightmap texture. This yields the vectors $\vec{N}$ needed for refraction offsets ($x_{src} = x + (n-1) \cdot N_x \cdot d$) and pathlength calculations ($s = T/N_z$).
* **Refractive Absorption edge-darkening:** Using Beer-Lambert's law ($\exp(-\sigma_a \cdot s)$), steep angles of the heightmap normal (where $N_z$ is small, indicating high slopes) result in longer pathlengths $s$, producing natural dark lines and gel edge-shading.
* **Anti-Lattice Reeded Presets:** Periodic glass ridges are "dequantized" by applying value noise as a phase modulator ($\sin(x \cdot \omega + \text{noise}(y) \cdot 1.5)$), generating meandering organic flutes.
* **Image-as-Glass-Map Workflow (2026-07-13):** Imported images now act as persistent luminance height fields with explicit load/reset controls plus non-destructive invert, strength, and blur adjustments. Dragging onto the Glass Map view remains supported; procedural presets stay one click away.

## Ideation 2026-07-12 — motion, lensing, the Gliese bridge

### The unifying abstraction: deflection fields

Everything below collapses into one architectural idea. The current pipeline is really two stages: (1) something generates a **deflection field** D(x,y) — where each output pixel looks in the source — plus a local blur/tint payload; (2) the shader renders it. Right now stage 1 is hardwired to "heightmap surface refraction." But a deflection field can come from anywhere:

- **Surface refraction** (current): D = (n−1)·∇h·d
- **GRIN volume** (mirage, heat shimmer, atmosphere): D = accumulated bending through a continuous n(x,y,z) — exactly Gliese's Lagrangian ray-particle math, light instead of sound
- **Mass map** (gravitational lensing): D = 4GM/(c²b) per point mass, superposed
- **Authored/imported**: paint a flow field directly, or import optical-flow from footage

Making stage 1 pluggable turns "atmospheric/gravitational warping" from a new engine into a new *glass map source*. One renderer, many physics front-ends. This is the load-bearing decision; everything else hangs off it.

### Motion — liquid glass, h(x,y,t) by physics

Video-as-glass-map (roadmap item 3) is playback. The stronger move is **evolution**: h advanced by a PDE on the GPU (ping-pong framebuffer, classic technique, cheap):

- **Ripple / liquid**: 2-D wave equation on h. Raindrops = impulse sources. Water surface over the image; caustic payoff below.
- **Gel**: thin-film / Hele-Shaw flow — sag under gravity vector, viscous healing after deformation. Viscosity knob spans water→gel→pitch. (Already sketched in Beyond Blender; the point here is it shares the same ping-pong substrate as ripple.)
- **Molten glass**: temperature field driving local viscosity → hot regions slump, cold regions freeze mid-flow. Annealing as an aesthetic.
- **Interaction**: pointer as physical agent — press dents gel, wipe clears fog, tap drops a pebble. The pane becomes an instrument you *touch*. This is likely the single highest-charm feature per unit effort.
- **Cheap tier**: time-domain-warped noise (scroll/rotate the fBm domain) for breathing frost — not physical, but free, and a good default "alive" idle state.

Determinism note: PDE + seeded impulses stays reproducible; interactive touches can record an event log so a performance re-renders offline at Tier 3 quality. **Touch live, cook later** — that's the offline-first stance meeting liveness without contradiction.

### Lensing — leaving the small-angle regime

Current shader is a *gather* with small offsets. Real lensing (strong curvature h) breaks it in exactly the interesting places:

- **Caustics** — focused light concentrates; gather can't brighten, only displace. Splatting (Tier 2) gets caustics for free: source pixels pile up where rays converge → bright filaments. Pool-floor light networks from the ripple sim above. This is the visual payoff that justifies building Tier 2.
- **Multi-valued mapping** — past the focal point the image inverts; a lens can show three images at once. Gather returns one sample; splatting naturally deposits all of them.
- **Magnification honesty** — surface brightness is conserved but flux concentrates; magnified regions shouldn't dim. Splatting with proper Jacobian weighting handles this by construction.
- **Preset shelf**: bull's-eye lens tiles, lenticular sheet (anti-lattice target: dequantized lenticulars — drifting pitch, meandering axes), Fresnel-lens concentric ridges, bathroom "pebbled" lens arrays, magnifier region as a movable prop.

Conclusion: lensing is not a new feature, it's the *argument for Tier 2*. Order of operations: splatting renderer first, then lensing presets fall out.

### The Gliese crossover — atmospheric & gravitational

Gliese already solved ray transport through a spherically-graded medium via velocity Verlet; the optical twin is direct:

- **Mirage / heat shimmer**: vertical n gradient (temperature) bends rays — inferior mirage doubles and inverts the low image. Turbulent shimmer = **Kolmogorov phase screens**, the exact artifact astronomy's adaptive-optics community simulates; animated drifting screens give physically-correct heat wobble and "seeing." Well-documented, cheap, and nobody's shipped it as a creative tool.
- **Atmospheric refraction set pieces**: sunset flattening, green flash dispersion, ducting (Gliese's sound channel as a light pipe — Novaya Zemlya effect, the sun visible after it's set). These are *presets with stories*, good for the tool's voice.
- **Gravitational**: mass map replaces heightmap. Point mass → Einstein ring, arcs, multiple images; moving mass → microlensing brightness transient sweeping across footage. Again multi-valued → again Tier 2 splatting. A painted mass map = "gravity brush."
- **Schlieren view**: render the *gradient field itself* (knife-edge schlieren aesthetic) as a display tab beside original/heightmap/aeropane. Diagnostic and gorgeous simultaneously.

Shared-code opportunity is real but modest — the Verlet integrator and the "physics params → field → render" architecture port; the media differ. Worth noting in DEPENDENCIES.md only if code actually gets shared.

### Diaphanous media shelf (beyond glass and gel)

Each candidate earns entry by having a *distinct scattering signature*, not just different knob values:

- **Soap film / oil slick** — thin-film interference: wavelength-scale thickness → iridescent color from h directly. Connects the wave-optics tier to a medium everyone knows. Thickness evolves by drainage flow (another PDE citizen).
- **Woven sheers** (organza, voile, silk) — anisotropic scattering along warp/weft + moiré between weave period and image. Anti-lattice again: real weave wanders.
- **Vellum / tracing paper / rice paper** — fiber scattering: zero refraction wobble, pure diffusion with contact-distance falloff. The "distance-dependent blur only" limit case; cheap, and the taxonomy's origin point.
- **Crumpled cellophane / plastic wrap** — sparse sharp creases: piecewise-flat h with specular fold lines. Distinct because energy lives in edges, not texture.
- **Turbid volume** (milk-in-water, fog slab) — no surface at all; multiple scattering depth. The Tier-3 slab already models this; the preset just sets surface roughness ≈ 0 and turns volume scattering up.
- **Stress birefringence** — the sleeper hit: photoelastic rainbow fringes (stressed acrylic between crossed polarizers). Physically: stress field → retardance → spectral transmission. A stress map is just another scalar field to author or derive from h. Nothing in the consumer-tool space does this; it's spectacular; it's genuinely physical.

Gate: one continuum, not modes (per Open questions instinct) — each medium above should be reachable by knob settings within the general model where possible, and only soap-film interference + birefringence truly require new shader terms.

### Smaller shelf

- **Glass stack**: compose multiple panes in sequence (frost behind reeded behind gel). Deflection fields compose by... not addition — sequential warping. An operator worth defining precisely once, early.
- **Dirty glass layer**: dust, fingerprint smears (anisotropic gloss kill), scratches (streak specular). Multiplies realism cheaply; pure texture authoring.
- **Feedback pane**: glass map driven by the image itself (already in Beyond Blender) — flag that the motion PDE makes this *temporal* feedback: footage frosting itself frame by frame.
- **Audio-reactive h**: drive ripple impulses from an audio track's onsets — music-video mode; family kinship with Kíkik's hit extraction.
- **Inverse problem**: given source and desired output, solve for the pane (deconvolution / optimization). "What glass turns A into B" — probably a research rabbit hole; shelf it consciously.

### Liquid Glass — shipped 2026-07-13

Priority #1 built. The pane can now be a body of water: `h(x,y,t)` evolved live by the 2-D wave equation on the GPU, feeding the refraction shader as the glass map.

- **Sim substrate**: ping-pong on a color-renderable float target (half-float preferred via `OES_texture_half_float` + `EXT_color_buffer_half_float`, float fallback, hard-disable with a UI notice if neither renders). State packed R=height, G=velocity; `CLAMP_TO_EDGE` gives reflective pool walls. This ping-pong FBO substrate is exactly what gel/thin-film/molten will reuse.
- **Integrator**: explicit velocity form — `vel += c²·laplacian; vel *= damp; h += vel`. Wave-speed knob is clamped to the CFL-stable `c² ≤ 0.49`; damping is the surface-tension/viscosity control. Coarse sim grid (long edge capped ~400) up-samples cleanly through the refractor since ripples are low-frequency — cheap and smooth.
- **Live loop**: `requestAnimationFrame`, 2 substeps/frame, renders the photo through the current surface each frame. A separate `heightAmpOverride` feeds the wave slope into the existing normal/refraction path (Distortion knob) so the static Map-Height control stays out of it.
- **Touch**: pointer down/drag on the canvas injects Gaussian impulses (aspect-corrected so drops stay round); **Drop** button = random splash, **Calm** = clear to flat, **Rain** = ambient jittered droplets. This is the "instrument you touch" hook from the motion notes.
- **Integration**: new `liquid` preset in the Material dropdown; entering swaps in a Liquid controls panel and takes over the canvas; Cook is bypassed (the live view *is* the render) and Save PNG grabs the current frame.
- **Verified**: half-float target selected, ring propagation lenses the image (≈6% of pixels shift over 30 steps, and visible concentric crests in a render capture), zero console errors. Note: rAF is paused in a hidden/occluded tab (headless verification had to pump the sim manually) — normal for a real viewer.
- **Deferred / next on this feature**: event-log record so a live performance re-renders offline at Tier-3 quality (the "touch live, cook later" contract); wire caustics once Tier 2 splatting lands (crests should *brighten*, not just displace); viscosity→gel via Hele-Shaw on the same substrate.

### Suggested priority (leverage per effort)

1. ~~**Ripple PDE + pointer interaction**~~ — **done 2026-07-13** (above)
2. **Tier 2 splatting** — unlocks caustics, lensing, gravitational, magnification honesty (the biggest single unlock)
3. **Kolmogorov phase screens** — heat shimmer/seeing, cheap, unique
4. **Deflection-field plugin refactor** — do it *when* adding source #2, not before
5. **Birefringence** — the standout medium addition
6. Gravitational mass maps, soap film, glass stack — after the above make them cheap

## Open questions

- Depth channel sourcing for distance-blur: monocular depth estimation in-browser (model weight cost?) vs authored/painted distance maps vs both. Painted maps may be the more *xyh* answer (a creative surface, not an oracle).
- Tier 2/3 cost on long clips — progress-bar UX makes it survivable, but need a frame-time reality check before promising Tier 3 on video.
- Grown frost: DLA (cheap, stringy) vs phase-field (expensive, true dendrites) — probably DLA first, phase-field as the summit.
- Does the gel branch split into its own sibling eventually, or stay a region of h-spectrum space? (Instinct: one tool, one continuum — the taxonomy *is* the anti-mode stance.)
- Blender parity harness: render matched scenes in Cycles as reference stills for eyeballing each tier. Worth doing early.
