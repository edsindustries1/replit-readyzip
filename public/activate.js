/**
 * Multi-Step Activation Funnel
 * Reads window.CHANNEL_CONFIG for per-channel branding.
 * Steps: 1=Enter Code → 2=Activating → 3=Call CTA
 */
(function () {
    'use strict';

    var cfg = window.CHANNEL_CONFIG || {};
    var service  = cfg.service  || 'Streaming Service';
    var logoUrl  = cfg.logoUrl  || '';
    var logoText = cfg.logoText || service;
    var bgColor  = cfg.bgColor  || '#0a0a2e';
    var accent   = cfg.accent   || '#6366f1';
    var btnText  = cfg.btnText  || '#ffffff';

    /* ── Apply CSS variables ── */
    document.documentElement.style.setProperty('--brand-bg',       bgColor);
    document.documentElement.style.setProperty('--brand-accent',   accent);
    document.documentElement.style.setProperty('--brand-btn-text', btnText);

    /* ── Build the 3-step HTML ── */
    document.body.innerHTML = [

        /* ── STEP 1: Enter Code ── */
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

        /* ── STEP 2: Activating / Loading ── */
        '<div class="funnel-step hidden" id="step-loading">',
        '  <div class="loading-inner">',
        '    <img class="loading-logo" id="lLogo" src="' + logoUrl + '" alt="' + service + '">',
        '    <div class="loading-logo-text" id="lLogoTxt">' + logoText + '</div>',
        '    <div class="loading-msg">Activating your ' + service + ' subscription&hellip;</div>',
        '    <div class="progress-track"><div class="progress-bar" id="progBar"></div></div>',
        '    <div class="loading-dots"><span></span><span></span><span></span></div>',
        '  </div>',
        '</div>',

        /* ── STEP 3: Phone Verification CTA ── */
        '<div class="funnel-step hidden" id="step-call">',
        '  <div class="call-card">',
        '    <div class="call-icon">&#9888;&#65039;</div>',
        '    <div class="call-badge">Verification Required</div>',
        '    <div class="call-title">Complete Your Activation</div>',
        '    <div class="call-sub">Your device needs phone verification to finish activating ' + service + '. Call our support team — it only takes a minute.</div>',
        '    <div class="call-number">+1 888 779 1904</div>',
        '    <a class="call-btn" href="tel:+18887791904" id="callBtn">',
        '      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">',
        '        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>',
        '      </svg>',
        '      Call Now to Verify',
        '    </a>',
        '    <div class="call-avail"><span class="live-dot"></span>Available 24/7 &mdash; Real People, Real Help</div>',
        '    <div class="call-disclaimer">Independent third-party support service. Not affiliated with or endorsed by ' + service + '.</div>',
        '  </div>',
        '</div>',

    ].join('\n');

    /* ── Logo fallback (both steps) ── */
    function logoFallback(imgId, txtId) {
        var img = document.getElementById(imgId);
        var txt = document.getElementById(txtId);
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
    function show(id) {
        var el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    }
    function hide(id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }

    /* ── Step 1 → Step 2 ── */
    document.getElementById('codeBtn').addEventListener('click', goToLoading);
    document.getElementById('codeInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') goToLoading();
    });

    function goToLoading() {
        hide('step-code');
        show('step-loading');

        /* Animate progress bar */
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                document.getElementById('progBar').style.width = '100%';
            });
        });

        /* Auto-advance to Step 3 after 3.2s */
        setTimeout(goToCall, 3200);
    }

    /* ── Step 2 → Step 3 ── */
    function goToCall() {
        hide('step-loading');
        show('step-call');
    }

    /* ── Google Ads conversion ── */
    document.getElementById('callBtn').addEventListener('click', function (e) {
        e.preventDefault();
        var url = this.href;
        var callback = function () { window.location = url; };
        if (typeof gtag === 'function') {
            gtag('event', 'conversion', {
                'send_to': 'AW-11546748562/0VO9CImIrfsbEJLN9YEr',
                'value': 1.0,
                'currency': 'INR',
                'event_callback': callback
            });
        } else {
            callback();
        }
    });

})();
