'use strict';

/****************************************************************************
 * Public interface
 ****************************************************************************/

// Called when a message is received. Host can check message.clientId for sender.
var onMessageReceived;
// Called when a data channel opens, passing clientId as argument.
var onConnected;
// Called when a data channel closes, passing clientId as argument.
var onDisconnected;
// Am I the host?
var isHost;
// My ID.
var clientId;
// Send a message to a particular client.
function sendToClient(recipientId, obj) {
  return dataChannels[recipientId].send(JSON.stringify(obj));
}
// Send a message to all clients.
function broadcast(obj) {
  return getClients().map(client => sendToClient(client, obj));
}
// Get a list of all the clients connected.
function getClients() {
  return Object.keys(dataChannels);
}
// Measure latency at 1Hz.
const AUTO_PING = false;
const VERBOSE = true;

/****************************************************************************
 * Initial setup
 ****************************************************************************/

var configuration = {
  'iceServers': [
    {'url': 'stun:stun.l.google.com:19302'},
    {'url':'stun:stun.services.mozilla.com'},
  ]
};

// Create a random room if not already present in the URL.
isHost = window.location.pathname.includes('host');
// TODO: allow room override, maybe based on URL hash?
var room = '';
// Use session storage to maintain connections across refresh but allow
// multiple tabs in the same browser for testing purposes.
// Not to be confused with socket ID.
clientId = sessionStorage.getItem('clientId');
if (!clientId) {
  clientId = Math.random().toString(36).substr(2, 10);
  sessionStorage.setItem('clientId', clientId);
}
maybeLog()('Session clientId ' + clientId);

/****************************************************************************
 * Signaling server
 ****************************************************************************/

// Connect to the signaling server
var socket = io.connect();

socket.on('ipaddr', function(ipaddr) {
  maybeLog()('Server IP address is: ' + ipaddr);
  if (isHost) {
    document.getElementById('ip').innerText = 'Clients connect to ' + ipaddr;
  }
  // updateRoomURL(ipaddr);
});

socket.on('created', function(room, hostClientId) {
  maybeLog()('Created room', room, '- my client ID is', clientId);
  if (!isHost) {
    // Get dangling clients to reconnect if a host stutters.
    peerConns = {};
    dataChannels = {};
    socket.emit('create or join', room, clientId, isHost);
  }
});

socket.on('full', function(room) {
  //alert('Room ' + room + ' is full. We will create a new room for you.');
  //window.location.hash = '';
  //window.location.reload();
  maybeLog()('server thinks room is full');
  // TODO: remove this
});

socket.on('joined', function(room, clientId) {
  maybeLog()(clientId, 'joined', room);
  createPeerConnection(isHost, configuration, clientId);
});

socket.on('log', function(array) {
  console.log.apply(console, array);
});

socket.on('disconnected', clientId => {
  if (onDisconnected) {
    onDisconnected(clientId);
  }
});

socket.on('message', signalingMessageCallback);

socket.on('nohost', room => console.error('No host for', room));

// Join a room
socket.emit('create or join', room, clientId, isHost);

if (location.hostname.match(/localhost|127\.0\.0/)) {
  socket.emit('ipaddr');
}

/**
 * Send message to signaling server
 */
function sendMessage(message, recipient) {
  var payload = {
    recipient: recipient,
    sender: clientId,
    rtcSessionDescription: message,
  };
  maybeLog()('Client sending message: ', payload);
  socket.emit('message', payload);
}

/**
 * Updates URL on the page so that users can copy&paste it to their peers.
 */
// function updateRoomURL(ipaddr) {
//   var url;
//   if (!ipaddr) {
//     url = location.href;
//   } else {
//     url = location.protocol + '//' + ipaddr + ':2013/#' + room;
//   }
//   roomURL.innerHTML = url;
// }


/****************************************************************************
 * WebRTC peer connection and data channel
 ****************************************************************************/

// Map from clientId to RTCPeerConnection. 
// For clients this will have only the host.
var peerConns = {};
// dataChannel.label is the clientId of the recipient. useful in onmessage.
var dataChannels = {};

