'use strict';

var libQ = require('kew');
var fs=require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
const { loginDeviceByIp, turnOn, turnOff, getDeviceInfo } = require('tp-link-tapo-connect');

const io = require('socket.io-client');
const sleep = require('sleep');
var socket = null;

// State enum
const STATE = {
	PLAY: "play",
	PAUSE: "pause",
	STOP: "stop"
};


module.exports = tapocontroller;
function tapocontroller(context) {
	var self = this;

	this.context = context;
	this.commandRouter = this.context.coreCommand;
	this.logger = this.context.logger;
	this.configManager = this.context.configManager;
	this.previousState = { status: "" };
	this.switchStarted = false;
	this.IdleStartTime = Date.now();
	this.idleTimer = null; // Initialize timer variable
	
}

tapocontroller.prototype.onVolumioStart = function()
{
	var self = this;
	var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
	this.config = new (require('v-conf'))();
	this.config.loadFile(configFile);

    return libQ.resolve();
}
tapocontroller.prototype.onStart = function() {
    var self = this;
	var defer=libQ.defer();
    self.logger.info("Tapocontroller started");
	socket = io.connect("http://localhost:3000");

	// read and parse status once
	self.logger.info("Requesting initial state from Volumio");
	socket.emit("getState", "");
	socket.once("pushState", self.statusChanged.bind(self));
	socket.on("pushState", self.statusChanged.bind(self));

	loginDeviceByIp(this.config.get('tapoEmail'), this.config.get('tapoPassword'), this.config.get('tapoIp')).then((deviceToken) => {
		self.logger.info("Device token obtained");
		this.device = deviceToken;
		
		// Start the continuous timer loop to check idle timeout
		self.startIdleTimeoutCheck();
		
	  	defer.resolve();

	}).catch((error) => {
		self.logger.error("Error logging in: " + error);
	});

    return defer.promise;
};

tapocontroller.prototype.onStop = function() {
    var self = this;
    var defer=libQ.defer();
    self.logger.info("Tapocontroller stopped");
    
    // Clear the idle timeout timer
    if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
    }
    
 	defer.resolve();
    return defer.promise;
};

tapocontroller.prototype.startIdleTimeoutCheck = function() {
    var self = this;
    
    // Clear any existing timer
    if (this.idleTimer) {
        clearInterval(this.idleTimer);
    }
    
    // Start a timer that checks every 5 seconds
    this.idleTimer = setInterval(function() {
        self.checkIdleTimeout();
    }, 5000); // Check every 5 seconds
    
    self.logger.info("Idle timeout check started - checking every 5 seconds");
};

tapocontroller.prototype.checkIdleTimeout = function() {
    var self = this;

    if (this.switchStarted && this.IdleStartTime != null) {
        var currentTime = Date.now();
        var idleTimeSeconds = Math.floor((currentTime - this.IdleStartTime) / 1000);
        var timeoutSeconds = this.config.get('IdleOffTimeOut') || 10;
        
        self.logger.info(`Idle check - switchStarted: ${this.switchStarted}, idle time: ${idleTimeSeconds}s, timeout: ${timeoutSeconds}s`);
        
        if (idleTimeSeconds > timeoutSeconds) {
            self.logger.info(`Idle timeout exceeded (${idleTimeSeconds}s > ${timeoutSeconds}s) - turning off device`);
            
            this.device.turnOff().then(() => {
                self.logger.info("Device turned off due to idle timeout");
                this.switchStarted = false;
                this.IdleStartTime = null;
            }).catch((error) => {
                self.logger.error("Error turning off device: " + error);
            });
        }
    }
};

tapocontroller.prototype.TapoStart = function() {
    var self = this;
	
	this.IdleStartTime = null;
	if(!this.switchStarted)
	{
		this.device.turnOn().then(() => {
				self.logger.info("Device turned on successfully");
		});
		this.switchStarted = true;
		
	}
};

tapocontroller.prototype.TapoStop = function() {
	this.IdleStartTime = Date.now();
}

tapocontroller.prototype.statusChanged = function(state) {
	const self = this;

	self.logger.info("=== statusChanged function called ===");
	self.logger.info("Received state: " + JSON.stringify(state));
	self.logger.info("Previous state: " + JSON.stringify(self.previousState));
	self.logger.info(`Current status: ${state.status}`);
	self.logger.info(`Previous status: ${self.previousState.status}`);

	// Player status
	if (state.status == STATE.PLAY && self.previousState.status != STATE.PLAY){
		self.logger.info("TAPO PLAY - Turning device ON");

		this.TapoStart();

	}
	if (state.status == STATE.PAUSE && self.previousState.status != STATE.PAUSE){
		self.logger.info("TAPO PAUSE");
		this.TapoStop();
	}
	if (state.status == STATE.STOP && self.previousState.status != STATE.STOP){
		self.logger.info("TAPO STOP - Turning device OFF");

		this.TapoStop();
	}

	// Remember previous state
	self.previousState = state;
	self.logger.info("Updated previousState to: " + JSON.stringify(self.previousState));
};


