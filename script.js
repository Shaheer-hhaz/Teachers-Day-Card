/* ============================================================
   INTERACTIVE PHYSICS GREETING CARD
   ──────────────────────────────────
   A spring-damper rotational physics simulation driving a
   CSS 3D greeting-card that opens via drag / swipe.
   
   Physics model:
     α = ( -k·(θ − θ_target) − c·ω + τ_boundary ) / I
     ω += α · Δt          (semi-implicit Euler)
     θ += ω · Δt

   θ  = card opening angle (degrees)
   ω  = angular velocity   (deg/s)
   I  = rotational inertia
   c  = damping coefficient
   k  = spring stiffness
   ============================================================ */

(function () {
    'use strict';

    // ========================================================
    // 1.  CONFIGURATION — tune these for the desired feel
    // ========================================================

    const PHYSICS = {
        INERTIA:              1.0,     // I   — moment of inertia (higher = heavier)
        DAMPING:              4.8,     // c   — damping coefficient
        SPRING_STIFFNESS:     7.5,     // k   — spring pull toward resting angle
        BOUNDARY_STIFFNESS:   18.0,    // extra spring at min/max limits
        MAX_ANGLE:            180,     // degrees — fully open
        MIN_ANGLE:            0,       // degrees — fully closed
        SNAP_THRESHOLD:       50,      // angle (°) — above = spring to open
        VELOCITY_SNAP:        100,     // °/s  — velocity that overrides angle snap
        SETTLE_VELOCITY:      0.25,    // °/s  — below = "at rest"
        SETTLE_ANGLE:         0.4,     // °    — proximity to target = settled
        DRAG_SENSITIVITY:     0.85,    // fraction of cover-width = 180°
        MAX_DT:               0.045,   // seconds — clamp Δt to avoid explosions
    };

    const VISUAL = {
        CLOSED_SCALE_DESKTOP: 1.15,
        CLOSED_SCALE_MOBILE:  1.20,
    };

    // ========================================================
    // 2.  STATE MACHINE
    // ========================================================

    const State = Object.freeze({
        CLOSED:     'CLOSED',
        DRAGGING:   'DRAGGING',
        SIMULATING: 'SIMULATING',
        OPEN:       'OPEN',
    });

    let state = State.CLOSED;

    // ========================================================
    // 3.  PHYSICS STATE
    // ========================================================

    let angle           = 0;    // current opening angle (degrees)
    let angularVelocity = 0;    // °/s
    let targetAngle     = 0;    // where the spring pulls

    // ========================================================
    // 4.  DRAG STATE
    // ========================================================

    let dragStartX       = 0;
    let dragStartAngle   = 0;
    let dragSensitivity  = 200;   // pixels for 180° — recalculated each drag
    let velocitySamples  = [];    // {angle, time} for release-velocity estimation
    const MAX_SAMPLES    = 6;
    const SAMPLE_WINDOW  = 120;   // ms — only use samples within this window

    // ========================================================
    // 5.  DOM REFERENCES
    // ========================================================

    const card        = document.getElementById('card');
    const cardWrapper = document.getElementById('cardWrapper');
    const cardCover   = document.getElementById('cardCover');
    const cardBase    = document.getElementById('cardBase');
    const dragHint    = document.getElementById('dragHint');
    const easterEgg   = document.getElementById('easterEgg');
    const foldShadowL = cardBase.querySelector('.fold-shadow.left');
    const foldShadowR = document.querySelector('.cover-back .fold-shadow.right');

    // ========================================================
    // 6.  ANIMATION FRAME STATE
    // ========================================================

    let lastFrameTime    = 0;
    let animFrameId      = null;
    let hasInteracted    = false; // first interaction hides hint
    let audioCtx         = null;  // lazy Web Audio context

    // ========================================================
    // 7.  HELPERS
    // ========================================================

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function degToRad(d) { return d * Math.PI / 180; }

    /** Effective closed scale from CSS custom property */
    function getClosedScale() {
        const cs = getComputedStyle(document.documentElement)
                      .getPropertyValue('--closed-scale');
        return parseFloat(cs) || VISUAL.CLOSED_SCALE_DESKTOP;
    }

    // ========================================================
    // 8.  POINTER INPUT  (unified: mouse + touch + pen)
    // ========================================================

    function attachPointerListeners(el) {
        el.addEventListener('pointerdown', onPointerDown, { passive: false });
    }

    // Attach to both cover and base so the user can
    // drag from either side (open / close).
    attachPointerListeners(cardCover);
    attachPointerListeners(cardBase);

    // Shared move / up handlers bound to `document` once active
    let activePointerId = null;
    let captureTarget   = null;

    function onPointerDown(e) {
        if (activePointerId !== null) return; // already tracking a pointer
        e.preventDefault();

        activePointerId = e.pointerId;
        captureTarget   = this;

        // Initialize audio on first user interaction
        initAudio();

        // Capture pointer for reliable tracking even outside the element
        try { this.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }

        // Listeners on the capturing element (pointer-capture delivers here)
        this.addEventListener('pointermove',   onPointerMove, { passive: false });
        this.addEventListener('pointerup',     onPointerUp);
        this.addEventListener('pointercancel', onPointerUp);
        this.addEventListener('lostpointercapture', onPointerUp);

        startDrag(e);
    }

    function onPointerMove(e) {
        if (e.pointerId !== activePointerId) return;
        e.preventDefault();
        processDrag(e);
    }

    function onPointerUp(e) {
        if (e.pointerId !== activePointerId && e.type !== 'lostpointercapture') return;

        const el = captureTarget;
        if (el) {
            el.removeEventListener('pointermove',          onPointerMove);
            el.removeEventListener('pointerup',            onPointerUp);
            el.removeEventListener('pointercancel',        onPointerUp);
            el.removeEventListener('lostpointercapture',   onPointerUp);
            try { el.releasePointerCapture(activePointerId); } catch (_) { /* ok */ }
        }

        endDrag();
        activePointerId = null;
        captureTarget   = null;
    }

    // ========================================================
    // 9.  DRAG CALCULATIONS
    // ========================================================

    let lastDragSoundTime = 0;

    function startDrag(e) {
        // First interaction: hide hint
        if (!hasInteracted) {
            hasInteracted = true;
            dragHint.classList.add('hidden');
        }

        // Record starting state
        dragStartX     = e.clientX;
        dragStartAngle = angle;

        // Sensitivity: how many pixels = full 180° rotation
        // Based on the card-base width (which doesn't rotate)
        const baseRect   = cardBase.getBoundingClientRect();
        dragSensitivity  = Math.max(baseRect.width * PHYSICS.DRAG_SENSITIVITY, 60);

        // Clear velocity samples
        velocitySamples = [];
        addVelocitySample(angle, e.timeStamp);

        // Cancel any running simulation
        angularVelocity = 0;
        state = State.DRAGGING;

        // Play drag sound sparingly
        const now = performance.now();
        if (now - lastDragSoundTime > 600) {
            playSound('drag');
            lastDragSoundTime = now;
        }

        // Remove settled classes (enable re-opening / re-closing)
        card.classList.remove('is-open');
    }

    function processDrag(e) {
        if (state !== State.DRAGGING) return;

        // Horizontal displacement: positive = moving LEFT = opening
        const deltaX = dragStartX - e.clientX;

        // Convert to angle change
        let raw = dragStartAngle + (deltaX / dragSensitivity) * PHYSICS.MAX_ANGLE;

        // Rubber-band at limits
        if (raw < PHYSICS.MIN_ANGLE) {
            raw = PHYSICS.MIN_ANGLE + (raw - PHYSICS.MIN_ANGLE) * 0.25;
        }
        if (raw > PHYSICS.MAX_ANGLE) {
            raw = PHYSICS.MAX_ANGLE + (raw - PHYSICS.MAX_ANGLE) * 0.25;
        }

        angle = raw;
        addVelocitySample(angle, e.timeStamp);
        renderCard();
    }

    // ========================================================
    // 10. VELOCITY TRACKING  (rolling window)
    // ========================================================

    function addVelocitySample(a, t) {
        velocitySamples.push({ angle: a, time: t });
        if (velocitySamples.length > MAX_SAMPLES) velocitySamples.shift();
    }

    /** Estimate angular velocity (°/s) from recent drag samples. */
    function getTrackedVelocity() {
        const now = performance.now();

        // Keep only recent samples within the time window
        const recent = velocitySamples.filter(s => now - s.time < SAMPLE_WINDOW);
        if (recent.length < 2) return 0;

        const first = recent[0];
        const last  = recent[recent.length - 1];
        const dt    = (last.time - first.time) / 1000;
        if (dt < 0.005) return 0;

        return (last.angle - first.angle) / dt;
    }

    // ========================================================
    // 11. RELEASE LOGIC
    // ========================================================

    function endDrag() {
        if (state !== State.DRAGGING) return;

        // Measure release velocity
        angularVelocity = getTrackedVelocity();

        // Decide target angle based on position + velocity
        targetAngle = determineTarget();

        // Transition to simulation
        state = State.SIMULATING;
        lastFrameTime = performance.now();
        ensureAnimLoop();
    }

    /**
     * Determine where the card should settle.
     * Fast swipe overrides angle-based threshold.
     */
    function determineTarget() {
        // A strong swipe overrides the angle position
        if (angularVelocity >  PHYSICS.VELOCITY_SNAP) return PHYSICS.MAX_ANGLE;
        if (angularVelocity < -PHYSICS.VELOCITY_SNAP) return PHYSICS.MIN_ANGLE;

        // Otherwise go by angle position
        return angle > PHYSICS.SNAP_THRESHOLD ? PHYSICS.MAX_ANGLE : PHYSICS.MIN_ANGLE;
    }

    // ========================================================
    // 12. PHYSICS SIMULATION
    // ========================================================

    /**
     * Advance the spring-damper simulation by `dt` seconds.
     *
     *   spring force  =  -k · (θ − θ_target)
     *   damping force =  -c · ω
     *   boundary force = extra repulsion at min/max limits
     *
     *   α  = (spring + damping + boundary) / I
     *   ω += α · dt       (semi-implicit Euler)
     *   θ += ω · dt
     */
    function simulate(dt) {
        // Spring force toward target resting angle
        const springForce  = -PHYSICS.SPRING_STIFFNESS * (angle - targetAngle);

        // Viscous damping proportional to velocity
        const dampingForce = -PHYSICS.DAMPING * angularVelocity;

        // Hard boundary forces (prevent exceeding physical limits)
        let boundaryForce = 0;
        if (angle < PHYSICS.MIN_ANGLE) {
            boundaryForce = PHYSICS.BOUNDARY_STIFFNESS * (PHYSICS.MIN_ANGLE - angle);
        } else if (angle > PHYSICS.MAX_ANGLE) {
            boundaryForce = PHYSICS.BOUNDARY_STIFFNESS * (PHYSICS.MAX_ANGLE - angle);
        }

        // Newton's second law for rotation:  τ = I·α
        const angularAccel = (springForce + dampingForce + boundaryForce) / PHYSICS.INERTIA;

        // Semi-implicit Euler integration
        angularVelocity += angularAccel * dt;
        angle           += angularVelocity * dt;

        // Check if the system has settled
        const nearTarget   = Math.abs(angle - targetAngle) < PHYSICS.SETTLE_ANGLE;
        const almostStill  = Math.abs(angularVelocity)     < PHYSICS.SETTLE_VELOCITY;

        if (nearTarget && almostStill) {
            angle           = targetAngle;
            angularVelocity = 0;

            if (targetAngle >= PHYSICS.MAX_ANGLE - 1) {
                state = State.OPEN;
                onCardOpened();
            } else if (targetAngle <= PHYSICS.MIN_ANGLE + 1) {
                state = State.CLOSED;
                onCardClosed();
            }
        }
    }

    // ========================================================
    // 13. CARD RENDERING
    // ========================================================

    /**
     * Apply the current angle to CSS transforms and shadows.
     * All visual updates happen here — called every frame.
     */
    function renderCard() {
        // Clamp visual rotation at 0 to prevent the cover from clipping through the base (Bug 1)
        const a        = clamp(angle, PHYSICS.MIN_ANGLE, PHYSICS.MAX_ANGLE + 8);
        const progress = clamp(a / PHYSICS.MAX_ANGLE, 0, 1);      // 0 → 1
        const aRad     = degToRad(a);

        // ── Cover rotation ──
        cardCover.style.transform = `rotateY(${-a}deg)`;

        // ── Scene scale + horizontal shift ──
        // When closed (progress=0): scale up, shift left 25% to center cover
        // When open   (progress=1): scale 1, no shift (both pages centred)
        const closedScale = getClosedScale();
        const scale       = 1 + (closedScale - 1) * (1 - progress);
        const shiftPct    = -(1 - progress) * 25;   // % of card container width
        cardWrapper.style.transform =
            `translateX(${shiftPct}%) scale(${scale})`;

        // ── Fold shadows (peak at 90°) ──
        const shadowFactor = Math.sin(aRad);
        if (foldShadowL) foldShadowL.style.opacity = shadowFactor * 0.9;
        if (foldShadowR) foldShadowR.style.opacity = shadowFactor * 0.9;

        // ── Cover drop-shadow (the shadow the cover casts on "the table") ──
        // Moves & intensifies as the cover lifts off the base.
        // Applied to coverFront's box-shadow to avoid flattening cardCover's 3D context (Bug 2)
        const shadowOffX   = -(shadowFactor * 10).toFixed(1);
        const shadowBlur   = (shadowFactor * 22).toFixed(1);
        const shadowAlpha  = Math.max(0, shadowFactor * 0.28).toFixed(2);
        document.getElementById('coverFront').style.boxShadow = 
            `${shadowOffX}px 3px ${shadowBlur}px rgba(0,0,0,${shadowAlpha}), inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(0,0,0,0.15)`;
    }

    // ========================================================
    // 14. ANIMATION LOOP (requestAnimationFrame)
    // ========================================================

    function animLoop(timestamp) {
        animFrameId = null;

        if (state === State.SIMULATING) {
            // Delta-time with clamp to avoid physics explosions
            const dt = Math.min((timestamp - lastFrameTime) / 1000, PHYSICS.MAX_DT);
            lastFrameTime = timestamp;

            simulate(dt);
            renderCard();
            ensureAnimLoop();
        }
        // If state changed to OPEN/CLOSED during simulate(), loop stops naturally
    }

    function ensureAnimLoop() {
        if (animFrameId === null) {
            animFrameId = requestAnimationFrame(animLoop);
        }
    }

    // ========================================================
    // 15. STATE TRANSITIONS  (open / close callbacks)
    // ========================================================

    function onCardOpened() {
        card.classList.add('is-open');
        playSound('settle_open');
    }

    function onCardClosed() {
        card.classList.remove('is-open');
        playSound('settle_close');
        // Re-show hint if no further interaction
        // (keep hidden if user has already interacted)
    }

    // ========================================================
    // 16. OPTIONAL AUDIO — procedural "paper" sound
    //     Triggered ONLY after user interaction (no autoplay)
    // ========================================================

    let audioUnlocked = false;

    function initAudio() {
        if (audioUnlocked) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            // Play a silent buffer to unlock on mobile/safari
            const buffer = audioCtx.createBuffer(1, 1, 22050);
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(audioCtx.destination);
            source.start();
            audioUnlocked = true;
        } catch (_) {}
    }

    function playSound(type) {
        if (!audioUnlocked || !audioCtx) return;
        
        try {
            const sr = audioCtx.sampleRate;
            let duration = 0.1;
            let freq = 2000;
            let q = 0.5;
            let volume = 0.05;
            let noiseType = 'bandpass';
            
            if (type === 'drag') {
                duration = 0.35;
                freq = 1400;
                volume = 0.025;
                q = 0.3;
            } else if (type === 'settle_open') {
                duration = 0.15;
                freq = 2800;
                volume = 0.02;
                q = 0.8;
            } else if (type === 'settle_close') {
                duration = 0.18;
                freq = 700; // deeper thud
                volume = 0.035;
                q = 0.8;
                noiseType = 'lowpass';
            }
            
            const len = Math.floor(sr * duration);
            const buffer = audioCtx.createBuffer(1, len, sr);
            const data = buffer.getChannelData(0);
            
            for (let i = 0; i < len; i++) {
                const t = i / sr;
                let env = 1;
                if (type === 'drag') {
                    env = Math.exp(-t * 12) * (1 - Math.exp(-t * 60)); // soft attack
                } else {
                    env = Math.exp(-t * 30); // sharp decay
                }
                data[i] = (Math.random() * 2 - 1) * env * volume;
            }
            
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            
            const filter = audioCtx.createBiquadFilter();
            filter.type = noiseType;
            filter.frequency.value = freq;
            filter.Q.value = q;
            
            source.connect(filter);
            filter.connect(audioCtx.destination);
            source.start();
            
            source.onended = () => {
                source.disconnect();
                filter.disconnect();
            };
        } catch (e) {}
    }

    // ========================================================
    // 17. SHOOTING STARS
    // ========================================================

    function spawnShootingStar() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        
        const bg = document.querySelector('.bg');
        if (!bg) return;
        
        const star = document.createElement('div');
        star.classList.add('shooting-star');
        
        // Spawn predominantly in upper/right areas to drift diagonally left/down
        const top = Math.random() * 45;
        const left = 40 + Math.random() * 60;
        
        star.style.top = `${top}%`;
        star.style.left = `${left}%`;
        
        const duration = 1.8 + Math.random() * 1.5;
        star.style.animationDuration = `${duration}s`;
        
        const width = 60 + Math.random() * 80;
        star.style.width = `${width}px`;
        
        bg.appendChild(star);
        
        setTimeout(() => {
            if (star.parentNode) star.parentNode.removeChild(star);
        }, duration * 1000 + 100);
        
        // Very rare, subtle frequency
        const nextSpawn = 5000 + Math.random() * 10000;
        setTimeout(spawnShootingStar, nextSpawn);
    }

    // ========================================================
    // 17. INITIALISATION
    // ========================================================

    function init() {
        // Set initial visual state
        angle           = PHYSICS.MIN_ANGLE;
        angularVelocity = 0;
        targetAngle     = PHYSICS.MIN_ANGLE;
        state           = State.CLOSED;
        renderCard();

        // Start subtle shooting stars
        setTimeout(spawnShootingStar, 3000);
    }

    init();

})();