function signalingMessageCallback(message) {
  maybeLog()('Client received message:', message);
  var peerConn = peerConns[isHost ? message.sender : clientId];
  // TODO: if got an offer and isHost, ignore?
  if (message.rtcSessionDescription.type === 'offer') {
    maybeLog()('Got offer. Sending answer to peer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(message.rtcSessionDescription), function() {},
                                  logError);
    peerConn.createAnswer(onLocalSessionCreated(message.sender), logError);

  } else if (message.rtcSessionDescription.type === 'answer') {
    maybeLog()('Got answer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(message.rtcSessionDescription), function() {},
                                  logError);

  } else if (message.rtcSessionDescription.type === 'candidate') {
    
    peerConn.addIceCandidate(new RTCIceCandidate({
      candidate: message.rtcSessionDescription.candidate
    }));

  } else if (message === 'bye') {
    // TODO: cleanup RTC connection?
  }
}

// clientId: who to connect to?
// isHost: Am I the initiator?
// config: for RTCPeerConnection, contains STUN/TURN servers.
function createPeerConnection(isHost, config, recipientClientId) {
  maybeLog()('Creating Peer connection. isHost?', isHost, 'recipient', recipientClientId, 'config:',
             config);
  try {
    peerConns[recipientClientId] = new RTCPeerConnection(config);
  } catch(e) {
    alert('This browser is not supported. Please use Android Chrome or iOS native app.');
    throw e;
  }

  // send any ice candidates to the other peer
  peerConns[recipientClientId].onicecandidate = function(event) {
    maybeLog()('icecandidate event:', event);
    if (event.candidate) {
      sendMessage({
        type: 'candidate',
        label: event.candidate.sdpMLineIndex,
        id: event.candidate.sdpMid,
        candidate: event.candidate.candidate
      }, recipientClientId);
    } else {
      maybeLog()('End of candidates.');
    }
  };

  if (isHost) {
    maybeLog()('Creating Data Channel');
    dataChannels[recipientClientId] = peerConns[recipientClientId].createDataChannel(recipientClientId);
    onDataChannelCreated(dataChannels[recipientClientId]);

    maybeLog()('Creating an offer');
    peerConns[recipientClientId].createOffer(onLocalSessionCreated(recipientClientId), logError);
  } else {
    peerConns[recipientClientId].ondatachannel = (event) => {
      maybeLog()('ondatachannel:', event.channel);
      dataChannels[recipientClientId] = event.channel;
      onDataChannelCreated(dataChannels[recipientClientId]);
    };
  }
}

function onLocalSessionCreated(recipientClientId) {
  return (desc) => {
    var peerConn = peerConns[isHost ? recipientClientId : clientId];
    maybeLog()('local session created:', desc);
    peerConn.setLocalDescription(desc, () => {
      maybeLog()('sending local desc:', peerConn.localDescription);
      sendMessage(peerConn.localDescription, recipientClientId);
    }, logError);
  };
}

function onDataChannelCreated(channel) {
  maybeLog()('onDataChannelCreated:', channel);

  channel.onclose = () => {
    if (onDisconnected) {
      onDisconnected(channel.label);
    }
  };
  channel.onopen = () => {
    if (onConnected) {
      onConnected(channel.label);
    }
    if (AUTO_PING) {
      // As long as the channel is open, send a message 1/sec to
      // measure latency and verify everything works
      var cancel = window.setInterval(() => {
        try {
          channel.send(JSON.stringify({
            action: 'echo',
            time: performance.now(),
          }));
        } catch (e) {
          console.error(e);
          
          window.clearInterval(cancel);
        }
      }, 1000);
    } else {
      document.getElementById('latency').innerText = 'Connected';
    }
  };

  channel.onmessage = (event) => {
    // maybeLog()(event);
    var x = JSON.parse(event.data);
    if (x.action === 'echo') {
      x.action = 'lag';
      channel.send(JSON.stringify(x));
    } else if (x.action == 'text') {
      maybeLog()(x.data);
    } else if (x.action == 'lag') {
      var str = 'round trip latency ' + (performance.now() - x.time).toFixed(2) + ' ms';
      // maybeLog()(str);
      document.getElementById('latency').innerText = str;
    } else if (onMessageReceived) {
      x.clientId = channel.label;
      onMessageReceived(x);
    } else {
      maybeLog()('unknown action');
    }
  };
}


/****************************************************************************
 * Aux functions
 ****************************************************************************/


function randomToken() {
  return Math.floor((1 + Math.random()) * 1e16).toString(16).substring(1);
}

function logError(err) {
  console.log(err.toString(), err);
}

function maybeLog() {
  if (VERBOSE) {
    return console.log;
  }
  return function(){};
}