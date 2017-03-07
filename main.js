var fs = require('fs');
var https = require('https');
var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');
var crypto = require('crypto');
var macaroons = require('macaroons.js');
var pathToRegexp = require('path-to-regexp');
var basicAuth = require('basic-auth');
var baseCat = require('./base-cat.json');

var PORT = process.env.PORT || 8080;

var HTTPS_SERVER_CERT = process.env.HTTPS_SERVER_CERT || '';
var HTTPS_SERVER_PRIVATE_KEY = process.env.HTTPS_SERVER_PRIVATE_KEY || '';

var CM_KEY = process.env.CM_KEY || '';

var containers = {};

var app = express();

var credentials = {
	key:  HTTPS_SERVER_PRIVATE_KEY,
	cert: HTTPS_SERVER_CERT,
};

// TODO: Check
app.enable('trust proxy');
app.disable('x-powered-by');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
	extended: true
}));

app.get('/status', function(req, res){
	res.send('active');
});

/**********************************************************/

app.all([ '/cat', '/token', '/store/*', '/cm/*'], function (req, res, next) {
	var creds = basicAuth(req);
	var key = req.get('X-Api-Key') || (creds && creds.name);

	if (!key) {
		res.status(401).send('Missing API key');
		return;
	}

	req.key = key;

	for (name in containers) {
		var container = containers[name];
		if (!container.key || container.key !== key)
			continue;
		req.container = container;
		break;
	}

	next();
});

/**********************************************************/

app.all('/cm/*', function (req, res, next) {
	if (req.key !== CM_KEY) {
		res.status(401).send('Unauthorized: Arbiter key invalid');
		return;
	}
	next();
});

/**********************************************************/

app.post('/cm/upsert-container-info', function (req, res) {
	var data = req.body;

	if (data == null || !data.name) {
		res.status(400).send('Missing parameters');
		return;
	}

	// TODO: Store in a DB maybe? Probably not.
	if (data.type === 'store' && (!(data.name in containers) || containers[data.name].type !== 'store')) {
		containers[data.name] = {
			catItem: {
				'item-metadata': [
					{
						rel: 'urn:X-hypercat:rels:isContentType',
						val: 'application/vnd.hypercat.catalogue+json'
					},
					{
						rel: 'urn:X-hypercat:rels:hasDescription:en',
						val: data.name
					}
				],
				href: 'https://' + data.name + ':8080'
			}
		};
	} else {
		containers[data.name] = {}
	}

	// TODO: Restrict POSTed data to namespace (else can overwrite catItem)
	for(var key in data) {
		containers[data.name][key] = data[key];
	}

	res.json(containers[data.name]);
});

/**********************************************************/

app.post('/cm/delete-container-info', function (req, res) {
	var data = req.body;

	if (data == null || !data.name) {
		res.status(400).send('Missing parameters');
		return;
	}

	// TODO: Error if it wasn't there to begin with?
	delete containers[data.name];

	res.send();
});

/**********************************************************/

app.post('/cm/grant-container-permissions', function (req, res) {
	var data = req.body;

	// TODO: Allow all at once?
	if (data == null || !data.name || !data.route || !data.route.target || !data.route.path || !data.route.method) {
		res.status(400).send('Missing parameters');
		return;
	}

	var route = JSON.stringify({
		target: data.route.target,
		path:   data.route.path,
		method: data.route.method
	});

	var pathMapHash = JSON.stringify({
		target: data.route.target,
		method: data.route.method
	});

	// TODO: Error if not yet in in records?
	var container = containers[data.name] = containers[data.name] || { name: data.name };
	container.caveats = container.caveats || {};
	var caveats = container.caveats[route] = container.caveats[route] || [];
	// NOTE: Separate map for constant time instead of O(N)
	container.paths = container.paths || {};
	container.paths[pathMapHash] = container.paths[pathMapHash] || [];
	container.paths[pathMapHash].push({
		string: data.route.path,
		regExp: pathToRegexp(data.route.path)
	});

	if (!data.caveats) {
		res.json(caveats);
		return;
	}

	Array.prototype.push.apply(caveats, data.caveats);
	res.json(caveats);
});

/**********************************************************/

