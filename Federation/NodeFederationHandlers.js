/*\
title: $:/plugins/OokTech/Bob/Federation/NodeFederationHandlers.js
type: application/javascript
module-type: startup

These are basic handlers for federation between different Bob servers.
\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

exports.platforms = ["node"];

if($tw.node && $tw.settings.enableFederation === 'yes') {
  $tw.settings.Federation = $tw.settings.Federation || {};
  $tw.Bob.Federation = $tw.Bob.Federation || {};
  $tw.Bob.Federation.messageHandlers = $tw.Bob.Federation.messageHandlers || {};

  /*
    This is asking a remote server for an update about its current status
    including:

    - Server name
    - Available wikis
    - Available chats
    - (TODO) its public key
      - For this one the requesting server would send a random number and the
        reply would be a signed token where the payload is the random number
        and the public key.
  */
  function getAvailableWikis(data) {
    data = data || {};
    function getList(obj, prefix) {
      let output = []
      Object.keys(obj).forEach(function(item) {
        if(typeof obj[item] === 'string') {
          if($tw.ServerSide.existsListed(prefix+item)) {
            if(item == '__path') {
              if(prefix.endsWith('/')) {
                output.push(prefix.slice(0,-1));
              } else {
                output.push(prefix);
              }
            } else {
              output.push(prefix+item);
            }
          }
        } else if(typeof obj[item] === 'object') {
          output = output.concat(getList(obj[item], prefix + item + '/'));
        }
      })
      return output;
    }
    // Get the wiki list of wiki names from the settings object
    const wikiList = getList($tw.settings.wikis, '')
    const viewableWikis = []
    wikiList.forEach(function(wikiName) {
      if($tw.Bob.AccessCheck(wikiName, {"decoded": data.decoded}, 'view')) {
        viewableWikis.push(wikiName);
      }
    })
    return wikiList || {};
  }
  function getAvailableChats() {
    return [];
  }

  /*
    Ask a remote server for updated information about the server.
  */
  $tw.Bob.Federation.messageHandlers.requestServerInfo = function(data) {
    // Reply with the server info listed above
    const reply = {
      type: 'sendServerInfo',
      info: {
        name: $tw.settings.Federation.serverName || 'Sever Name',
        canLogin: $tw.settings.Federation.canLogin || 'no',
        availableWikis: $tw.ServerSide.getViewableWikiList(data),
        availableChats: getAvailableChats(data),
        port: $tw.settings['ws-server'].port,
        publicKey: 'c minor',
        staticUrl: 'no'
      },
      nonce: data.rnonce
    };
    $tw.Bob.Federation.sendToRemoteServer(reply, data._source_info.url);
  }

  function addServerInfo(data) {
    data = data || {};
    data.info = (data.message)?(data.message.info || data.info):data.info;
    if (data.info && data._source_info) {
      $tw.Bob.Federation.remoteConnections[data._source_info.url].name = data.info.name;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].canLogin = data.info.canLogin;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].availableWikis = data.info.availableWikis;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].availableChats = data.info.availableChats;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].port = data.info.port;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].publicKey = data.info.publicKey;
      $tw.Bob.Federation.remoteConnections[data._source_info.url].staticUrl = data.info.staticUrl;
    }
    $tw.Bob.Federation.updateConnections();
  }

  /*
    Add or update local information about a remote server when it is received
  */
  $tw.Bob.Federation.messageHandlers.sendServerInfo = function(data) {
    addServerInfo(data)
  }

  /*
    This requests tiddler hashes from a server in preparation for syncing

    data {
      filter: <some filter>,
      fromWiki: wiki name
    }
  */
  $tw.Bob.Federation.messageHandlers.requestHashes = function(data) {
    console.log('requestHashes')
    if (data.filter && data.fromWiki) {
      // get list of tiddlers
      const titleList = $tw.Bob.Wikis[data.fromWiki].wiki.filterTiddlers(data.filter);
      // get tiddler hashes
      const outputHashes = {};
      titleList.forEach(function(thisTitle) {
        outputHashes[thisTitle] = $tw.Bob.Shared.getTiddlerHash($tw.Bob.Wikis[data.fromWiki].wiki.getTiddler(thisTitle));
      })
      // send them back
      const message = {
        type: 'sendHashes',
        hashes: outputHashes,
        nonce: data.rnonce
      }
      $tw.Bob.Federation.sendToRemoteServer(message, data._source_info.url);
    }
  }

  /*
    This takes hashes of tiddlers from the remote wiki and compares them to the
    local wiki and requests any that are missing.
  */
  $tw.Bob.Federation.messageHandlers.sendHashes = function(data) {
    console.log('sendHashes')
    if (data.hashes && data.wiki) {
      const tiddlersToRequest = [];
      Object.keys(data.hashes).forEach(function(tidTitle) {
        // check if the tiddler exists locally
        const thisTid = $tw.Bob.Wikis[data.wiki].wiki.getTiddler(tidTitle);
        if (thisTid) {
          // If the tiddler exists than check if the hashes match
          if (data.hashes[tidTitle] !== $tw.Bob.Shared.getTiddlerHash(thisTid)) {
            // If the hashes don't match add it to the list
            tiddlersToRequest.push(tidTitle);
          }
        } else {
          // If the tiddler doesn't exist than add it to the list
          tiddlersToRequest.push(tidTitle);
        }
      })
      if (tiddlersToRequest.length > 0) {
        // If there are any tiddlers to request than send the request
        const message = {
          type: 'requestTiddlers',
          filter: tiddlersToRequest.map(function(title){return "[["+title+"]]"}).join(''),
          wikiName: data.wiki
        }
        $tw.Bob.Federation.sendToRemoteServer(message, data._source_info.url);
      }
    }
  }

  /*
    This message is used to send the actual tiddler payload between servers.

    data {
      tiddlers: {
        title1: tidObject 1,
        title2: tidObject 2,
        ...
      }
    }
  */
  $tw.Bob.Federation.messageHandlers.sendTiddlers = function(data) {
    console.log('sendTiddlers')
    console.log(data)
    if (typeof data.tiddlers === 'object') {
      Object.values(data.tiddlers).forEach(function(tidFields) {
        //$tw.Bob.Wikis[thisWiki].wiki.addTiddler(new $tw.Tiddler(tidFields))
        // Send each tiddler recieved to the browser using the conflict message
        // and then let the browser handle it.
        $tw.SendToBrowsers({type: 'conflict', tiddler:{fields:tidFields}, wiki: data.wiki})
      })
    }
  }

  /*
    This requets specific tiddlers from a remote wiki using a filter.

    TODO figure out if the response to this should be split up into one message
    per tiddler instead of all of the tiddlers in one message.

    data:
    {
      wikiName: the name of the wiki to pull from,
      filter: requestFilter
    }
  */
  $tw.Bob.Federation.messageHandlers.requestTiddlers = function(data) {
    console.log('requestTiddlers')
    console.log(data)
    data.wikiName = data.wikiName || 'RootWiki';
    data.filter = data.filter || '[!is[system]is[system]]';
    //data.conflictType = data.conflictType || 'newestWins';

    $tw.Bob.Federation.remoteConnections[data._source_info.url] = $tw.Bob.Federation.remoteConnections[data._source_info.url] || {};

    $tw.Bob.Federation.remoteConnections[data._source_info.url].socket = $tw.Bob.Federation.remoteConnections[data._source_info.url].socket || {};
    //$tw.Bob.Federation.remoteConnections[data._source_info.url].conflictType = data.conflictType || 'manual';

    if(data._source_info && data.rnonce) {
      console.log(1)
      // Get the tiddlers
      const tiddlerTitles = $tw.Bob.Wikis[data.wikiName].wiki.filterTiddlers(data.filter);
      const tidObj = {};
      tiddlerTitles.forEach(function(tidTitle) {
        const tempTid = $tw.Bob.Wikis[data.wikiName].wiki.getTiddler(tidTitle)
        if (tempTid) {
          tidObj[tidTitle] = tempTid.fields;
        }
      })
      const message = {
        type: 'sendTiddlers',
        tiddlers: tidObj,
        nonce: data.rnonce
      }
      if ($tw.Bob.Federation.remoteConnections[data._source_info.url]) {
        console.log(2)
        if ($tw.Bob.Federation.remoteConnections[data._source_info.url].socket) {
          console.log(3)
          if ($tw.Bob.Federation.remoteConnections[data._source_info.url].socket.readyState === 1) {
            console.log(4)
            // Send the message
            $tw.Bob.Federation.sendToRemoteServer(message, data._source_info.url);
          }
        }
      }
    }
  }

  /*
    This message asks a remote server to sync with the local server

    data {
      wikis: {
        wikiName1: filter1,
        wikiName2: filter2
      }
    }

    When receiving this message the receiving server will, if the
    authentication and everything is correct, request tiddlers from the sending
    server using the provided wikis and filters.
  */
  $tw.Bob.Federation.messageHandlers.requestRemoteSync = function(data) {
    // By this point the authentication has been done, so check to make sure
    // that the wikis are listed for syncing.
    Object.keys(data.wikis).forEach(function(wikiName) {
      const serverName = $tw.Bob.Federation.remoteConnections[data._source_info.url].name;
      // Get the tiddler name that has the information for the wiki
      const wikiInfoTid = $tw.Bob.Wikis[wikiName].wiki.getTiddler('$:/Federation/RemoteServer/' + serverName + '/wikis/' + wikiName);
      if (wikiInfoTid) {
        // make sure that the wiki is set up to be synced
        if (['pull','bidirectional'].indexOf(wikiInfoTid.fields.synctype)) {
          // Make the request for the tiddlers
          const message = {
            type: 'requestTiddlers',
            wikiName: wikiName,
            filter: data.wikis.wikiName
          }
          $tw.Bob.Federation.sendToRemoteServer(message, data._source_info.url);
        }
      }
    })
  }

  /*
    Sync servers takes a filter and syncs all of the tiddlers returned by the
    filter with a remote server.
    It should use the same process as the syncChanges message, possibly they
    should be combined.

    The data object has:
    {
      type: 'syncServer',
      wiki: wikiName,
      token: token,
      id: messageID,
      source_connection: connectionIndex,
      remoteUrl: remoteUrl,
      remoteWikis: [remoteWikiNames],
      syncFilter: syncFilter,
      syncType: syncType,
      conflictType: conflictType,
      remoteToken: remoteToken
    }

    this takes the tiddlers returned by the syncFilter in the wiki named in
    wikiName and syncs them with the server at remoteUrl using syncType, any
    conflicts are handled using conflictType. If the remote server requires an
    access token it has to be suppiled in remoteToken. If the remote wiki
    doesn't have the same name as the local wiki than it needs to be given as
    remoteWiki.

    remoteWikis is a list of wikki names to sync.

    syncType can be:
      - pushOnly: local tiddlers are pushed to the remote server but no changes
      are pulled from the remote server.
      - pullOnly: changes on the remote server are fetched but no local
      tiddlers are sent.
      - bidirectional: local changes are sent and remote changes are pulled

    conflictType can be:
      - localWins: if there are conflicts the local tiddlers are kept even if
      remote tiddlers have been changed, tiddlers that didn't exist previously
      are synced.
      - remoteWins: in the case of conflicts, remote tiddlers overwrite local
      tiddlers, only tiddlers that don't exist on the remote server are sent,
      if applicable.
      - (LATER) manual: every conflict is listed on the server that started the
      sync and a human has to manually resolve it. This reqires a message and
      interface for resolving conflicts.
      - (LATER) newestWins: in case of conflicts, the tiddlers with the most
      recent
      changes are kept regardless of which server it is from.
      - (LATER) oldestWins: least recently modified tiddlers are kept in case of
      conflicts.
  */
  $tw.Bob.Federation.messageHandlers.syncServer = function(data) {
    // We need at least the remote url or we can't act.
    if(data.remoteUrl) {
      // Try to connect to the remote server
      $tw.Bob.Federation.remoteConnections[data.remoteUrl] = $tw.Bob.Federation.remoteConnections[data.remoteUrl] || {}

      data.syncFilter = data.syncFilter || '[!is[system]]'
      data.syncType = data.syncType || 'bidirectional'
      data.conflictType = data.conflictType || 'newestWins'
      // Default to only syncing the current wiki
      data.remoteWikis = data.remoteWikis || data.wiki || 'RootWiki'

      $tw.Bob.Federation.remoteConnections[data.remoteUrl].socket = $tw.Bob.Federation.remoteConnections[data.remoteUrl].socket || {}
      $tw.Bob.Federation.remoteConnections[data.remoteUrl].pendingAction = 'sync'
      $tw.Bob.Federation.remoteConnections[data.remoteUrl].syncFilter = data.syncFilter
      $tw.Bob.Federation.remoteConnections[data.remoteUrl].syncType = data.syncType
      $tw.Bob.Federation.remoteConnections[data.remoteUrl].conflictType = data.conflictType
      $tw.Bob.Federation.remoteConnections[data.remoteUrl].remoteWikis = data.remoteWikis

      if($tw.Bob.Federation.remoteConnections[data.remoteUrl].socket.readyState !== 1) {
        // Get the url for the remote websocket
        const URL = require('url');
        const remoteUrl = new URL(data.remoteUrl);
        const WebSocket = require('$:/plugins/OokTech/Bob/External/WS/ws.js');
        const websocketProtocol = (remoteUrl.protocol.startsWith('https'))?'wss://':'ws://';
        // connect web socket
        const socket = new WebSocket(websocketProtocol + remoteUrl.host + remoteUrl.pathname);
        // Save the socket for future use
        $tw.Bob.Federation.remoteConnections[data.remoteUrl].socket = socket;
        socket.on('open', function() {
          startRemoteSync($tw.Bob.Federation.remoteConnections[data.remoteUrl]);
        })
        $tw.Bob.Federation.remoteConnections[data.remoteUrl].socket.on('message', function (message) {
          const messageData = JSON.parse(message);
          handleRemoteReply($tw.Bob.Federation.remoteConnections[data.remoteUrl], messageData);
        })
      } else {
        startRemoteSync($tw.Bob.Federation.remoteConnections[data.remoteUrl], data)
      }
    }
  }
  function startRemoteSync(remoteServerObject, data) {
    // Get a list of tiddlers from the local wiki that should be synced if
    // syncType is bidirectional or pushOnly
    let pushList = []
    if(['bidirectional','pushOnly'].indexOf(data.syncType) !== -1) {
      pushList = $tw.Bob.Wikis[data.wiki].filterTiddlers(data.syncFilter)
    }
    let tiddlerHashes = {}
    pushList.forEach(function(tidName) {
      tiddlerHashes[tidName] = $tw.Bob.Shared.getTiddlerHash(tidName)
    })
    // send a sync message with the filter and accompanying tiddler hashes.
    let message = {
      type: 'syncRequest',
      syncType: data.syncType,
      syncFilter: data.syncFilter,
      conflictType: data.conflictType
    }
    remoteServerObject.send(JSON.stringify(message))
  }
  function handleRemoteReply(remoteServerObject, data) {
    if($tw.Bob.Federation.remoteConnections[data.remoteUrl].pendingAction == 'none') {
      return
    }
    // This receives the tiddlers that the remote server has and teh local
    // server doesn't
    // So save the received tiddlers
    remoteServerObject.remoteWikis.forEach(function(wikiName) {
      if(data[wikiName]) {
        Object.keys(data[wikiName]).forEach(function(tidName) {
          $tw.Bob.Wikis[wikiName].wiki.addTiddler(data[wikiName][tidName])
        })
      }
    })
  }
  function syncRequest(remoteServerObject, data) {
    let reply = {
      type:'remoteReply'
    }
    // The local server has already sent a list of hashes for local
    // tiddlers that match the sync filter. The remote replies with:
    //   A list of any tiddlers that the remote server is missing
    //   Any tiddlers that aren't listed in the sent hashes, because the
    //    local server doesn't have them.
    //   A list of remote tiddlers with conflicts If the sync is bi-directional
    //    or pullOnly
    if(data.missing) {
      // data.missing is in the form {wikiName: [tiddlerNames]}
      // These are the tiddlers that the remote server is missing
      // Gathere these tiddlers and send them back to the remote server
      // Make a list of all wikis the local server wants to sync, the remote
      // server could send much more than the local one wants and we want to
      // prevent malicious behaviour.
      remoteServerObject.remoteWikis.forEach(function(wikiName) {
        if(data.missing[wikiName]) {
          reply[wikiName] = {}
          // If the remote is missing tiddlers from a wiki retreive them and put them into an object.
          data.missing[wikiName].forEach(function(tidName) {
            // TODO Add some check to make sure that the remote is allowed to
            // get this tiddler.
            reply[wikiName][tidName] = $tw.Bob.Wikis[wikiName].wiki.getTiddler(tidName)
          })
        }
      })
    }
    if(data.tiddlers) {
      // data.tiddlers is in the form {wikiName1:[tiddlers],wikiName2:[tiddlers]}
      // These are tiddlers the local server is missing, add them to the local
      // wiki.
      remoteServerObject.remoteWikis.forEach(function(wikiName) {
        if(data.tiddlers[wikiName]) {
          data.tiddlers[wikiName].forEach(function(tidName) {
            // TODO add some check to make sure that we can have some way to
            // filter which tiddlers are actually saved.
            $tw.Bob.Wikis[wikiName].wiki.addTiddler(data.tiddlers[wikiName][tidName])
          })
        }
      })
      // Send reply
      // TODO figure this out
    }
    // Bi-directional sync with oldest or newest wins is gonig to require more
    // work
    if(data.conflicts) {
      // data.conflicts is in the form {wikiName1:[tiddlers],wikiName2:[tiddlers]}
      // These are tiddlers that have been changed on both servers
      // This may mean that it has to have a persistent record of changes.

      // TODO this bit
    }
  }

}
})();