tapocontroller.prototype.onRestart = function() {
    var self = this;
    // Optional, use if you need it
};


tapocontroller.prototype.saveOptions = function (data) {
	const self = this;

	this.logger.info('tapoController - saving settings');

	this.config.set('tapoEmail', data['tapoEmail'] || '');
	this.config.set('tapoPassword', data['tapoPassword'] || '');
	this.config.set('tapoIp', data['tapoIp'] || '192.168.1.96');
	this.config.set('IdleOffTimeOut', data['IdleOffTimeOut'] || 10);

	this.commandRouter.pushToastMessage('success', 'tapoController', this.commandRouter.getI18nString("COMMON.CONFIGURATION_UPDATE_DESCRIPTION"));

	this.logger.info('tapoController - settings saved');

	return libQ.resolve();
};

// Configuration Methods -----------------------------------------------------------------------------

tapocontroller.prototype.getUIConfig = function() {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf)
        {
            uiconf.sections[0].content[0].value = self.config.get('tapoEmail');
            uiconf.sections[0].content[1].value = self.config.get('tapoPassword');
            uiconf.sections[0].content[2].value = self.config.get('tapoIp');
			uiconf.sections[0].content[3].value = self.config.get('IdleOffTimeOut');

            defer.resolve(uiconf);
        })
        .fail(function()
        {
            defer.reject(new Error());
        });

    return defer.promise;
};

tapocontroller.prototype.getConfigurationFiles = function() {
	return ['config.json'];
}

tapocontroller.prototype.setUIConfig = function(data) {
	var self = this;
	//Perform your installation tasks here
};

tapocontroller.prototype.getConf = function(varName) {
	var self = this;
	//Perform your installation tasks here
};

tapocontroller.prototype.setConf = function(varName, varValue) {
	var self = this;
	//Perform your installation tasks here
};



// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it


tapocontroller.prototype.addToBrowseSources = function () {

	// Use this function to add your music service plugin to music sources
    //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
    this.commandRouter.volumioAddToBrowseSources(data);
};

tapocontroller.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    //self.commandRouter.logger.info(curUri);
    var response;


    return response;
};



// Define a method to clear, add, and play an array of tracks
tapocontroller.prototype.clearAddPlayTrack = function(track) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::clearAddPlayTrack');

	self.commandRouter.logger.info(JSON.stringify(track));

	return self.sendSpopCommand('uplay', [track.uri]);
};

tapocontroller.prototype.seek = function (timepos) {
    this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::seek to ' + timepos);

    return this.sendSpopCommand('seek '+timepos, []);
};

// Stop
tapocontroller.prototype.stop = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::stop');


};

// Spop pause
tapocontroller.prototype.pause = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::pause');


};

// Get state
tapocontroller.prototype.getState = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::getState');


};

//Parse state
tapocontroller.prototype.parseState = function(sState) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::parseState');

	//Use this method to parse the state and eventually send it with the following function
};

// Announce updated State
tapocontroller.prototype.pushState = function(state) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'tapocontroller::pushState');

	return self.commandRouter.servicePushState(state, self.servicename);
};


tapocontroller.prototype.explodeUri = function(uri) {
	var self = this;
	var defer=libQ.defer();

	// Mandatory: retrieve all info for a given URI

	return defer.promise;
};

tapocontroller.prototype.getAlbumArt = function (data, path) {

	var artist, album;

	if (data != undefined && data.path != undefined) {
		path = data.path;
	}

	var web;

	if (data != undefined && data.artist != undefined) {
		artist = data.artist;
		if (data.album != undefined)
			album = data.album;
		else album = data.artist;

		web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
	}

	var url = '/albumart';

	if (web != undefined)
		url = url + web;

	if (web != undefined && path != undefined)
		url = url + '&';
	else if (path != undefined)
		url = url + '?';

	if (path != undefined)
		url = url + 'path=' + nodetools.urlEncode(path);

	return url;
};





tapocontroller.prototype.search = function (query) {
	var self=this;
	var defer=libQ.defer();

	// Mandatory, search. You can divide the search in sections using following functions

	return defer.promise;
};

tapocontroller.prototype._searchArtists = function (results) {

};

tapocontroller.prototype._searchAlbums = function (results) {

};

tapocontroller.prototype._searchPlaylists = function (results) {


};

tapocontroller.prototype._searchTracks = function (results) {

};

tapocontroller.prototype.goto=function(data){
    var self=this
    var defer=libQ.defer()

// Handle go to artist and go to album function

     return defer.promise;
};