app.post('/cm/revoke-container-permissions', function (req, res) {
	var data = req.body;

	if (data == null || !data.name || !data.route || !data.route.target || !data.route.path || !data.route.method) {
		res.status(400).send('Missing parameters');
		return;
	}

	var route = JSON.stringify({
		target: data.route.target,
		path:   data.route.path,
		method: data.route.method
	});

	var pathMapHash = JSON.stringify({
		target: data.route.target,
		method: data.route.method
	});

	// TODO: Error if not yet in in records?
	var container = containers[data.name] = containers[data.name] || { name: data.name };
	container.caveats = container.caveats || {};
	container.caveats[route] = container.caveats[route] || [];
	// NOTE: Separate map for constant time instead of O(N)
	container.paths = container.paths || {};
	container.paths[pathMapHash] = container.paths[pathMapHash] || [];
	var wanted = pathToRegexp(data.route.path);
	container.paths[pathMapHash] = container.paths[pathMapHash].filter(path => !wanted.test(path.string));

	if (!data.caveats || !data.caveats.length || data.caveats.length < 1) {
		delete container.caveats[route];
		res.json(null);
		return;
	}

	res.json(container.caveats[route] = container.caveats[route].filter(caveat => !data.caveats.includes(caveat)));
});

/**********************************************************/

// Serve root Hypercat catalogue
app.get('/cat', function(req, res){
	var cat = JSON.parse(JSON.stringify(baseCat));

	for (var name in containers) {
		var container = containers[name];
		// TODO: If CM, show all
		// TODO: Hide items based on container permissions
		// TODO: If discoverable, but not accessible, inform as per PAS 7.3.1.2
		if(container.catItem) {
			cat.items.push(container.catItem);
		}
	}

	res.json(cat);
});

/**********************************************************/

app.post('/token', function(req, res){
	if (!req.container) {
		// NOTE: This can also happen if the CM never uploaded store key
		//       or if the CM added routes and never upserted info
		//       but should never happen if the CM is up to spec.
		res.status(401).send('Invalid API key');
		return;
	}

	var data = req.body;

	if (data == null || !data.target || !data.path || !data.method) {
		res.status(400).send('Missing parameters');
		return;
	}

	var targetContainer = containers[data.target];

	if (typeof(targetContainer) == "undefined" && !targetContainer) {
		res.status(400).send("Target " + data.target + " has not been approved for arbitering");
		return;
	}

	if (!targetContainer.secret) {
		res.status(400).send("Target " + data.target + " has not registered itself for arbitering");
		return;
	}

	var route = JSON.stringify({
		target: data.target,
		path:   data.path,
		method: data.method
	});

	var pathMapHash = JSON.stringify({
		target: data.target,
		method: data.method
	});

	var container = req.container;
	container.caveats = container.caveats || {};
	container.paths = container.paths || {};
	container.paths[pathMapHash] = container.paths[pathMapHash] || [];

	if (!(route in container.caveats) && !container.paths[pathMapHash].find((path) => path.regExp.test(data.path))) {
		res.status(401).send("Insufficient route permissions");
		return;
	}

	crypto.randomBytes(32, function(err, buffer){
		// TODO: Get hostname from environment variable instead of hardcoding
		var mb = new macaroons.MacaroonsBuilder('https://databox-arbiter:' + PORT, targetContainer.secret, buffer.toString('base64'));
		mb
			.add_first_party_caveat('target = ' + data.target)
			.add_first_party_caveat('path = ' + data.path)
			.add_first_party_caveat('method = ' + data.method);
		if (route in container.caveats)
			for (const caveat of container.caveats[route])
				mb.add_first_party_caveat(caveat);
		res.send(mb.getMacaroon().serialize());
	});
});

/**********************************************************/

app.get('/store/secret', function (req, res) {
	if (!req.container) {
		// NOTE: This can also happen if the CM never uploaded store key
		//       or if the CM added routes and never upserted info
		//       but should never happen if the CM is up to spec.
		res.status(401).send('Invalid API key');
		return;
	}

	if (!req.container.type) {
		// NOTE: This should never happen if the CM is up to spec.
		res.status(500).send('Container type unknown by arbiter');
		return;
	}

	if (req.container.type !== 'store') {
		res.status(403).send('Container type "' + req.container.type + '" cannot use arbiter token minting capabilities as it is not a store type');
		return;
	}

	if (req.container.secret) {
		res.status(409).send('Store shared secret already retrieved');
		return;
	}

	crypto.randomBytes(macaroons.MacaroonsConstants.MACAROON_SUGGESTED_SECRET_LENGTH, function(err, buffer){
		if (err != null) {
			res.status(500).send('Unable to register container (secret generation)');
			return;
		}

		req.container.secret = buffer;
		res.send(buffer.toString('base64'));
	});
});

https.createServer(credentials, app).listen(PORT);

module.exports = app;
